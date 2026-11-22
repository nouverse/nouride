/**
 * The scripts a job keeps (`JobScript`): found wherever a command may be, signed with who wrote them, and asked of the
 * machine before the job is saved.
 *
 * Two things about a script are not in its text, so `validate.ts` cannot hold them: whether the program that runs it is
 * on this machine for its agent's commands, and whether that agent holds the secrets it names. Both are asked where a
 * job is made or changed (`schedule`, the control routes), so a missing interpreter is named to whoever wrote the
 * script and not at 07:00 to a log.
 */

import { runCommand } from "@nouride/runtime";
import type { CommandRuns, JobPayload, JobScript, JobStep, TogetherStep } from "@nouride/shared";
import type { CronExecutors } from "./scheduler.ts";
import { CronValidationError } from "./validate.ts";

type Scripted = CommandRuns & { script: JobScript };

/** One script of a job: the command that runs it, the id it is kept by, and where it is as a refusal says it. */
export interface ScriptAt {
  /** The step's id, or its part's; empty for a job that is one command. */
  id: string;
  /** "step 2", "step 3, part 1", or nothing for a job that is one command. */
  at: string;
  /** The agent whose command it is. */
  command: Scripted;
}

const scripted = (command: CommandRuns): command is Scripted => command.script !== undefined;

/** Every script a job keeps, in the order they are written. */
export function scriptsOf(payload: JobPayload): ScriptAt[] {
  if (payload.kind === "command") return scripted(payload) ? [{ id: "", at: "", command: payload }] : [];
  if (payload.kind !== "steps") return [];
  return payload.steps.flatMap((step, index): ScriptAt[] => {
    if (step.kind === "command") return scripted(step) ? [{ id: step.id, at: `step ${index + 1}`, command: step }] : [];
    if (step.kind !== "parallel") return [];
    return step.steps.flatMap((part, at): ScriptAt[] => (part.kind === "command" && scripted(part) ? [{ id: part.id, at: `step ${index + 1}, part ${at + 1}`, command: part }] : []));
  });
}

/**
 * The job's scripts, each signed with who wrote its text as it stands (`JobScript.by`).
 *
 * A script that comes signed is the daemon's own: one read back from the store, a proposal being turned on. What a
 * caller sends never is (`step-input.ts` does not read the field). Unsigned, a script whose text is what the job held
 * before under the same id keeps that signature, so saving a page does not make its reader the author of every script
 * on it; any other is `by`'s.
 */
export function signScripts(payload: JobPayload, by: string, previous?: JobPayload): JobPayload {
  const before = new Map((previous ? scriptsOf(previous) : []).map((one) => [one.id, one.command.script]));
  const sign = <T extends CommandRuns>(command: T, id: string): T => {
    if (!command.script || command.script.by) return command;
    const was = before.get(id);
    return { ...command, script: { ...command.script, by: was?.by && was.text === command.script.text ? was.by : by } };
  };
  if (payload.kind === "command") return sign(payload, "");
  if (payload.kind !== "steps") return payload;
  const part = (one: TogetherStep): TogetherStep => (one.kind === "command" ? sign(one, one.id) : one);
  const step = (one: JobStep): JobStep => (one.kind === "command" ? sign(one, one.id) : one.kind === "parallel" ? { ...one, steps: one.steps.map(part) } : one);
  return { ...payload, steps: payload.steps.map(step) };
}

/** What is asked of the machine about a script, for one agent. */
export interface ScriptFacts {
  /** The names of the secrets that agent's commands may be handed, or null where it is not loaded. */
  secrets(agentId: string): readonly string[] | null;
  /** Whether a program is there for that agent's commands to run. */
  hasProgram(agentId: string, program: string): Promise<boolean>;
}

/**
 * The facts as this machine has them: an agent's secrets by name, and a program looked for in the same place, as the
 * same user and with the same PATH, a job's command of that agent runs. Asked of a shell and not of the daemon's own
 * view of the disk: where each agent is its own user, what it installed is in a home the daemon does not read.
 */
export function scriptFactsOf(params: { secrets: ScriptFacts["secrets"]; sandbox: CronExecutors["commandSandbox"] }): ScriptFacts {
  return {
    secrets: params.secrets,
    hasProgram: async (agentId, program) => {
      const sandbox = params.sandbox({ agentId, payload: { kind: "command", argv: [program], then: "deliver" } });
      if (!sandbox || !program.trim()) return false;
      const found = await runCommand(["sh", "-c", 'command -v -- "$1" >/dev/null 2>&1', "sh", program], { cwd: sandbox.cwd, agent: agentId, timeoutMs: 10_000, maxOutputBytes: 1024, env: sandbox.env });
      return !found.timedOut && found.exitCode === 0;
    },
  };
}

/**
 * Refuses a job whose script could not run: its program is not on this machine for its agent, or it names a secret
 * that agent does not hold. Throws as `validate.ts` does, so a tool and a route answer it the same way.
 */
export async function assertScriptsRun(agentId: string, payload: JobPayload | undefined, facts: ScriptFacts | undefined): Promise<void> {
  if (!payload || !facts) return;
  const field = payload.kind === "steps" ? "steps" : "command";
  for (const { at, command } of scriptsOf(payload)) {
    const where = at ? `${at}: ` : "";
    const held = facts.secrets(agentId);
    const missing = (command.script.secrets ?? []).filter((name) => !held?.includes(name));
    if (missing.length > 0) {
      throw new CronValidationError(`${where}the script names ${missing.map((name) => `\`${name}\``).join(", ")}, which ${agentId}'s commands are not handed: an admin adds a secret to an agent on its page.`, field);
    }
    const program = command.argv[0] ?? "";
    if (!(await facts.hasProgram(agentId, program))) {
      throw new CronValidationError(`${where}\`${program}\` is not on this machine for ${agentId}'s commands, so the script could not run: write it for a program that is (\`sh\` always is), or install that one.`, field);
    }
  }
}
