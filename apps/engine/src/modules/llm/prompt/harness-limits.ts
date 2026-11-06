/**
 * LARGE OUTPUT and CONVERSATION: the two things the model sees the *result* of and cannot otherwise
 * tell from something it did wrong.
 *
 * A tool result replaced by a marker looks exactly like a tool that returned nothing, and a
 * truncated history looks exactly like a conversation that never happened.
 */

import type { HarnessView } from "./types.ts";

/**
 * Where a tool's answer carries a dashboard link (0.8.11, `web/links.ts`), it is the one given — never one written. An
 * agent that sees one link can write the next by pattern, and a wrong id in a well-formed address looks right until it
 * is opened. Said to a model and to a coding CLI alike.
 */
export const DASHBOARD_LINKS =
  "When the person asks about a mission, a schedule, an approval or anything else with a page on the dashboard, give the link your tool's result carries. Never write a dashboard address yourself; when a result has no link, there is none.";

/**
 * The language an agent works in, said once, in CONVERSATION and in a coding CLI's instructions (`external-agents/
 * instruction.ts`). Only memory, a helper's brief and a mission's goal had asked for English, so the rest followed the
 * person: on mission msn_53b16d, 32 of 37 blocks of text between steps and 13 of 13 thinking blocks were in the
 * person's language, which nobody read. Names no language for replies: the person's own is the only right one.
 */
export const WORKING_LANGUAGE =
  "Your working language is English, whatever language the person speaks: your thinking, plans, notes, briefs to other agents, the files and commits of the work, and the text between your steps where nobody reads it. What reaches a person is in that person's language: an answer, a question, a report, a document made for them, and, in a chat where a person is waiting on you, the words between your steps, which are sent there.";

export function renderLimits({ ctx, toolNames }: HarnessView): string[] {
  const { harness } = ctx;
  const lines: string[] = [];

  // Told rather than left to be discovered, because the model sees the *result* of both of these in
  // its own context and has no way to tell them from something it did wrong. A tool result replaced
  // by a marker looks exactly like a tool that returned nothing.
  lines.push("", "LARGE OUTPUT");
  lines.push(
    // Stated as what already happened, not as a rule to follow. The previous version asked the model
    // to write big output to a file itself — advice it had to remember *before* seeing how big the
    // output was, on the one call where forgetting is expensive. The harness does it now, so the only
    // thing worth saying is how to read what it left.
    // "A path on disk" is conditional: the spill can fail, and the marker says so when it did.
    "- A tool result too large for this context is capped for you: you get the first and last lines, the exact size, and, when it could be saved, a path to the whole thing on disk (the marker says which). That is the harness, not the tool failing or the output being empty.",
    ...(toolNames.includes("read") || toolNames.includes("grep")
      ? [
          `- When you need the part you were not shown, open that path with ${[toolNames.includes("read") ? "`read` and an offset" : "", toolNames.includes("grep") ? "narrow it with `grep`" : ""].filter(Boolean).join(", or ")}. It is a normal file and it is readable. Re-running the command to see the middle of its output is the slower way to get the same thing.`,
        ]
      : []),
    // Worded like the trim marker itself (`llm/context.ts`), so the two cannot give different advice. Since 0.7.25 the
    // marker names a file holding the whole output; the old remedy is for a marker that names none.
    "- Older tool results are also moved out of the context when a turn runs long, so output you read twenty steps ago will not still be there. The marker names a file that holds it whole: open that with `read` (offset/limit), and never re-run a command to see its output again. A marker that names no file means it could not be kept: re-read the file or re-run a read-only command, never one that changed something. Or write down what mattered the first time.",
    ...(toolNames.includes("write") && harness.workspace
      ? [
          "- Anything big you need to keep across turns belongs in a file you write yourself. The path costs nothing to hold; the contents cost you the room to think.",
          // A reply has an output limit, and one call's arguments are part of the reply (2026-10-21: a long `write` cut
          // off three times running). Said the same way the cut call is answered (`executor/cut-off.ts`).
          "- Content longer than a few thousand words goes out in parts: the first `write`, then `write` with `append: true` for each next part. Never one giant call: your reply's output limit would cut it off.",
        ]
      : []),
  );

  lines.push("", "CONVERSATION");
  lines.push(
    "- History is per chat and survives restarts.",
    ...(harness.truncates
      ? [
          `- The oldest turns are dropped once the context window fills. A decision, preference or unfinished task that matters beyond this conversation goes in MEMORY.md${toolNames.includes("memory_write") ? " with `memory_write`" : ""} rather than trusting that you will still see it${toolNames.includes("memory_search") ? ". A person's own preference goes in their profile, with about=person. What was said is filed each night without you." : "."}`,
        ]
      : []),
    "- Write normal markdown (see Formatting below). Long replies are split for you; do not paginate or ask whether to continue.",
    `- ${WORKING_LANGUAGE}`,
    /**
     * The opening line before long work (`pipeline/preamble.ts`). Live: a WhatsApp group waited eight minutes through a
     * fifteen-step turn with no message at all. The words the model writes beside its first tool call are what the
     * daemon sends at once — so they have to be there, and be one sentence. Not for a helper, nor for work nobody
     * watches: no preamble is wired there (`turn.ts`), and in a mission it asked every turn's first words in the person's
     * language beside a page asking all of them in English.
     */
    ...(toolNames.length > 0 && !harness.helper && !harness.unattended
      ? [
          "- When a request will take several steps, start your first reply with one short sentence saying what you are about to do, in the person's language, in the same reply as your first tool call. It is sent to the chat at once, so they are not left waiting in silence. Do not repeat it in your final answer. A plain question you answer at once needs no such line. On long work, an occasional one-line status beside a tool call is welcome.",
        ]
      : []),
  );


  return lines;
}
