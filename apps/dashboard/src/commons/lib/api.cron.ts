/**
 * Scheduled jobs and webhooks — one table, two triggers — and their runs.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others, so `api.x()` reads the same at every call site. The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { CronRunEntry, JobInput, JobPatch, JobRunSummary, JobSummary, RunNowOutcome, WebhookInput, WebhookSummary } from "@nouride/wire";

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
