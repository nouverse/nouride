/**
 * A scheduled job's or a webhook's run, as a mission (0.8.0): a trigger and a mission template,
 * not a second engine. The job says what the work is; each run is a mission started as the person who turned the job
 * on, reporting to the job's chat, ending at the reviewer — and one at a time, so a run due while the last still works
 * is skipped rather than stacked behind it.
 */

import { createLogger, cutAtWord, MISSION_TITLE_MAX, oneLine, type Job } from "@nouride/shared";
import { deliveryTarget } from "@/modules/cron/addressing.ts";
import type { Missions } from "./missions.ts";
import type { MissionsPort } from "./missions.store.ts";
import { isFinal } from "./types.ts";

/**
 * `drafted`: the run made a draft and started nothing (`JobStep`'s `draft`), with the line the run says of it.
 * `busy`: the job's last mission still works, or, `waits`, its last draft has not been started.
 */
const log = createLogger("missions.job-runs");

export type JobRun = { started: string } | { drafted: string; said: string } | { busy: string; waits?: true } | { refused: string };

/** What a run says of the draft it made, to its record and to the step after it. */
function draftedLine(mission: { id: string; title: string }): string {
  return `Drafted the mission "${mission.title}" (${mission.id.slice(0, 10)}). It waits in the Backlog and runs once it is started.`;
}

export function startJobRun(
  deps: { missions: Pick<Missions, "start">; store: Pick<MissionsPort, "openForJob" | "draftForJob"> },
  job: Job,
  body: string | undefined,
): JobRun {
  if (job.payload.kind !== "mission") return { refused: `job ${job.id} does not run a mission` };
  const draft = job.payload.draft === true;
  // A draft runs nothing, so the job's mission at work does not hold it back; its own last draft still waiting does.
  const open = draft ? deps.store.draftForJob(job.id) : deps.store.openForJob(job.id);
  if (open) return draft ? { busy: open.id, waits: true } : { busy: open.id };
  const reportTo = deliveryTarget(job);
  const started = deps.missions.start({
    agentId: job.agentId,
    // Named by its job: what its person called it when they made it, cut to what a title holds.
    title: cutAtWord(oneLine(job.name), MISSION_TITLE_MAX),
    goal: job.payload.goal,
    ...(job.payload.checks ? { checks: job.payload.checks } : {}),
    ...(job.payload.review !== undefined ? { review: job.payload.review } : {}),
    // The person who turned it on from its card; a job a person made themselves runs as whoever made it.
    startedBy: job.turnedOnBy ?? job.createdBy,
    // The automation's owner's, whoever its runs run as: a job nobody owns starts missions nobody owns.
    owner: job.owner ?? null,
    gatewayId: reportTo.gatewayId,
    chatId: reportTo.chatId,
    jobId: job.id,
    ...(body?.trim() ? { request: body } : {}),
    // Drafted: it waits for the start of the person it would run as, asked where the job reports.
    ...(draft ? { proposed: true } : {}),
  });
  if ("refused" in started) return started;
  // Its folder and its notice are made after the run has its answer: a chat that would not take the notice is logged,
  // and the draft is on the dashboard either way.
  if ("drafted" in started) void started.drafted?.catch((err: unknown) => log.warn("a job's draft could not be said in its chat", { mission: started.mission.id, job: job.id, error: String(err) }));
  return draft ? { drafted: started.mission.id, said: draftedLine(started.mission) } : { started: started.mission.id };
}

/** Why a run stopped at a mission that could not begin: the job's last one still works, or its last draft still waits. */
export function busyLine(run: { busy: string; waits?: true }): string {
  return run.waits ? `the last run's draft, mission ${run.busy}, still waits to be started: start it or drop it` : `the last run, mission ${run.busy}, is still working`;
}

/** How a mission a job's step started stands: still at work, ended with what it has to say, or ended badly. */
export type MissionEnd = { working: true } | { said: string } | { failed: string };

/**
 * The same, read for a step that waits for the mission (`cron/step-runs.ts`): null when there is none by that id.
 * What it has to say is its summary, the few sentences its chat is told, or the whole report when it wrote none.
 */
export function jobMissionEnd(store: Pick<MissionsPort, "get">, id: string): MissionEnd | null {
  const mission = store.get(id);
  if (!mission) return null;
  if (!isFinal(mission.status)) return { working: true };
  if (mission.status === "done") return { said: mission.summary?.trim() || mission.report?.trim() || "the mission is done" };
  return { failed: `the mission ${mission.status === "stopped" ? "was stopped" : "failed"}${mission.reason ? `: ${mission.reason}` : ""}` };
}
