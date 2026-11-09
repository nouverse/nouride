/**
 * Token estimation — §6.4 SPEC.
 *
 * Character-based, deliberately. A real tokenizer means a per-provider dependency
 * (tiktoken is a WASM blob) to compute a number we only use to decide when to trim
 * history. Being 15% off makes the sliding window trim slightly early; being wrong
 * about *which* messages to keep would be a real bug, and that part is exact.
 *
 * Biased high on prose, so we trim early rather than send a request the provider rejects — and low
 * on dense text: a pasted log of timestamps and ids counted 2.3x this estimate on the box. How far off
 * it is depends on the text and on the provider's tokenizer, and neither is known here, so the
 * correction is the engine's: it scales the estimate per conversation by what the provider reported
 * (`modules/llm/context-scale.ts`).
 *
 * Cheap enough to run every round, because it does. The context guard, truncation and compaction each
 * measure the whole conversation, several times a turn, and a regex test per character made that
 * millions of calls on a 160k-token context. So a character is a comparison or two, and a message
 * is measured once and remembered.
 */

import type { ChatMessage, SystemBlock, TokenUsage, ToolDefinition } from "@nouride/shared";
import { flattenSystem } from "./system.ts";

/** ~4 chars per token for Latin scripts. */
const CHARS_PER_TOKEN = 4;
/** CJK packs far more meaning per character: ~1.5 chars per token. */
const CJK_CHARS_PER_TOKEN = 1.5;

/** Per-message overhead for role markers and separators, matching OpenAI's guidance. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Whether a UTF-16 code unit is in a CJK block: symbols and kana, extension A, the unified ideographs,
 * Hangul syllables, the compatibility ideographs.
 *
 * Every block is inside the Basic Multilingual Plane, so testing code units counts exactly what testing
 * code points did — no surrogate falls in any of them. Written as numbers rather than characters: the
 * regex this replaces spelled its ranges with the characters themselves, and U+F900 is one that any NFC
 * pass — an editor, a paste — silently turns into U+8C48, which widens the class to everything from
 * U+4E00 to U+FAFF.
 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjkChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // Nothing below U+3000 is CJK, so Latin text never reaches the ranges.
    if (code >= 0x3000 && isCjk(code)) cjkChars += 1;
  }
  const otherChars = text.length - cjkChars;

  return Math.ceil(cjkChars / CJK_CHARS_PER_TOKEN + otherChars / CHARS_PER_TOKEN);
}

/**
 * What one image costs, before the provider has told us.
 *
 * A real answer depends on the picture: OpenAI tiles by dimensions, Anthropic bills by area,
 * Gemini by both. All three land between roughly 250 and 1,600 for the sizes that arrive from a
 * phone. A thousand is the middle of that, and being wrong by a factor of two here is a window
 * trimmed slightly early or slightly late — while treating an image as zero is a window that
 * overflows and a turn that dies, which is the failure this number exists to prevent.
 */
const IMAGE_TOKENS = 1000;

/**
 * Audio is billed by length, not by size, so it is estimated from seconds.
 *
 * Thirty-two a second is what Gemini documents for its audio input, and the one provider that gets
 * audio here most is Gemini through Nougate. An estimate like `IMAGE_TOKENS`, and wrong the same safe
 * way: a minute-long voice note counted as a thousand tokens would be a window that overflows.
 */
const AUDIO_TOKENS_PER_SECOND = 32;
/**
 * Bytes a second of voice takes, for an audio part that no longer carries its duration.
 *
 * 4000 is 32 kbps — a Telegram or WhatsApp voice note, and the bitrate the engine transcodes to. A
 * higher-bitrate music file is over-counted by this, which is the direction to be wrong in.
 */
const AUDIO_BYTES_PER_SECOND = 4000;
/** A clip with no duration and no bytes to measure is costed as a minute. */
const UNKNOWN_AUDIO_SECONDS = 60;

function estimatePartTokens(part: Exclude<ChatMessage["content"], string>[number]): number {
  switch (part.type) {
    case "text":
      return estimateTokens(part.text);
    // `image_ref` costs what the image it resolves to will cost: a ref is what is in the
    // database, and an image is what the provider is sent, so counting it as text would
    // under-report every window that holds one.
    case "image":
    case "image_ref":
      return IMAGE_TOKENS;
    case "audio_ref":
      return Math.ceil((part.durationSec ?? UNKNOWN_AUDIO_SECONDS) * AUDIO_TOKENS_PER_SECOND);
    case "audio":
      return Math.ceil(((part.data.length * 3) / 4 / AUDIO_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND);
  }
}

function estimateContentTokens(content: ChatMessage["content"]): number {
  if (typeof content === "string") return estimateTokens(content);

  let total = 0;
  for (const part of content) total += estimatePartTokens(part);
  return total;
}

/**
 * What each message was measured at, for as long as it holds what was measured.
 *
 * A message is estimated many times a turn — by the window, the guard before every round, compaction,
 * the count the session keeps — and almost never changes in between. Keyed by the message, so nothing
 * is held once the conversation lets go of it. Checked against its `content` and `toolCalls`, because
 * the executor does give a message new content in place (the owed-report note, a wrap-up's answer), and
 * a remembered number must not outlive what it measured: replacing either one re-measures. Editing a
 * parts array or a call's arguments in place would not be seen, and nothing does — a message changes by
 * being given new content.
 */
const measured = new WeakMap<
  ChatMessage,
  { content: ChatMessage["content"]; toolCalls: ChatMessage["toolCalls"]; tokens: number }
>();

export function estimateMessageTokens(message: ChatMessage): number {
  const known = measured.get(message);
  if (known && known.content === message.content && known.toolCalls === message.toolCalls) return known.tokens;

  let tokens = estimateContentTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  for (const call of message.toolCalls ?? []) {
    // Arguments are re-serialized rather than measured from the original string: the
    // provider sees JSON, so JSON is what we should be counting.
    tokens += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments));
  }
  measured.set(message, { content: message.content, toolCalls: message.toolCalls, tokens });
  return tokens;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

/**
 * Tool schemas are part of the request and can be substantial — a dozen tools with
 * rich JSON Schema runs into the thousands of tokens. Leaving them out of the budget
 * is how a context window overflows despite a correct-looking calculation.
 */
export function estimateToolsTokens(tools: ToolDefinition[]): number {
  return tools.reduce(
    (sum, tool) =>
      sum +
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.parameters)),
    0,
  );
}

/**
 * Context window sizes, for deciding the budget. Unknown models get a conservative
 * default rather than an optimistic one: guessing high means requests that fail at
 * the provider, guessing low means a slightly shorter history.
 *
 * "A slightly shorter history" undersold the cost, and a live incident showed what it actually
 * buys. Three agents ran on `antigravity:gemini-3.x-*`, which matched nothing here, so each was
 * budgeted at the 32k default against a real million-token window. The conversation budget came out
 * near 6k after the system prompt and tool schemas, `trimToolResults` then fired on *every* tool
 * iteration, and the agent lost the output of the call it was mid-way through using. It read a file,
 * forgot it, read it again — 22 to 25 iterations and 700k tokens per turn, ending in a reply with no
 * text in it. The budget being wrong by a factor of thirty does not shorten a conversation, it stops
 * the agent from finishing a thought.
 *
 * So: keep the default conservative, but keep this list current, and make a miss *loud* rather than
 * silent — see `contextWindowInfo`, which reports whether the number is known or guessed.
 *
 * Ordered, and `find` takes the first match: the narrower pattern has to come first. `^gpt-4\.1`
 * before `^gpt-4`, or a million-token window is read as eight thousand.
 */
const CONTEXT_WINDOWS: { pattern: RegExp; tokens: number }[] = [
  { pattern: /^claude-(opus|sonnet|haiku)-[45]/, tokens: 200_000 },
  { pattern: /^claude-3/, tokens: 200_000 },
  // Every Gemini from 1.5 on is a million or more (1.5 Pro is two). One is the conservative read.
  { pattern: /^gemini-([1-9]\d*)/, tokens: 1_000_000 },
  { pattern: /^gpt-5/, tokens: 400_000 },
  { pattern: /^gpt-4\.1/, tokens: 1_000_000 },
  { pattern: /^gpt-4o/, tokens: 128_000 },
  { pattern: /^gpt-4-turbo/, tokens: 128_000 },
  { pattern: /^gpt-4/, tokens: 8_192 },
  { pattern: /^gpt-3\.5/, tokens: 16_385 },
  { pattern: /^o[13]/, tokens: 200_000 },

  /**
   * Long-context families a proxy commonly serves, at the **conservative floor they share**.
   *
   * Not the published maximum for any of them, and deliberately so — the rule here is not to invent a
   * number, and several of these families ship variants with different windows under one name (a
   * "turbo" at twice the base, a distilled build at half). 128k is the figure every current member of
   * each family meets or exceeds, so it is wrong only in the direction that costs usable window rather
   * than the direction that overflows a request.
   *
   * The point of the entries is not precision. It is that a model served through Nougate used to fall
   * to the 32k default, and the difference between 32k and 128k is the difference between an agent that
   * loses the file it is reading and one that finishes the job. An operator who knows the real number
   * sets `context_window` in the agent's `[llm]` block and this list stops mattering for them.
   */
  { pattern: /^glm-[45]/, tokens: 128_000 },
  { pattern: /^kimi-/, tokens: 128_000 },
  { pattern: /^deepseek/, tokens: 128_000 },
  { pattern: /^grok-[34]/, tokens: 128_000 },
  { pattern: /^qwen[23]/, tokens: 128_000 },
  { pattern: /^llama-?[34]/, tokens: 128_000 },
  { pattern: /^gpt-oss/, tokens: 128_000 },
  { pattern: /^mistral-(large|medium)/, tokens: 128_000 },
  { pattern: /^magistral/, tokens: 128_000 },
];

const DEFAULT_CONTEXT_WINDOW = 32_000;

/**
 * Strip a routing prefix from a model id.
 *
 * A proxy in front of the provider renames models: Nougate serves
 * `antigravity:claude-sonnet-4-6`, OpenRouter serves `anthropic/claude-3.5-sonnet`. Left
 * as-is, every one of those falls through to the conservative default — so an agent on a
 * 200k model would quietly be limited to 32k, and its history trimmed six times harder
 * than necessary.
 */
export function normalizeModelId(model: string): string {
  const lastSeparator = Math.max(model.lastIndexOf(":"), model.lastIndexOf("/"));
  return lastSeparator === -1 ? model : model.slice(lastSeparator + 1);
}

/**
 * The window, and whether it was actually looked up or fallen back to.
 *
 * `known: false` is the state that cost a whole evening of a real deployment, and the only way it can
 * be noticed is if something says so out loud. Reported rather than logged here so the caller decides
 * how noisy to be — this module is a pure estimator and has no logger.
 */
export function contextWindowInfo(model: string): { tokens: number; known: boolean } {
  const normalized = normalizeModelId(model);
  const match = CONTEXT_WINDOWS.find((entry) => entry.pattern.test(normalized));
  return match
    ? { tokens: match.tokens, known: true }
    : { tokens: DEFAULT_CONTEXT_WINDOW, known: false };
}

/**
 * How much context a model should carry before it compacts — the whole request, prompt and tools
 * included — when neither the agent nor the operator has said.
 *
 * A different question from the window. The window is what a model *can* read; this is what it is worth
 * re-sending on every iteration of a tool loop. Measured, not guessed, where there is a number: Gemini
 * Flash through Nougate ran at ~75% cache hits on the box (2026-10-08), so carrying more of it costs a
 * quarter of what the token count says and stays fast. Everything else gets the general figure, which is
 * about what the old history-only ceiling (120k + a ~50k prompt) amounted to.
 *
 * A model whose window is smaller than this is unaffected: `compact_at_ratio` of its budget is the lower
 * number, and the lower one wins.
 */
const COMPACTION_LIMITS: { pattern: RegExp; tokens: number; rule: string }[] = [
  { pattern: /^gemini-([3-9]|\d{2,})[\w.]*-flash/, tokens: 200_000, rule: "gemini-flash" },
];

const DEFAULT_COMPACTION_LIMIT = 160_000;

export function compactionLimitInfo(model: string): { tokens: number; rule: string } {
  const normalized = normalizeModelId(model);
  const match = COMPACTION_LIMITS.find((entry) => entry.pattern.test(normalized));
  return match ? { tokens: match.tokens, rule: match.rule } : { tokens: DEFAULT_COMPACTION_LIMIT, rule: "default" };
}

/**
 * Fill in usage a provider did not report.
 *
 * A proxy is free to drop the `usage` field, and Nougate does on its OpenAI-compatible
 * path. Trusting that silence means recording zero tokens, which means the daily cost cap
 * in §10.2 never trips — a spend limit that fails open. An estimate flagged as an estimate
 * is worth far more here than an exact zero.
 *
 * What the model produced is its text *and* its tool calls. Most turns of an agent loop answer with
 * calls alone, and estimating from the text only counted those as zero output, flagged as measured.
 */
export function fillMissingUsage(
  // Typed as the whole shape rather than the two counts it reads, so the cache fields a provider did
  // report survive the spreads below instead of being dropped on the way through. Both returns spread:
  // an input count we had to estimate does not make a reported cache hit any less true.
  reported: TokenUsage,
  request: {
    messages: ChatMessage[];
    system?: string | SystemBlock[];
    tools?: ToolDefinition[];
    tail?: string;
  },
  responseText: string,
  /** As the wire carried them: a name and the arguments' JSON. */
  toolCalls: readonly { name: string; arguments: string }[] = [],
): TokenUsage & { estimated: boolean } {
  const inputMissing = reported.inputTokens <= 0;
  const outputMissing = reported.outputTokens <= 0 && (responseText.length > 0 || toolCalls.length > 0);

  if (!inputMissing && !outputMissing) return { ...reported, estimated: false };

  return {
    ...reported,
    inputTokens: inputMissing
      ? estimateMessagesTokens(request.messages) +
        estimateTokens(flattenSystem(request.system)) +
        estimateTokens(request.tail ?? "") +
        estimateToolsTokens(request.tools ?? [])
      : reported.inputTokens,
    outputTokens: outputMissing
      ? estimateTokens(responseText) + toolCalls.reduce((sum, call) => sum + estimateTokens(call.name) + estimateTokens(call.arguments), 0)
      : reported.outputTokens,
    estimated: true,
  };
}
