/**
 * The `delegate` lines of TOOLS: when to hand work to helpers, how to brief one, and — where this agent may — when to
 * hand it to one in the background (0.7.15).
 *
 * Its own file because the background half is a decision the model makes about the *person*, not about a tool: whether
 * the work is long enough that they should not wait on it. The habit wanted: one helper for a long task, so the agent
 * stays free, and more only for independent pieces. A tool's schema cannot say that; a model meets a schema only
 * once it has already chosen the tool.
 *
 * Every line is a task shape, the way the rest of TOOLS is written, and each is gated on what this agent holds: the
 * background lines only when `[delegate] max_background` gives it any (`HarnessFacts.backgroundHelpers`), with the
 * number this turn was resolved with.
 */

import { BRIEF_SCOPE } from "@/modules/tools/builtins/delegate-brief.ts";
import type { HarnessView } from "./types.ts";

export function renderDelegate({ ctx, toolNames }: HarnessView): string[] {
  // Never once reached for on the live box — 2,225 tool executions, zero delegations — while the
  // tool sat in every agent's config the whole time. A tool the model only ever meets through its
  // own description is a tool it does not think of; the line next to it here is what changed that
  // for `web_search` and the CLI block, and there was no reason to expect this one to be different.
  if (!toolNames.includes("delegate")) return [];
  const limit = ctx.harness.backgroundHelpers ?? 0;
  // When to hand work to a helper at all, and when in the background, is "Who does the work" (`harness-work.ts`), said
  // once beside another agent and a mission (0.8.17); what is here is how a helper works.
  return [
    /**
     * The brief, and the part of it a model leaves out. Asked for an instruction, it wrote the shortest one that read
     * as complete to itself — "check the logs on the NAS" — and the helper, which knows nothing of the conversation,
     * spent its first rounds finding out which logs and which NAS. English because the helper reads it and a model's
     * tool use is strongest in it; the person still hears the result in their own language.
     */
    "- Each helper starts blank: no persona, no memory, nothing of this conversation, and it cannot ask you a question. Give it a brief (`goal`, `context`, `constraints`, `deliverable`) written in English whatever language the person speaks, and put in `context` what it needs and cannot know: the paths and hosts, decisions already made, what was tried and what came of it. One sentence more from you costs less than a helper that starts confused.",
    // A brief that deletes something and also asks why ran fourteen minutes on a production machine (0.7.25).
    `- ${BRIEF_SCOPE}`,
    "- A helper runs as you: the same approvals and the same limits. It is not a way around anything, and work where one step needs the previous step's answer is still yours to do.",
    ...(limit > 0
      ? [
          `- **A helper in the background** (\`background: true\`) is ONE task, so you stay free for the person: your turn ends at once, they can keep talking to you, and its result comes to you as a message when it finishes. Checking many links, hosts or files, research across them, a long build, a migration rehearsal. Not for a quick answer, and not for a question the person is waiting on now: answer those yourself.`,
          `- More than one at once only for independent pieces; ${limit === 1 ? "you may have one running" : `at most ${limit} running`}. Before starting one, look at what is already running (the message you are answering lists any), so the same work is not started twice. Each result reaches you as that helper finishes: report each one when it arrives, in the person's language, and wait for the next.`,
        ]
      : []),
  ];
}
