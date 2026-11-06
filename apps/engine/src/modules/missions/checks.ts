/**
 * Done means checked (MISSIONS §5): when the agent says a mission is done, **the daemon** runs its checks — through the
 * same `exec` the agent's commands use, so the same sandbox, the same user, the same masking — in the mission's folder,
 * each with its own time limit.
 *
 * A check runs without asking or not at all. It is a command the agent wrote at the start, run with nobody watching —
 * so it runs as a scheduled job's command does (§17.4 SPEC): at `balanced`, whatever level the person keeps for their
 * chats. What `balanced` answers runs; what it still asks about — a credential leaving, the daemon's config changed —
 * is refused as a check and said so, never put in front of a person as though the agent had asked: a check reads. So it
 * is handed none of the secrets bound to its program (0.8.7): handed one, every `git` check of an agent with a token
 * bound to `git` asked, and none ever ran.
 */

import { skipsApproval } from "@nouride/policy";
import type { Tool, ToolContext } from "@nouride/shared";
import { CHECK_OUTPUT_CHARS, CHECK_TIMEOUT_MS } from "./limits.ts";

export interface CheckResult {
  passed: boolean;
  /**
   * The first command that failed, and what it said — clipped for the next turn's page. Null when all passed.
   * `refused`: it was not run at all, since it would have asked a person — nothing the agent can fix, as a mission cannot
   * change its own checks.
   */
  failed: { command: string; output: string; refused?: true } | null;
}

/** The output a failed check hands the next turn: both ends of a long one, since an error is usually last. */
function clipOutput(text: string, max = CHECK_OUTPUT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const half = Math.floor((max - 40) / 2);
  return `${trimmed.slice(0, half)}\n[… ${trimmed.length - 2 * half} characters cut …]\n${trimmed.slice(-half)}`;
}

/** A check as `exec` is handed it. */
function checkArgs(command: string, cwd: string): Record<string, unknown> {
  return { command, cwd, timeout_ms: CHECK_TIMEOUT_MS, background: false, service: false };
}

/**
 * Why this command would not run as a check — it would ask a person — or null. Asked when the mission starts as well as
 * when it is checked: on the live box a check that began with `git fetch` was found out only at `done`, after an hour of
 * work, and the mission went round "done", refused, ask the person, "done" until it gave up — it cannot change its checks.
 */
export function checkRefusal(command: string, exec: Pick<Tool, "gate">, ctx: ToolContext, cwd: string): string | null {
  const decision = exec.gate?.(checkArgs(command, cwd), { ...ctx, checkOnly: true });
  const unattended =
    !decision ||
    decision.action === "run" ||
    (decision.action === "ask" && skipsApproval("balanced", decision.hardlineClass)) ||
    (decision.action === "refuse" && decision.unasked !== undefined && skipsApproval("balanced", decision.unasked.hardlineClass));
  if (unattended) return null;
  return decision.action === "refuse" ? decision.reason : "it is one even `balanced` asks a person about";
}

/**
 * Run each command in turn and stop at the first that fails: a later check usually means nothing once an earlier one
 * has not passed, and every one run costs the box time.
 */
export async function runChecks(
  commands: readonly string[],
  exec: Pick<Tool, "execute" | "gate">,
  ctx: ToolContext,
  cwd: string,
): Promise<CheckResult> {
  for (const command of commands) {
    const args = checkArgs(command, cwd);
    const why = checkRefusal(command, exec, ctx, cwd);
    if (why) return { passed: false, failed: { command, output: `Not run as a check: ${why}. A check must run without asking: make it one that only reads.`, refused: true } };
    // Handed none of the agent's secrets bound to its program: a check reads (`ToolContext.checkOnly`).
    const result = await exec.execute(args, { ...ctx, checkOnly: true, commandMaxMs: CHECK_TIMEOUT_MS });
    if (result.isError) return { passed: false, failed: { command, output: clipOutput(result.content) } };
  }
  return { passed: true, failed: null };
}
