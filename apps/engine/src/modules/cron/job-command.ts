/**
 * A command with no model, for a job that is one or for one step of several: what it printed, or why it failed. In its
 * agent's workspace, with the environment `exec` would hand that command and nothing else.
 *
 * A command is a line of arguments, or a script the job keeps (`JobScript`). The script's text is the job's, so each run
 * writes it out anew: to a file in a folder of that run's own, by a small shell the agent's own user runs, removed
 * when the program ends. No file is left for a later turn to change between a person's yes and the next run, and the
 * daemon writes nothing into a folder that is the agent's.
 */

import type { CommandRuns, CronSection, Job, SandboxOptions } from "@nouride/shared";
import { runCommand } from "@nouride/runtime";
import { maskSecrets } from "@nouride/secrets";
import type { CronExecutors } from "./scheduler.ts";

/** The variable a script's text travels in, from the daemon to the shell that writes it out. Gone before the program starts. */
const SCRIPT_TEXT = "NOURIDE_SCRIPT_TEXT";

/**
 * The longest a script may be, in bytes. Not a taste: Linux refuses to start a program handed one string longer than
 * 128 KiB (`MAX_ARG_STRLEN`), and the text reaches the shell as one. Refused when the job is saved, with the number.
 */
export const SCRIPT_MAX_BYTES = 120_000;

/**
 * Writes the script to a file of this run's own and runs the program on it: `sh -c <this> sh <program…>`.
 *
 * In the agent's temporary folder, made here where a job runs before the agent ever took a turn. The folder goes when
 * the program ends, and on a signal that ends the shell; one killed outright leaves it for the scratchpad's sweep.
 * The program's exit is the shell's, so a failure reads as the script's own.
 */
const WRITE_THEN_RUN = [
  '[ -n "${TMPDIR:-}" ] && mkdir -p "$TMPDIR" 2>/dev/null',
  // Named whole: a bare `mktemp -d` is put in the agent's folder by one system's and in a folder of its own by another's.
  'd=$(mktemp -d "${TMPDIR:-/tmp}/nouride-script.XXXXXX" 2>/dev/null) || d=$(mktemp -d /tmp/nouride-script.XXXXXX) || { echo "no folder to write the script in" >&2; exit 126; }',
  "trap 'rm -rf \"$d\"' EXIT",
  "trap 'exit 143' TERM INT HUP",
  `printf '%s' "$${SCRIPT_TEXT}" > "$d/script" || { echo "the script could not be written" >&2; exit 126; }`,
  `unset ${SCRIPT_TEXT}`,
  '"$@" "$d/script"',
  "exit $?",
].join("\n");

/** What is started for a command: its own arguments, or the shell that writes its script out and runs the program on it. */
function commandStart(command: Pick<CommandRuns, "argv" | "script">): { cmd: string[]; env: Record<string, string> } {
  if (!command.script) return { cmd: command.argv, env: {} };
  return { cmd: ["sh", "-c", WRITE_THEN_RUN, "sh", ...command.argv], env: { [SCRIPT_TEXT]: command.script.text } };
}

export async function runJobCommand(
  executors: Pick<CronExecutors, "commandSandbox">,
  config: Pick<CronSection, "commandTimeoutMs">,
  /** Whose command it is: a job's agent, or the agent a step is tried for. */
  job: Pick<Job, "agentId">,
  command: CommandRuns,
  /** Written to the command's standard input and closed: a webhook's body, or for a script what the step before said. Never in its arguments or its environment. */
  input?: string,
): Promise<{ output: string } | { error: string }> {
  // The sandbox reads the command off the job it is given: the secrets bound to this argv, those its script names, and no others.
  const sandbox = executors.commandSandbox({ agentId: job.agentId, payload: { kind: "command", argv: command.argv, ...(command.script ? { script: command.script } : {}), then: "deliver" } });
  if (!sandbox) return { error: `agent ${job.agentId} is not loaded, so its workspace is unknown` };

  const start = commandStart(command);
  const options: SandboxOptions = {
    cwd: command.cwd ?? sandbox.cwd,
    agent: job.agentId,
    timeoutMs: command.timeoutMs ?? config.commandTimeoutMs,
    maxOutputBytes: 256 * 1024,
    env: { ...sandbox.env, ...start.env },
    ...(input === undefined ? {} : { stdin: input }),
  };

  const result = await runCommand(start.cmd, options);
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
