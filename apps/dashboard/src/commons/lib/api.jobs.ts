/**
 * Background jobs — the list and one job for the Helpers & jobs page — and the job watchdog's wait: how long a
 * background job may be quiet before its agent says it is still running. Split out of `api.ts`, which may not grow,
 * and spread into `api` like the budgets.
 */

import { control, post, request } from "./api.client";
import type { BackgroundJob, DelegatePolicy, JobQuietPolicy } from "@nouride/wire";

export const jobsApi = {
  /** The Helpers & jobs page (0.8.12): every job retention has left, or one agent's. */
  jobs: (agent?: string) =>
    request<{ jobs: BackgroundJob[] }>(`${control}/jobs?all=1${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`),
  /** One job and the end of what it wrote: a command's output, a helper's steps. */
  jobLog: (id: string) => request<{ id: string; job: BackgroundJob; log: string }>(`${control}/jobs/${encodeURIComponent(id)}/log`),
  stopJob: (id: string) => post<{ ok: true; id: string }>(`${control}/jobs/${encodeURIComponent(id)}/kill`, {}),
  jobQuietPolicy: () => request<JobQuietPolicy>(`${control}/policy/job-quiet`),
  setJobQuietMinutes: (minutes: number) =>
    post<{ ok: true; minutes: number }>(`${control}/policy/job-quiet`, { minutes }),
  /** One agent's own wait. `null` means "follow the daemon". */
  setAgentJobQuietMinutes: (agent: string, minutes: number | null) =>
    post<{ ok: true }>(`${control}/agents/${agent}/job-quiet`, { minutes }),
  delegatePolicy: () => request<DelegatePolicy>(`${control}/policy/delegate`),
  /** One agent's own limit. `null` means "follow the daemon". */
  setAgentMaxBackground: (agent: string, maxBackground: number | null) =>
    post<{ ok: true }>(`${control}/agents/${agent}/delegate`, { maxBackground }),
};
