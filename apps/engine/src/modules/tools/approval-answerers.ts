/**
 * Who may answer an approval from a chat — one rule for `/approve`, `/deny`, `/approve all`, the `/approvals balanced`
 * drain and a press on the prompt's buttons, so a button cannot answer what the command would not.
 *
 * In a one-to-one chat, the person in it: nobody else is there. In a room, the person whose message asked, or an admin
 * by People: anyone else admitted to a room could otherwise approve another person's risky command, or mint a standing
 * grant for it. The CLI answers anything — the operator, through a token-guarded surface — and does not ask this; the
 * dashboard asks only whether an admin's request is answered by an admin's account.
 *
 * A change to an agent's own persona (`persona`, 0.8.8; its skill roots too, `skill_root`, 0.8.24) is an admin's alone, in a
 * one-to-one chat too: the files hold the agent's rules and boundaries, and the person chatting with it — a family member
 * paired to it — is not their owner. So
 * is a change to who People says a person is (`people`, 0.8.9): an admin is a person there, and whoever answers it could
 * otherwise make their own chat an admin's. And a program installed for every agent (`shared-tools`, 0.8.9): its install
 * scripts run as the daemon's user, which reaches People, every pack and the secret store. And this
 * machine's packages (`system-packages`, 0.8.15): changed as root.
 */

import { adminOnly, adminOnlyChanges, adminOnlyNotice, type ApprovalRequest, type ChatType } from "@nouride/shared";

export { adminOnly, adminOnlyChanges, adminOnlyNotice };

export function mayAnswer(
  who: { chatType: ChatType; senderId: string; isAdmin: () => boolean },
  request: Pick<ApprovalRequest, "requestedBy" | "hardlineClass">,
): boolean {
  if (adminOnly(request)) return who.isAdmin();
  if (who.chatType === "dm") return true;
  return request.requestedBy === who.senderId || who.isAdmin();
}
