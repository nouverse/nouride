import { clip, formatBytes, plural } from "@nouride/shared";
import type { JobListResponse, JobLogResponse } from "@/cli/wire.ts";
import { BOLD, DIM, GREEN, RED, RESET, say, usageError, YELLOW } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { hasFlag } from "@/cli/args.ts";
import { knownAction } from "@/cli/usage.ts";

/**
 * `nouride jobs` — background work: commands an agent started with `exec`, helpers it handed work to with `delegate`
 * (0.7.15), and agents it asked with `ask_agent` whose answer it no longer waited for (0.7.19), each a job of its own.
 *
 * Exists because a job outlives the turn that started it, so the chat that has the wake-up message is
 * not necessarily the place the operator is looking.
 */
export async function jobs(client: Client, args: string[]): Promise<void> {
  const [action, id] = args;
  knownAction("jobs", action, ["kill", "log", "list"]);

  if (action === "kill") {
    if (!id) usageError(`usage: nouride jobs kill <id>`);
    await client.post(`/jobs/${encodeURIComponent(id)}/kill`);
    return say(`${GREEN}✓${RESET} stopped ${id}`);
  }

  if (action === "log") {
    if (!id) usageError(`usage: nouride jobs log <id>`);
    const result = await client.get<JobLogResponse>(`/jobs/${encodeURIComponent(id)}/log`);
    if (result.job) {
      const logState = [
        alive(result.job),
        result.job.logBytes !== undefined ? `log ${formatBytes(result.job.logBytes)}` : null,
        result.job.logUpdatedAt ? `updated ${formatAge(result.job.logUpdatedAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      say(
        `${BOLD}${result.job.command}${RESET}\n` +
          `    ${DIM}${result.job.id} · ${result.job.agentId} · ${result.job.status}${
            result.job.exitCode !== null ? ` (exit ${result.job.exitCode})` : ""
          } · ${formatDuration(result.job.startedAt, result.job.endedAt)}${
            logState ? ` · ${logState}` : ""
          }${RESET}`,
      );
      say();
    }
    return say(result.log || `${DIM}(no output yet)${RESET}`);
  }

  const all = hasFlag(args, "--all");
  const { jobs: list } = await client.get<JobListResponse>(all ? "/jobs?all=1" : "/jobs");
  if (!list || list.length === 0) return say(`${DIM}no background jobs${RESET}`);

  const running = list.filter((job) => job.status === "running");
  const ended = list.filter((job) => job.status !== "running");
  const shown = all ? ended : ended.slice(0, RECENT_ENDED);
  if (running.length === 0) say(`${DIM}nothing running${RESET}`);
  for (const job of [...running, ...shown]) {
    const mark =
      job.status === "running"
        ? `${YELLOW}●${RESET}`
        : job.status === "succeeded"
          ? `${GREEN}✓${RESET}`
          : `${RED}✗${RESET}`;
    const live = [
      alive(job),
      job.logBytes !== undefined ? `log ${formatBytes(job.logBytes)}` : null,
      job.logUpdatedAt ? `updated ${formatAge(job.logUpdatedAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    say(`${mark} ${BOLD}${listedCommand(job.command)}${RESET}`);
    say(
      `    ${DIM}${job.id} · ${job.agentId} · ${job.status}${
        job.exitCode !== null ? ` (exit ${job.exitCode})` : ""
      } · ${formatDuration(job.startedAt, job.endedAt)}${live ? ` · ${live}` : ""}${RESET}`,
    );
  }
  const hidden = ended.length - shown.length;
  say();
  if (hidden > 0) say(`${DIM}${hidden} older ${plural(hidden, "job")} not shown · nouride jobs --all${RESET}`);
  say(`${DIM}nouride jobs log <id> for the whole command and its output  ·  nouride jobs kill <id>${RESET}`);
}

/**
 * How many ended jobs the list shows under the running ones; `--all` asks for every one retention has left.
 *
 * The list printed every job the daemon kept, each with its whole command: an agent asked what was running read twenty
 * finished jobs, heredocs and all — 276 lines, ~10k tokens for "nothing" (2026-10-24). What runs is the question;
 * the last few ended are context, and the rest are one flag away.
 */
const RECENT_ENDED = 5;

/** A command as one line of a list: its first line, cut at a width a terminal shows — `jobs log` prints it whole. */
function listedCommand(command: string): string {
  const [first = ""] = command.split("\n");
  const cut = clip(first, COMMAND_WIDTH);
  return cut !== command && !cut.endsWith("…") ? `${cut} …` : cut;
}

const COMMAND_WIDTH = 100;

/**
 * Whether what a running job is still runs. A command's process; a helper's turn, or an asked agent's (0.7.19), which
 * runs in the daemon — the kind says which, so neither is read as a process that exited.
 */
function alive(job: { kind?: string; status: string; processAlive: boolean | null }): string | null {
  if (job.kind === "helper" || job.kind === "ask") {
    const what = job.kind === "ask" ? "ask" : "helper";
    return job.status !== "running" ? what : job.processAlive === true ? `${what} at work` : `${what} (not running in this daemon)`;
  }
  return job.processAlive === true ? "process alive" : job.status === "running" ? "process exited" : null;
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  const seconds = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 1000));
  return endedAt ? `${seconds}s` : `${seconds}s so far`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds === 0 ? "just now" : `${seconds}s ago`;
}

