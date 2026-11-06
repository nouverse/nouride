/**
 * What the Helpers & jobs page says about a job, decided apart from how it is drawn: which tab it is in, what it is
 * called, and the one line under it. Pure, so each answer is tested without a page.
 */

import type { BackgroundJob, HandedOffTurn } from "@/commons/lib/api";

export type JobTab = "all" | "running" | "done" | "failed" | "stopped";
export type JobKindFilter = "all" | "helper" | "command" | "ask";

/** Where a job's row goes: by how it ended. A daemon that died mid-job leaves `interrupted`, which did not finish. */
export function tabOf(job: BackgroundJob): Exclude<JobTab, "all"> {
  if (job.status === "running") return "running";
  if (job.status === "succeeded") return "done";
  if (job.status === "killed") return "stopped";
  return "failed";
}

export const kindOf = (job: BackgroundJob): Exclude<JobKindFilter, "all"> => job.kind ?? "command";

/** The status in a word a person reads: a helper's `succeeded` is done, a command's is its exit 0. */
export function statusWord(job: BackgroundJob): { word: string; tone: string } {
  switch (job.status) {
    case "running":
      return { word: "running", tone: "badge-info" };
    case "succeeded":
      return { word: "done", tone: "badge-success" };
    case "killed":
      return { word: "stopped", tone: "badge-warning" };
    case "interrupted":
      return { word: "interrupted", tone: "badge-error" };
    default:
      return { word: "failed", tone: "badge-error" };
  }
}

/** What it was asked to do: a helper's goal, an ask's agent and task, a command as it was run. */
export function jobTitle(job: BackgroundJob): string {
  if (job.brief?.goal) return job.brief.goal;
  if (job.ask) return `${job.ask.agent}: ${job.ask.task}`;
  return job.command.replace(/^helper: /, "");
}

/** The first line of a report, without the Markdown that would show as stars in a one-line row. */
function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.replace(/[*_`#>]+/g, "").trim();
}

/** The row's one line: what it is doing while it runs, how it ended once it has. Null when there is nothing to add. */
export function rowLine(job: BackgroundJob, now = Date.now()): { label: string; text: string } | null {
  if (job.status === "running") {
    if (job.processAlive === false) return { label: "Not running", text: "it says running, but nothing is running it: Nouride stopped while it worked" };
    return job.logUpdatedAt ? { label: "Now", text: `last wrote ${Math.max(0, Math.round((now - job.logUpdatedAt) / 1000))}s ago` } : null;
  }
  if (job.report) {
    const said = firstLine(job.report.summary);
    if (job.report.status !== "success") return { label: job.report.status.replace("_", " "), text: job.report.reason ?? said };
    return said ? { label: "Handed back", text: said } : null;
  }
  if (kindOf(job) === "command") return { label: job.exitCode === null ? "Ended" : `Exit ${job.exitCode}`, text: `${(job.logBytes / 1024).toFixed(1)} KB of output` };
  return null;
}

/** How long it ran, or has run so far. */
export const ranFor = (job: BackgroundJob, now = Date.now()): number => (job.endedAt ?? now) - job.startedAt;

/** What the search box looks in. */
export const searchedIn = (job: BackgroundJob): string[] => [job.id, job.agentId, job.command, job.brief?.goal ?? "", job.ask?.task ?? "", job.ask?.agent ?? ""];

export const anyRunning = (jobs: readonly BackgroundJob[]): boolean => jobs.some((job) => job.status === "running");

/**
 * The job's own turn — a helper's work, an asked agent's answer — among those the turn that started it handed off.
 * Each carries its job's id in its cause; the job row keeps only the turn that started it.
 */
export function ownTurnOf(jobId: string, handedOff: readonly HandedOffTurn[] | undefined): HandedOffTurn | null {
  return handedOff?.find((turn) => turn.cause?.job === jobId) ?? null;
}
