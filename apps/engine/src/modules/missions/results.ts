/**
 * What reaches a mission's chat with its result, after the notice that carries it (0.8.11): its whole report as
 * `report.md`, then the files it named. The daemon's, the same every time, whatever the mission's repository: a mission
 * sent the code it changed as files and its report cut to 1,500 characters, and a person read neither whole.
 */

import { basename } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import type { MissionsDeps } from "./deps.ts";
import type { Mission } from "./types.ts";

const log = createLogger("missions");

/** Its report as `report.md`; where the chat could not take it, said so — it stays on the mission's page. */
export async function sendReport(deps: Pick<MissionsDeps, "sendReport" | "tell">, mission: Mission): Promise<void> {
  if (!mission.report?.trim() || !deps.sendReport) return;
  try {
    const refused = await deps.sendReport(mission);
    if (refused) await deps.tell(mission, `report.md was not sent: ${refused} The report is on the mission's page.`);
  } catch (err) {
    log.warn("a mission's report could not be sent", { mission: mission.id, error: String(err) });
  }
}

/**
 * Its files, less one named `report.md`: the daemon sends the report under that name, and an agent that also wrote it to
 * a file and named it had the person receive two (live, 2026-10-31).
 */
export function besidesTheReport(files: readonly string[]): string[] {
  return files.filter((file) => basename(file).toLowerCase() !== "report.md");
}

/** A done mission's files, after its report: within what the chat takes, named where they could not go. */
export async function sendFiles(deps: Pick<MissionsDeps, "deliver" | "tell">, mission: Mission): Promise<void> {
  if (mission.status !== "done" || mission.files.length === 0 || !deps.deliver) return;
  try {
    const unsent = await deps.deliver(mission);
    if (unsent.length > 0) void deps.tell(mission, `Not sent as files (they are on the mission's page): ${unsent.join(", ")}`);
  } catch (err) {
    log.warn("a mission's result files could not be sent", { mission: mission.id, error: String(err) });
  }
}
