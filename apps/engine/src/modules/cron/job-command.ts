/**
 * A command with no model, for a job that is one or for one step of several: what it printed, or why it failed. In its
 * agent's workspace, with the environment `exec` would hand that command and nothing else.
 */

import type { CronSection, Job, SandboxOptions } from "@nouride/shared";
import { runCommand } from "@nouride/runtime";
import { maskSecrets } from "@nouride/secrets";
import type { CronExecutors } from "./scheduler.ts";

export async function runJobCommand(
  executors: Pick<CronExecutors, "commandSandbox">,
  config: Pick<CronSection, "commandTimeoutMs">,
  job: Job,
  command: { argv: string[]; cwd?: string; timeoutMs?: number },
  /** Written to the command's standard input and closed: a webhook's body, which is never in its arguments or its environment. */
  input?: string,
): Promise<{ output: string } | { error: string }> {
  // The sandbox reads the command off the job it is given: the secrets bound to this argv, and no others.
  const sandbox = executors.commandSandbox({ ...job, payload: { kind: "command", argv: command.argv, then: "deliver" } });
  if (!sandbox) return { error: `agent ${job.agentId} is not loaded, so its workspace is unknown` };

  const options: SandboxOptions = {
    cwd: command.cwd ?? sandbox.cwd,
    agent: job.agentId,
    timeoutMs: command.timeoutMs ?? config.commandTimeoutMs,
    maxOutputBytes: 256 * 1024,
    env: sandbox.env,
    ...(input === undefined ? {} : { stdin: input }),
  };

  const result = await runCommand(command.argv, options);
  // `secrets` are the credentials the command was handed; they must not come back out in a
  // delivery, a webhook body or the run row.
  const output = maskSecrets(commandOutput(result.stdout, result.stderr), sandbox.secrets ?? {});

  if (result.timedOut) return { error: `timed out after ${options.timeoutMs}ms` };
  if (result.exitCode !== 0) return { error: `exit ${result.exitCode}${output ? `\n${output.slice(0, 2000)}` : ""}` };
  return { output };
}

/** stdout when there is any, stderr when there is not, both when both — labelled so they are legible. */
function commandOutput(stdout: string, stderr: string): string {
  const out = stdout.trim();
  const err = stderr.trim();
  if (out && err) return `stdout:\n${out}\n\nstderr:\n${err}`;
  return out || err;
}
