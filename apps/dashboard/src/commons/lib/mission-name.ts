/**
 * A mission's name, drawn wherever a mission is listed: its page, its card, and what waits for the person on Home and
 * Work. It is the title the daemon keeps for it, a few words saying what the work is called. The goal was the name
 * before, first whole and then cut to its first sentence here, and either way a person read the start of an
 * instruction to the agent.
 */

import type { MissionView } from "@nouride/wire";

/**
 * Its title. A daemon whose missions have none sends none: its goal then, on one line and as it is, which the place
 * that draws it cuts by lines. Nothing is guessed from the goal here.
 */
export function missionName(mission: Pick<MissionView, "title" | "goal">): string {
  return mission.title?.trim() || mission.goal.replace(/\s+/g, " ").trim();
}
