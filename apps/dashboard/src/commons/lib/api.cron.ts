/**
 * Automations: one table of jobs, three ways one starts (a time, a call to its address, a person), and their runs.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others, so `api.x()` reads the same at every call site. The payload types are `@nouride/wire`'s.
 * Reading goes through `/automations`, which answers every job whatever starts it; writing stays on `/cron` and
 * `/webhooks`, the addresses an install's scripts already use.
 */

import { control, post, request } from "./api.client";
import type { AutomationSummary, CronRunEntry, JobInput, JobPatch, JobRunSummary, JobSummary, RunNowOutcome, WaitingStep, WebhookInput, WebhookSummary } from "@nouride/wire";

export const cronApi = {
  /** What the scheduler has fired lately, across every job. */
  cronRuns: (limit = 100) =>
    request<{ runs: CronRunEntry[]; timezone: string }>(`${control}/cron/runs?limit=${limit}`),

  /** Every automation, with how each starts and how its newest run went. */
  automations: () => request<{ automations: AutomationSummary[]; timezone: string }>(`${control}/automations`),

  /** One automation, its last twenty runs with how each step went, and a change an agent suggested to it. */
  automation: (id: string) =>
    request<{ automation: AutomationSummary; runs: JobRunSummary[]; suggested?: AutomationSummary; timezone: string }>(`${control}/automations/${encodeURIComponent(id)}`),

  /** The steps that wait for a person's answer, across every automation. */
  waitingSteps: () => request<{ waiting: WaitingStep[] }>(`${control}/automations/waiting`),

  /** A person's answer to a step that waits for one: go on, or stop the run there. */
  answerStep: (runId: string, go: boolean) => post<{ ok: true }>(`${control}/automations/runs/${encodeURIComponent(runId)}/answer`, { go }),

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
   * Make one that starts at a time or by hand. Same body as the CLI sends — `at`, `every` or `cron` as a string the
   * daemon parses, because a browser that builds a trigger object would be a second implementation of the parser that
   * refuses bad ones.
   */
  cronCreate: (input: JobInput) => post<{ job: JobSummary }>(`${control}/cron`, input),

  cronUpdate: (id: string, patch: JobPatch) =>
    post<{ job: JobSummary }>(`${control}/cron/${id}`, patch),

  cronDelete: (id: string) => request<{ ok: true; id: string }>(`${control}/cron/${id}`, { method: "DELETE" }),

  // A webhook is the same row with another start, so everything but making one and its address goes through the
  // `cron*` calls above: on, off, run, change, delete.
  webhookCreate: (input: WebhookInput) =>
    post<{ webhook: WebhookSummary }>(`${control}/webhooks`, input),

  webhookRotate: (id: string) =>
    post<{ webhook: WebhookSummary }>(`${control}/webhooks/${id}/rotate`, {}),

  /** A test sent through the public address — counted when it arrives, and the job not run. */
  webhookTest: (id: string) =>
    post<{ webhook: WebhookSummary }>(`${control}/webhooks/${id}/test`, {}),
};
