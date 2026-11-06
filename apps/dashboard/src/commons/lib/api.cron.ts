/**
 * Scheduled jobs and webhooks — one table, two triggers — and their runs.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others, so `api.x()` reads the same at every call site. The types these calls carry
 * are declared here and re-exported from `api.ts`, which is where every consumer imports them from.
 */

import { control, post, request } from "./api.client";

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
  session: "chat" | "isolated" | "fresh";
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

/** Where a job's output goes: its target conversation, nowhere, or a URL. */
export type JobDeliveryMode = "announce" | "none" | "webhook";

/**
 * What a job does when it fires, as `POST /cron` and `POST /webhooks` read it — the daemon's `JobPayload`
 * (`@nouride/shared`), whose kinds `scripts/check-wire.ts` holds this to.
 */
export type JobPayloadInput =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; model?: string }
  | { kind: "command"; argv: string[]; then: "deliver" | "agentTurn"; cwd?: string; timeoutMs?: number }
  | { kind: "mission"; goal: string; checks?: string[]; review?: string | false };

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
interface WebhookReach {
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
  /** `interrupted`: cut off by a daemon restart — not a failure (P11). `running`: not over yet, no `finishedAt`. */
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
  /** `interrupted`: cut off by a daemon restart — not a failure (P11). `running`: not over yet, no `finishedAt`. */
  status: "success" | "error" | "skipped" | "interrupted" | "running";
  result?: string;
}

/** What Run answers: how it ended, `running` when it outlasted the wait, `unavailable` when it was refused. */
export interface RunNowOutcome {
  status: JobRunSummary["status"] | "unavailable";
  result?: string;
}

export const cronApi = {
  /** What the scheduler has fired lately, across every job. */
  cronRuns: (limit = 100) =>
    request<{ runs: CronRunEntry[]; timezone: string }>(`${control}/cron/runs?limit=${limit}`),

  cron: (all = false) =>
    request<{ jobs: JobSummary[]; timezone: string }>(`${control}/cron${all ? "?all=1" : ""}`),

  cronJob: (id: string) =>
    request<{ job: JobSummary; runs: JobRunSummary[]; timezone: string }>(`${control}/cron/${id}`),

  cronAction: (id: string, action: "enable" | "disable") =>
    post<{ job: JobSummary }>(`${control}/cron/${id}/${action}`),

  /** *Always for this job* (0.8.0): allow what a run held, or take one back by a key it holds. */
  cronAllowed: (id: string, change: { add: { keys: string[]; label: string } } | { remove: string }) =>
    post<{ job: JobSummary }>(`${control}/cron/${id}/allowed`, change),

  /**
   * Run a job now, answered within ten seconds: with how the run ended, or with `running` (a 202) when it has not.
   * An agent turn can take an hour, and a request held open that long ended at the 15-second timeout here — read as a
   * failure — or at a proxy before that. The run goes on either way; its runs list says how it ended.
   */
  cronRun: (id: string) =>
    request<{ outcome: RunNowOutcome }>(`${control}/cron/${id}/run`, {
      method: "POST",
      headers: { prefer: "respond-async, wait=10" },
    }),

  /**
   * Schedule something.
   *
   * The endpoint has always existed; nothing in the dashboard called it, so every job on this daemon
   * had to be created from the CLI or by asking an agent to do it. Same body as the CLI sends — `at`,
   * `every` or `cron` as a string the daemon parses, because a browser that builds a trigger object
   * would be a second implementation of the parser that refuses bad ones.
   */
  cronCreate: (input: JobInput) => post<{ job: JobSummary }>(`${control}/cron`, input),

  cronUpdate: (id: string, patch: JobPatch) =>
    post<{ job: JobSummary }>(`${control}/cron/${id}`, patch),

  cronDelete: (id: string) => request<{ ok: true }>(`${control}/cron/${id}`, { method: "DELETE" }),

  // Webhooks are cron jobs with a different trigger, so everything except listing and rotation is
  // done through the `cron*` calls above — enable, disable, run, delete and the run history are the
  // same endpoints operating on the same rows.
  webhooks: () => request<{ webhooks: WebhookSummary[] }>(`${control}/webhooks`),

  webhookCreate: (input: WebhookInput) =>
    post<{ webhook: WebhookSummary }>(`${control}/webhooks`, input),

  webhookRotate: (id: string) =>
    post<{ webhook: WebhookSummary }>(`${control}/webhooks/${id}/rotate`, {}),

  /** A test sent through the public address — counted when it arrives, and the job not run. */
  webhookTest: (id: string) =>
    post<{ webhook: WebhookSummary }>(`${control}/webhooks/${id}/test`, {}),
};
