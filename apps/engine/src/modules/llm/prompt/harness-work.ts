/**
 * Who does the work (0.8.17): one block of TOOLS for the ways work can leave this turn (a helper, another agent, a
 * mission) beside doing it here, decided by two questions, whose work it is and how long it will take.
 *
 * The lines were three, one beside each tool, and they overlapped: a helper's "more than a minute or many steps" and a
 * mission's "many files, many steps or items" read alike, so work of ten minutes was drafted as a mission.
 * The bar between the background and a mission is the hour a reply has, which a helper and another agent
 * asked in the background have too: work that may run past it cannot finish in one, and a mission's turns can. Each line
 * is said only where the agent holds what it names.
 */

import { MISSION_IS_FOR } from "@/modules/tools/builtins/mission.ts";
import type { HarnessView } from "./types.ts";

export function renderWork({ ctx, toolNames }: HarnessView): string[] {
  const delegates = toolNames.includes("delegate");
  const asks = toolNames.includes("ask_agent");
  const missions = ctx.harness.startsMissions === true;
  const background = (ctx.harness.backgroundHelpers ?? 0) > 0 && (delegates || asks);
  if (!delegates && !asks && !missions) return [];
  const inBackground = [delegates && "`delegate` with `background: true` for yours", asks && "`ask_agent` with `background: true` for theirs"].filter(Boolean).join(", ");
  return [
    "- **Who does the work** is two questions: whose work is it, and how long will it take? Decide before your first call, not halfway through.",
    // The wait has an end only where a helper may move to the background: a minute, then one still working goes there.
    `  - A few minutes, and yours: do it here.${delegates ? ` Several independent questions you need before you can answer (four hosts to check, three logs to read): \`delegate\` them in one call; up to four run at once and you wait${background ? ", up to a minute: a helper still working then moves to the background" : ""}.` : ""}`,
    ...(asks ? ["  - Another agent's (their skills, tools or access; OTHER AGENTS says what each is for): `ask_agent`, and you report their answer."] : []),
    ...(background
      ? [
          `  - Longer, but under an hour, with nothing to decide midway: in the background, so the person can keep talking to you: ${inBackground}. The result comes to you as a message; report it when it arrives.${missions ? " A helper has the hour a reply has, so work that may run past it is a mission's." : ""}`,
        ]
      : []),
    ...(missions ? [`  - ${MISSION_IS_FOR}${asks ? " `agent` names who does it when it is another agent's work." : ""}`] : []),
  ];
}
