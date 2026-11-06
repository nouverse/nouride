/**
 * `/status` for an agent a coding CLI answers (0.8.8).
 *
 * On Telegram, `/status` to an agent Claude Code answers said `Model: claude-sonnet-5-5`, `Provider: nougate-anthropic`,
 * `Messages: 101 in context` and `Tokens: 0 in / 0 out`, after hours of work on the CLI's own model. Every line was
 * the daemon's view of an agent it was not running: the pack's `[llm]`, which answers only a turn the CLI cannot; the
 * daemon's transcript, where the CLI keeps and compacts a context of its own; and a usage store no CLI turn reached.
 * These lines say what answers, the context the CLI says it holds, and the tokens it reported.
 */

import type { CliAnswering } from "@/modules/pipeline/brain.ts";
import { formatTokens } from "./format.ts";

/** What `/status` reads of the conversation's recorded usage (`UsageStore.forSession`). */
interface Spent {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
}

export function cliStatusLines(cli: CliAnswering, own: { model: string; provider: string }, transcript: number, spent: Spent | undefined): string[] {
  const name = cli.cli;
  const model = cli.model
    ? `${cli.model.name} (${cli.model.by === "pack" ? "set in the pack" : `${name}'s own, as its last session opened`})`
    : `${name} chooses it`;
  const context = cli.context
    ? `${formatTokens(cli.context.used)} of ${formatTokens(cli.context.size)} tokens at its last report`
    : "not reported in this conversation since the daemon started";
  const reported = spent && spent.inputTokens + spent.outputTokens > 0;
  const cached = !spent || spent.cachedInputTokens === null ? " (cache not reported)" : spent.cachedInputTokens > 0 ? ` (${formatTokens(spent.cachedInputTokens)} cached)` : "";
  return [
    `Answered by: ${name}${cli.running ? ` (${cli.running})` : ", not running now; it starts at the next message"}`,
    `Model: ${model}`,
    `Context: kept by ${name} itself, ${context}`,
    `Transcript: ${transcript} messages, the daemon's record of this chat`,
    reported
      ? `Tokens: ${formatTokens(spent.inputTokens)} in${cached} / ${formatTokens(spent.outputTokens)} out, as ${name} reported them, on its own account, outside the daily caps`
      : `Tokens: none reported by ${name} in this conversation yet`,
    `Fallback: ${own.model} on ${own.provider}, only for a turn ${name} cannot answer`,
  ];
}
