/**
 * A call a restart cut off, read for what taking its turn up again may do (0.8.0) — one reading for a chat's turn and a
 * mission's, so the two never disagree about the same call:
 *
 * - **read**: it only read. Named, and the work goes on.
 * - **changed**: it may have changed something, and whether it did is unknown. Named, and the work goes on with being
 *   told to check before redoing it.
 * - **asks**: the gate asks a person about it — a delete, a send, anything on the fixed list. Not taken up by itself:
 *   doing a delete or a payment twice is worse than waiting till morning, so a person says whether to go on.
 */

import { classifyHardline } from "@nouride/policy";
import { describeToolCall } from "@/commons/activity.ts";
import { normalizeCommand } from "@/modules/tools/builtins/exec.ts";
import { READ_ONLY_TOOLS } from "@/modules/tools/read-only.ts";

export type CutKind = "read" | "changed" | "asks";

export interface CutCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Tools that send something out — always worth a person's word before a second time. */
const SENDS = new Set(["send_message", "send_file"]);

export function cutKind(call: CutCall): CutKind {
  if (READ_ONLY_TOOLS.has(call.name)) return "read";
  if (SENDS.has(call.name)) return "asks";
  if (call.name === "exec") {
    const command = normalizeCommand(call.arguments.command);
    if ("argv" in command && classifyHardline(command.argv)) return "asks";
  }
  return "changed";
}

/** The worst of a turn's cut calls: one that asks decides, then one that changed. */
export function worstCut(calls: readonly CutCall[]): { kind: CutKind; call: CutCall } | null {
  for (const kind of ["asks", "changed", "read"] as const) {
    const call = calls.find((one) => cutKind(one) === kind);
    if (call) return { kind, call };
  }
  return null;
}

/** What a chat is told when its turn is left for a person: what was cut off, and how to go on. */
export function cutAsksNotice(agentId: string, call: CutCall): string {
  return (
    `${agentId} was cut off by a restart in the middle of \`${describeToolCall(call.name, call.arguments)}\` (one I ask about), ` +
    "and whether it ran is unknown, so I have not taken it up by myself. Check, then say continue if it should go on."
  );
}

/** What taking a turn up again says about the call it was cut off in: named, and how to treat it. */
export function cutLine(cut: { kind: CutKind; call: CutCall }): string {
  const what = describeToolCall(cut.call.name, cut.call.arguments);
  return cut.kind === "read"
    ? `It was cut off in \`${what}\`, which only reads: run it again if you still need it.`
    : `It was cut off in \`${what}\`, which may have changed something, and whether it ran is unknown: check before you redo it.`;
}
