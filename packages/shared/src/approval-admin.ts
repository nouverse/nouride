/**
 * The approvals only an admin answers, and what each changes, said to someone who may not: a change to an agent's own
 * persona or its skill roots, to who People says a person is, a program installed for every agent, this machine's
 * packages. Who may answer the rest from a chat is the daemon's rule (`tools/approval-answerers.ts`).
 */

import type { ApprovalRequest, HardlineClass } from "./types/tool.ts";

/** The classes whose approval only an admin answers, and what each changes — said to someone who may not answer it. */
const ADMIN_ANSWERS: ReadonlyMap<HardlineClass, string> = new Map<HardlineClass, string>([
  ["persona", "an agent's persona"],
  ["people", "who People says a person is, and an admin is one"],
  ["shared-tools", "a program every agent runs, installed as the daemon's user"],
  ["system-packages", "this machine's system packages, as root"],
]);

/** Whether only an admin answers this request — never an agent, whatever it may reach (`cli/commands/approvals.ts`). */
export function adminOnly(request: Pick<ApprovalRequest, "hardlineClass">): boolean {
  return request.hardlineClass !== undefined && ADMIN_ANSWERS.has(request.hardlineClass);
}

/** What it changes, where only an admin answers it — "an agent's persona" — or null for any other request. */
export function adminOnlyChanges(request: Pick<ApprovalRequest, "hardlineClass">): string | null {
  return request.hardlineClass === undefined ? null : (ADMIN_ANSWERS.get(request.hardlineClass) ?? null);
}

/** What someone who may not answer it is told, where only an admin may; null for any other request. */
export function adminOnlyNotice(request: Pick<ApprovalRequest, "hardlineClass">): string | null {
  const changes = adminOnlyChanges(request);
  return changes ? `Only an admin can answer this one: it changes ${changes}.` : null;
}
