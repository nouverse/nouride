/**
 * Scheduled jobs and webhooks (`routes/cron.ts`): one table, two triggers, and their runs.
 */

import type { CronDeliveryMode, JobPayload, JobSessionMode } from "@nouride/shared";

/**
 * A scheduled job.
 *
 * `target` is the conversation the job is about; `delivery` is where its output goes, which is
 * usually the same place and deliberately does not have to be. Keeping them apart in the type is
 * what stops the UI from offering one field that silently means both.
 */
export interface JobSummary {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  payload: { kind: JobPayloadInput["kind"]; [key: string]: unknown };
  delivery: { mode: JobDeliveryMode; gatewayId?: string; chatId?: string };
  target: { gatewayId: string; chatId: string };
  session: JobSessionMode;
  createdBy: string;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  failCount: number;
  failStreak: number;
  disabledReason?: string;
  /** Proposed by an agent and not turned on yet (0.8.0): off until somebody turns it on. */
  proposal?: { by: string; at: number; replaces?: string };
  /** Who turned it on from its card: whom its missions run as. */
  turnedOnBy?: string;
  /** What its runs may send without asking again — a person's *always for this job* (0.8.0). */
  allowed?: JobAllowance[];
  /** One human-readable line, rendered by the daemon so the browser never parses a cron expression. */
  describes: string;
}

export type JobDeliveryMode = CronDeliveryMode;

/** What a job does when it fires: the daemon's own `JobPayload`, sent as it is stored. */
export type JobPayloadInput = JobPayload;

/** When a job fires: one of `at`, `every` or `cron`, a string the daemon parses, read in `tz`. */
export interface JobScheduleInput {
  at?: string;
  every?: string;
  cron?: string;
  tz?: string;
}

/** The body of `POST /cron/:id`: what is given is changed, what is not is kept. */
export interface JobPatch extends JobScheduleInput {
  name?: string;
  payload?: JobPayloadInput;
  target?: { gatewayId: string; chatId: string };
  delivery?: { mode: JobDeliveryMode; gatewayId?: string; chatId?: string };
  session?: JobSummary["session"];
  keepAfterRun?: boolean;
}

/** The body of `POST /cron`. */
export interface JobInput extends JobPatch {
  agentId: string;
  name: string;
  payload: JobPayloadInput;
  target: { gatewayId: string; chatId: string };
}

/** The body of `POST /webhooks`: the request is the trigger, so there is no schedule to give and no last run to keep. */
export type WebhookInput = Omit<JobInput, keyof JobScheduleInput | "keepAfterRun">;

/**
 * A job whose trigger is an HTTP request rather than a clock.
 *
 * Same row in the same table as a `JobSummary` — target, payload, delivery and run counters all
 * mean the same thing. What differs is what you want to see about it, which is why it has a page of
 * its own: an address to copy, not a next-run time.
 */
export interface WebhookSummary extends Omit<JobSummary, "describes" | "nextRunAt"> {
  /** The token. Shown because the URL is the point of the page — rotate it if it leaks. */
  webhookToken: string;
  /** Path only; the browser knows its own origin, and the daemon may sit behind a proxy. */
  path: string;
  /** The address it is handed out under: the public one when `[dashboard] public_url` is set, a guess when not. */
  url: string;
  urlGuessed: boolean;
  /** Whether a call from the internet can arrive (0.8.0). */
  reach: WebhookReach;
}

/** Local network only, reachable from the internet, or unknown — and why, in one sentence. */
export interface WebhookReach {
  state: "local" | "internet" | "unknown";
  why: string;
  /** The last test through the public address, when there was one. */
  test?: { url: string; at: number; arrived: boolean; detail: string };
}

export interface JobRunSummary {
  id: string;
  jobId: string;
  startedAt: number;
  finishedAt?: number;
  /** `interrupted`: cut off by a daemon restart — not a failure. `running`: not over yet, no `finishedAt`. */
  status: "success" | "error" | "skipped" | "interrupted" | "running";
  result?: string;
  /** What its guards held with nobody there to ask (0.8.0) — each allowed always for the job from here. */
  held?: HeldAction[];
}

/** One standing yes on a job (0.8.0, the daemon's `JobAllowance`): where its runs may send, and who said so. */
export interface JobAllowance {
  keys: string[];
  label: string;
  by: string;
  at: number;
}

/** An action a run's guards held (the daemon's `HeldAction`): where it would have sent — empty when it cannot be said. */
export interface HeldAction {
  keys: string[];
  label: string;
  reason: string;
}

/** What Run answers: how it ended, `running` when it outlasted the wait, `unavailable` when it was refused. */
export interface RunNowOutcome {
  status: JobRunSummary["status"] | "unavailable";
  result?: string;
}

/** One firing of a scheduled job, with the job named so a list of them reads on its own. */
export interface CronRunEntry {
  id: string;
  jobId: string;
  jobName: string;
  agentId: string;
  startedAt: number;
  finishedAt?: number;
  /** `interrupted`: cut off by a daemon restart — not a failure. `running`: not over yet, no `finishedAt`. */
  status: "success" | "error" | "skipped" | "interrupted" | "running";
  result?: string;
}
