/**
 * Whose a page lists: the reader's own, or — an admin's alone — everyone's set apart by person, one person's, or what
 * nobody in People is known for. One choice for each page that offers it (Chats, Automations, Missions), kept in this
 * browser, so an admin who looks at someone's finds the page as they left it and a choice made on Chats does not move
 * Missions; anyone else has nothing to pick, and the daemon answers them with their own whatever they ask.
 */

import { isAdmin, useMe } from "@/commons/lib/session";
import { useKept } from "@/commons/hooks/use-kept";

/** What the daemon is asked (`?whose=`): `mine`, `everyone`, `person:<key>` or `unknown`. */
export type Whose = "mine" | "everyone" | "unknown" | `person:${string}`;

/** The pages that keep a choice of their own. */
export type WhosePage = "chat" | "automations" | "missions";

const isWhose = (value: unknown): value is Whose => value === "mine" || value === "everyone" || value === "unknown" || (typeof value === "string" && /^person:.+/.test(value));

export function useWhose(page: WhosePage): { whose: Whose; setWhose: (next: Whose) => void; canPick: boolean } {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const [kept, setKept] = useKept<Whose>(`nouride-${page}-whose`, "mine", isWhose);
  return { whose: admin ? kept : "mine", setWhose: setKept, canPick: admin };
}
