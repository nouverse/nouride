/**
 * Who does the work (0.8.17): one block of TOOLS for the ways work can leave this turn (a helper, another agent, a
 * mission) beside doing it here, decided by two questions, whose work it is and how long it will take.
 *
 * The lines were three, one beside each tool, and they overlapped: a helper's "more than a minute or many steps" and a
 * mission's "many files, many steps or items" read alike, so work of ten minutes was drafted as a mission.
 * The bar between the background and a mission is the hour a reply has, which a helper and another agent
 * asked in the background have too: work that may run past it cannot finish in one, and a mission's turns can. Each line
 * is said only where the agent holds what it names.
 *
 * And the machine under it, with one rule for working in parallel. An agent was told how to hand work over and nothing
 * of what the box could carry: the same fan-out on a phone as on a server, and the limits met only as a refusal. Every
 * figure in the machine's line was read at boot or from the config, so the line is the same on every turn and stays in
 * the cached part of the prompt; what is running now is said on the message instead (`pipeline/messages.ts`).
 */

import { plural } from "@nouride/shared";
import { MISSION_IS_FOR } from "@/modules/tools/builtins/mission.ts";
import type { HarnessFacts, HarnessView } from "./types.ts";

/**
 * What a toolset was resolved with that this block says, for a turn's prompt and for `/prompt` alike: gathered apart,
 * the diagnostic showed neither the background lines nor the machine an agent was in fact told about.
 */
export function workFacts(toolset: Pick<HarnessFacts, "backgroundHelpers" | "machine">): Pick<HarnessFacts, "backgroundHelpers" | "machine"> {
  return {
    ...(toolset.backgroundHelpers ? { backgroundHelpers: toolset.backgroundHelpers } : {}),
    ...(toolset.machine ? { machine: toolset.machine } : {}),
  };
}

/**
 * The machine, and what this turn may have running on it at once. A limit is said only where the turn can use it: a
 * helper starts no helpers, and a mission's own turn starts no mission.
 */
function machineLine({ ctx, toolNames }: HarnessView): string[] {
  const { machine, backgroundHelpers = 0 } = ctx.harness;
  if (!machine) return [];
  const mine = toolNames.includes("ask_agent") ? "helpers and asks" : "helpers";
  const limits = [
    ...(backgroundHelpers > 0 ? [`at most ${backgroundHelpers} of your ${mine} in the background`] : []),
    ...(ctx.harness.startsMissions ? [`at most ${machine.missions.atOnce} ${plural(machine.missions.atOnce, "mission")} on this machine (${machine.missions.own} of yours)`] : []),
  ];
  return [`- **This machine** has ${machine.words}, shared by every agent on it.${limits.length ? ` At once: ${limits.join(", and ")}.` : ""}`];
}

/**
 * One rule for working in parallel. No figure in it: how much a build takes is the project's, and the line above says
 * what the machine has.
 */
const IN_PARALLEL =
  "- **In parallel or in order**: parts that do not depend on each other run at once, and in the background where they are long; parts that need another's result run in order. Heavy commands (a build, a test suite, an install) are the exception on a small machine: each takes cores and memory from everything else on it, so run no more of them at once than the machine above carries, and one after another when in doubt.";

export function renderWork(view: HarnessView): string[] {
  const { ctx, toolNames } = view;
  const delegates = toolNames.includes("delegate");
  const asks = toolNames.includes("ask_agent");
  const missions = ctx.harness.startsMissions === true;
  const background = (ctx.harness.backgroundHelpers ?? 0) > 0 && (delegates || asks);
  const hands = delegates || asks || missions;
  // The machine and the rule matter to whoever can load it: a turn that hands work over, or runs commands itself.
  const loads = hands || toolNames.includes("exec");
  if (!loads) return [];
  const inBackground = [delegates && "`delegate` with `background: true` for yours", asks && "`ask_agent` with `background: true` for theirs"].filter(Boolean).join(", ");
  return [
    ...machineLine(view),
    ...(hands
      ? [
          "- **Who does the work** is two questions: whose work is it, and how long will it take? Decide before your first call, not halfway through.",
          // The wait has an end only where a helper may move to the background: a minute, then one still working goes there.
          `  - A few minutes, and yours: do it here.${delegates ? ` Several independent questions you need before you can answer (four hosts to check, three logs to read): \`delegate\` them in one call; up to four run at once and you wait${background ? ", up to a minute: a helper still working then moves to the background" : ""}.` : ""}`,
          // Several in one call: asked a reply apart, three agents were three waits one after another.
          ...(asks ? ["  - Another agent's (their skills, tools or access; OTHER AGENTS says what each is for): `ask_agent`, and you report their answer. Work for several agents goes in one call, with `asks`: they work at the same time."] : []),
          ...(background
            ? [
                `  - Longer, but under an hour, with nothing to decide midway: in the background, so the person can keep talking to you: ${inBackground}. The result comes to you as a message; report it when it arrives.${missions ? " A helper has the hour a reply has, so work that may run past it is a mission's." : ""}`,
              ]
            : []),
          ...(missions ? [`  - ${MISSION_IS_FOR}${asks ? " `agent` names who does it when it is another agent's work." : ""}`] : []),
        ]
      : []),
    // Only where the machine was said: the rule points at that line for what "small" means.
    ...(ctx.harness.machine ? [IN_PARALLEL] : []),
  ];
}
