/**
 * How a job's process is started: under the operator's ceilings, with its log written masked.
 *
 * A job used to get `nice` and a process group and nothing else. The foreground path has had `prlimit` all along, so
 * the commands most worth bounding — the long ones, which `exec` moves to the background on its own — were the ones
 * that ran without it. And its log held whatever the command printed, credentials included, masked only when a
 * wake-up quoted the tail; the agent can `read` the file whole.
 */

import { type BackgroundHandle, startBackgroundCommand, type TextFilter } from "@nouride/runtime";
import type { ExecPolicySection, SandboxOptions } from "@nouride/shared";
import { SecretMasker } from "@nouride/secrets";

type Ceilings = Pick<ExecPolicySection, "maxMemoryMb" | "maxCpuSeconds">;

/**
 * The kernel's ceilings for one job: the operator's, as a foreground command has them — but no CPU seconds for a
 * service. `--cpu` is a total, not a rate: a server idling at one percent spends a ten-minute budget in seventeen
 * hours, and would be killed for running, which is its job. Its memory ceiling stays.
 */
export function jobLimits(policy: Ceilings | undefined, service: boolean): SandboxOptions["limits"] {
  return { memoryMb: policy?.maxMemoryMb ?? 0, cpuSeconds: service ? 0 : (policy?.maxCpuSeconds ?? 0) };
}

/** Two filters, one after the other — either may be absent. */
function chain(a: TextFilter | undefined, b: TextFilter | undefined): TextFilter {
  return {
    push: (text) => {
      const once = a ? a.push(text) : text;
      return b ? b.push(once) : once;
    },
    end: () => {
      const rest = a ? a.end() : "";
      return b ? b.push(rest) + b.end() : rest;
    },
  };
}

/** The job's process: under `jobLimits`, its log masked of the agent's credentials before they reach the file. */
export function spawnJob(
  job: { argv: string[]; sandbox: Pick<SandboxOptions, "cwd" | "env" | "agent">; service?: boolean },
  logPath: string,
  o: { secrets: Record<string, string> | undefined; policy: Ceilings | undefined; filter?: () => TextFilter },
): BackgroundHandle {
  const secrets = o.secrets;
  const first = o.filter;
  return startBackgroundCommand(job.argv, {
    cwd: job.sandbox.cwd,
    env: job.sandbox.env,
    ...(job.sandbox.agent ? { agent: job.sandbox.agent } : {}),
    logPath,
    limits: jobLimits(o.policy, job.service === true),
    // One masker per stream, as `exec`'s own spill file has: a value split between two reads is still one value.
    // A command printing credentials swaps them for handles first (`tools/credential-output.ts`), then the exact values.
    ...(first || secrets ? { filter: () => chain(first?.(), secrets ? new SecretMasker(secrets) : undefined) } : {}),
  });
}
