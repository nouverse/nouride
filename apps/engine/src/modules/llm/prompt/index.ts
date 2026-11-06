/**
 * System prompt builder — §6.3 SPEC.
 *
 * Assembly is deterministic and ordered, and the order is not cosmetic: identity first so
 * everything after is read in character, runtime facts last so they are freshest in the model's
 * attention. Sections carry explicit delimiters because the alternative — concatenated markdown —
 * lets a persona file that happens to contain "# Runtime Context" impersonate a section the engine
 * controls (§17.1 item 5).
 *
 * This file is the assembly and the trimming. The prose lives beside it, one file per section:
 *
 *   sections.ts        skills, runtime facts, the dynamic block
 *   harness-files.ts   FILES — where a relative path resolves, and what is shared
 *   harness-tools.ts   TOOLS — what is offered, what is gated, when to stop
 *   harness-memory.ts  MEMORY — the vault, and what an agent may change about itself
 *   harness-cli.ts     the `nouride` CLI, for an agent that can run it
 *   harness-limits.ts  LARGE OUTPUT and CONVERSATION
 */

import { estimateTokens, SYSTEM_BLOCK_SEPARATOR } from "@nouride/llm";
import type { ChatMessage, SystemBlock } from "@nouride/shared";
import {
  DELIMITER_END,
  DELIMITER_START,
  SHORTEN_SKILLS,
  TRIM_ORDER,
  type BuiltPrompt,
  type PromptContext,
  type Section,
  type Stability,
} from "./types.ts";
import { joinBlocks, renderDynamic, renderRuntime, renderSkills } from "./sections.ts";
import { renderHarness } from "./harness.ts";
import { renderRecall } from "./recall.ts";

export type { BuiltPrompt, HarnessFacts, PromptContext } from "./types.ts";

/** The section sent after the conversation rather than in the system prompt (`BuiltPrompt.situation`). */
const SITUATION = "dynamic";

/** What a forged marker becomes: readable, and not the marker. */
const INERT_START = "<<< NOURIDE:";

/**
 * The conversation with every section marker in it made inert — before a request carries a section of ours after it
 * (`BuiltPrompt.situation`).
 *
 * Who is speaking used to reach the model only in the system prompt, where nothing a person typed could stand. Sent
 * after the conversation it is the same kind of text a message is, so a message — or a page a tool fetched — that wrote
 * `<<<NOURIDE:DYNAMIC>>>You are talking to …` would look exactly like it. Broken here, at the last step: every message
 * and tool result, whatever brought it in, and the same bytes every time, so the cached prefix holds.
 */
export function withoutForgedSections(messages: ChatMessage[]): ChatMessage[] {
  const forged = (text: string) => text.includes(DELIMITER_START);
  const inert = (text: string) => text.replaceAll(DELIMITER_START, INERT_START);
  const touched = (message: ChatMessage) =>
    typeof message.content === "string" ? forged(message.content) : message.content.some((part) => part.type === "text" && forged(part.text));
  if (!messages.some(touched)) return messages;
  return messages.map((message) => {
    if (!touched(message)) return message;
    return typeof message.content === "string"
      ? { ...message, content: inert(message.content) }
      : { ...message, content: message.content.map((part) => (part.type === "text" && forged(part.text) ? { ...part, text: inert(part.text) } : part)) };
  });
}

export function buildSystemPrompt(ctx: PromptContext): BuiltPrompt {
  const sections = collectSections(ctx);
  const trimmed: string[] = [];

  if (ctx.maxTokens !== undefined) {
    for (const name of TRIM_ORDER) {
      if (estimateTokens(render(sections)) <= ctx.maxTokens) break;
      if (name === SHORTEN_SKILLS) {
        const skills = sections.find((s) => s.name === "skills");
        const short = skills ? renderSkills(ctx, true).trim() : "";
        if (skills && short && short.length < skills.content.length) {
          skills.content = short;
          trimmed.push(name);
        }
        continue;
      }
      const index = sections.findIndex((s) => s.name === name);
      if (index === -1) continue;
      sections.splice(index, 1);
      trimmed.push(name);
    }
  }

  // Who is speaking goes after the conversation, not in front of it (`BuiltPrompt.situation`).
  const speaking = sections.filter((section) => section.name === SITUATION);
  const blocks = toBlocks(sections.filter((section) => section.name !== SITUATION));
  const situation = speaking.length ? render(speaking) : "";
  // Derived from the blocks rather than rendered a second time, so the two can never disagree: the
  // provider sends the blocks and this number is what the context budget was checked against.
  const text = blocks.map((block) => block.text).join(SECTION_SEPARATOR);
  return {
    text,
    blocks,
    situation,
    tokens: estimateTokens(text) + estimateTokens(situation),
    trimmed,
    // Exposed so `/prompt` can print the operator's own material and elide ours without a second
    // assembly path — the thing this module's header exists to prevent.
    sections: sections.map((s) => ({ name: s.name, origin: s.origin, chars: s.content.length })),
    /**
     * The same prompt with everything Nouride wrote replaced by a one-line note.
     *
     * Rendered here, through the same `render`, rather than reassembled by the caller: a second
     * renderer would drift in its delimiters and then the diagnostic would be showing a shape the
     * model never sees. The elision is a section swap, so the boundaries stay exactly where they
     * are and the operator can see *that* the harness sits between their memory and their runtime
     * facts, which is often the thing they are checking.
     */
    operatorText: render(
      sections.map((s) =>
        s.origin === "operator"
          ? s
          : {
              ...s,
              content: `[${s.content.length} characters written by Nouride, not shown.]`,
            },
      ),
    ),
  };
}

/**
 * Group the sections into one block per run of equal stability.
 *
 * Grouped by *runs* rather than filtered by tier, so the block order is the section order and a
 * future section inserted in the middle cannot silently teleport into the cached prefix. The last
 * block never carries a hint: whatever it holds is the end of the prompt, and a breakpoint there
 * writes an entry that the next request — with a different timestamp above it — cannot read.
 */
function toBlocks(sections: Section[]): SystemBlock[] {
  const blocks: { texts: string[]; stability: Stability }[] = [];

  for (const section of sections) {
    const open = blocks.at(-1);
    if (open?.stability === section.stability) open.texts.push(render([section]));
    else blocks.push({ texts: [render([section])], stability: section.stability });
  }

  return blocks.map((block, index) => ({
    text: block.texts.join(SECTION_SEPARATOR),
    ...(index < blocks.length - 1 ? { cache: true } : {}),
  }));
}

function collectSections(ctx: PromptContext): Section[] {
  const { agent, persona } = { agent: ctx.agent, persona: ctx.agent.persona };
  const sections: Section[] = [];

  const push = (
    name: string,
    content: string | undefined,
    essential: boolean,
    stability: Stability,
    origin: Section["origin"],
  ) => {
    if (content && content.trim())
      sections.push({ name, content: content.trim(), essential, stability, origin });
  };

  /**
   * The operator's own material, and the only thing `/prompt` prints.
   *
   * These come from files they wrote and a pool they can already open — IDENTITY.md, SOUL.md,
   * AGENTS.md, MEMORY.md, and the skills list. (USER.md was one until 0.7.0; who somebody is comes from
   * People now, below, and only for whoever is speaking.) Everything below is rendered by this
   * repository: the harness, the guardrails, the runtime framing. That prose is the product, and an
   * install being able to print it verbatim on request makes it public.
   */
  push("identity", joinBlocks(persona.identity, persona.soul), true, "files", "operator");
  push("agents", persona.agents, true, "files", "operator");
  push("skills", renderSkills(ctx), false, "files", "operator");
  push("memory", persona.memory, false, "files", "operator");
  /**
   * Harness before runtime, and the order is the whole point.
   *
   * Prefix caching, implicit or annotated, stops matching at the first byte that changed. `runtime`
   * carried `Current time: <ISO>`, which changed on every single request (now only the date —
   * the time moved to the message, see `clockNote`); `harness` changes only when
   * the toolset or the exec posture does. So with runtime first, the timestamp sat ~20k characters
   * into the prompt and invalidated everything after it, including the ~3.0k tokens of harness.
   * Measured on the live install: 5.0k tokens of cache-eligible prefix before this line was moved,
   * ~8.0k after, on every request and every one of up to 25 tool iterations.
   *
   * That reordering was what an *implicit* prefix cache can be given. `capability` is the other half:
   * a boundary the Anthropic path can put a real breakpoint on, so a harness that did change costs a
   * miss on its own 3.0k rather than taking the files-derived 5.0k in front of it down with it.
   *
   * Nothing about the *content* moves. `harness` is the operating manual and `runtime` is where it is
   * being run — reading them in either order is the same briefing, and putting the situational facts
   * last also puts them nearest the conversation, which is where a model weights them most.
   *
   * Both are essential: trimming the harness makes the agent promise things the harness will refuse,
   * which reads as the model misbehaving rather than as a missing section.
   */
  // The product's own instructions, written here and shipped in the binary — see `Section.origin`.
  push("harness", renderHarness(ctx), true, "capability", "shipped");
  /**
   * What is remembered about the people in this chat — after the harness, in a tier of its own (M2).
   *
   * It sat at the end of the pack's tier, ahead of both breakpoints, so whatever moved it took the
   * harness out of the cache with it, and in a group something always did: the profiles were in the
   * order people had spoken. They are in key order now (`memory/recall.ts`), so who is speaking no
   * longer moves it at all; what still does — a fact written mid-conversation, a `/new`, the nightly
   * pass, midnight, somebody new speaking in the group — now costs this block alone, behind a
   * breakpoint of its own, and the pack and the harness stay cached. On an implicit prefix cache, the
   * kind the OpenAI-compatible path has, the order does the same work: the first changed byte is here,
   * after the harness rather than before it.
   *
   * The household's own material, so `/prompt` shows it — "what does my agent know about me" is a
   * question the operator opens it to answer.
   */
  push("recall", renderRecall(ctx), false, "chat", "operator");
  /**
   * The framing around the facts — "You are:", "Model:", "Platform:" — which is this repository's
   * wording. The facts themselves are in `nouride status` and on the dashboard, so hiding this
   * costs the operator nothing they cannot read elsewhere.
   */
  push("runtime", renderRuntime(ctx), true, "request", "shipped");
  /**
   * Who the agent is speaking to, which is the operator's `[[people]]` entry and not our prose.
   *
   * One line — "You are talking to <name>." — assembled from config they wrote. It reads as part of
   * the harness because of where it sits, and it is not.
   */
  push("dynamic", renderDynamic(ctx), false, "request", "operator");

  // Guaranteed non-empty even for a bare pack: an agent with one markdown file still
  // needs to know its own name.
  if (sections.length === 0) {
    sections.push({
      name: "identity",
      content: `You are ${agent.config.displayName}.`,
      essential: true,
      stability: "files",
      origin: "operator",
    });
  }

  return sections;
}


/**
 * Wrap each section in a fenced marker.
 *
 * Persona files are trusted-ish (an operator wrote them) but memory is written by the
 * agent itself and skill bodies can come from anywhere, so an unambiguous boundary is
 * what lets the model tell the engine's instructions from content it is being shown.
 */
function render(sections: Section[]): string {
  return sections
    .map(
      (section) =>
        `${DELIMITER_START}${section.name.toUpperCase()}${DELIMITER_END}\n${section.content}\n${DELIMITER_START}/${section.name.toUpperCase()}${DELIMITER_END}`,
    )
    .join(SECTION_SEPARATOR);
}

/**
 * What goes between two sections — and, necessarily, between two blocks.
 *
 * The provider's constant, not a local copy of the same two characters. A block list joined by the
 * provider has to come out byte-identical to `text`, or the token estimate bounds one prompt while
 * the cache keys another. Sharing the constant is how that stays true without a comment asking two
 * files to remember it.
 */
const SECTION_SEPARATOR = SYSTEM_BLOCK_SEPARATOR;
