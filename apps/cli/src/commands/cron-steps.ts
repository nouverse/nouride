/**
 * `nouride cron` for a job whose work is a list of steps: the list read from a file, how a run's steps went, and an
 * answer to a step that waits for a person.
 *
 * A list is written in a file because it does not fit a command line: each step has what it does, a name, and where
 * the run goes from it. The file is the list as the daemon keeps it, a JSON array; the daemon reads and refuses it,
 * naming the step, so nothing about a step is decided here.
 */

import type { JobRun, StepOutcome } from "@nouride/shared";
import { type Client, DIM, GREEN, RED, RESET, say, usageError, YELLOW } from "@nouride/cli-kit";
import { readFileBytes } from "@nouride/runtime";

/** The steps a file holds: a JSON array, or `{ "steps": [...] }` as a job's own payload has it. */
export async function stepsFromFile(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = new TextDecoder().decode(await readFileBytes(path));
  } catch {
    usageError(`cannot read ${path}`, "--steps takes a file holding the list of steps, as JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    usageError(`${path} is not JSON: ${(err as Error).message}`);
  }
  const steps = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) usageError(`${path} holds no list of steps`, 'write a JSON array, one object per step: [{ "kind": "command", "argv": ["sh", "-lc", "…"] }, { "kind": "agentTurn", "message": "…" }]');
  return steps;
}

const MARK: Record<StepOutcome["status"], string> = {
  done: `${GREEN}✓${RESET}`,
  failed: `${RED}✗${RESET}`,
  empty: `${DIM}∅${RESET}`,
  running: `${YELLOW}…${RESET}`,
  waiting: `${YELLOW}⏸${RESET}`,
  declined: `${DIM}–${RESET}`,
  expired: `${DIM}–${RESET}`,
  skipped: `${DIM}–${RESET}`,
  interrupted: `${YELLOW}↻${RESET}`,
};

/** How each step of a run went, a line each under the run's own. */
export function sayRunSteps(run: Pick<JobRun, "steps">): void {
  for (const [index, step] of (run.steps ?? []).entries()) {
    const took = step.ms !== undefined ? ` ${Math.max(0, Math.round(step.ms / 100) / 10)}s` : "";
    const said = step.said ? `  ${step.said.split("\n")[0]?.slice(0, 120) ?? ""}` : "";
    say(`    ${MARK[step.status]} ${index + 1}. ${step.id} ${DIM}${step.status}${took}${said}${RESET}`);
  }
}

/** A run's own mark: over well, not run, cut off, still going or waiting, or failed. */
export function runMark(status: JobRun["status"]): string {
  if (status === "success") return `${GREEN}✓${RESET}`;
  if (status === "skipped") return `${DIM}–${RESET}`;
  if (status === "interrupted") return `${YELLOW}↻${RESET}`;
  if (status === "waiting") return `${YELLOW}⏸${RESET}`;
  if (status === "running") return `${YELLOW}…${RESET}`;
  return `${RED}✗${RESET}`;
}

/** `nouride cron continue|stop <run id>`: a person's answer to a step that waits for one. */
export async function answerStep(client: Client, action: "continue" | "stop", runId: string | undefined): Promise<void> {
  if (!runId) usageError(`usage: nouride cron ${action} <run id>`, "the run's id is on `nouride cron runs <job id>`, beside the run that waits");
  await client.post(`/automations/runs/${encodeURIComponent(runId)}/answer`, { go: action === "continue" });
  say(`${GREEN}✓${RESET} ${action === "continue" ? "it goes on from the step that waited" : "stopped at the step that waited"}`);
}
