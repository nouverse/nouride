/**
 * What reaches a mission's chat when it ends: the notice, and with its result, after the notice that carries it
 * (0.8.11), its whole report as `report.md`, then the files it named. The daemon's, the same every time, whatever the mission's repository: a mission
 * sent the code it changed as files and its report cut to 1,500 characters, and a person read neither whole.
 */

import { basename } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import type { MissionsDeps } from "./deps.ts";
import { doneNotice, endedNotice, paged } from "./notices.ts";
import type { Mission } from "./types.ts";

const log = createLogger("missions");

/**
 * What its chat is sent as it ends, in this order: the notice, its report (unless the wait for an accept that this end
 * closes already sent it), its files. One that stopped or failed has what it left uncommitted read before its notice
 * goes, so the notice names it; a draft dropped has no work, and a done one's notice names its branch. A look that fails
 * leaves the notice as it was.
 */
export function tellEnded(deps: Pick<MissionsDeps, "tell" | "unsaved" | "pageOf" | "sendReport" | "deliver">, mission: Mission, how: { why?: string; accepted: boolean; reportShown: boolean }): void {
  const done = mission.status === "done";
  const notice = (unsaved: readonly string[]) => (done ? paged(doneNotice(mission, how.accepted), deps.pageOf?.(mission)) : endedNotice(mission, how.why ?? mission.status, unsaved));
  const left = done || mission.startedAt === null ? undefined : deps.unsaved?.(mission);
  const said = left
    ? left.catch((err: unknown) => (log.warn("what an ended mission left uncommitted could not be read", { mission: mission.id, error: String(err) }), [] as string[])).then((unsaved) => deps.tell(mission, notice(unsaved)))
    : deps.tell(mission, notice([]));
  void said.then(() => (how.reportShown ? undefined : sendReport(deps, mission))).then(() => sendFiles(deps, mission));
}

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
async function sendFiles(deps: Pick<MissionsDeps, "deliver" | "tell">, mission: Mission): Promise<void> {
  if (mission.status !== "done" || mission.files.length === 0 || !deps.deliver) return;
  try {
    const unsent = await deps.deliver(mission);
    if (unsent.length > 0) void deps.tell(mission, `Not sent as files (they are on the mission's page): ${unsent.join(", ")}`);
  } catch (err) {
    log.warn("a mission's result files could not be sent", { mission: mission.id, error: String(err) });
  }
}
