/**
 * Whose chats the chat page lists: the reader's own, or — an admin's alone — everyone's set apart by person, one
 * person's, or the private chats nobody in People is known for. One choice, kept in this browser, so an admin who looks
 * at someone's chats finds the page as they left it; anyone else has nothing to pick, and the daemon answers them with
 * their own whatever they ask.
 */

import { isAdmin, useMe } from "@/commons/lib/session";
import { useKept } from "@/commons/hooks/use-kept";

/** What the daemon is asked (`?whose=`): `mine`, `everyone`, `person:<key>` or `unknown`. */
export type Whose = "mine" | "everyone" | "unknown" | `person:${string}`;

const KEY = "nouride-chat-whose";
const isWhose = (value: unknown): value is Whose => value === "mine" || value === "everyone" || value === "unknown" || (typeof value === "string" && /^person:.+/.test(value));

export function useWhose(): { whose: Whose; setWhose: (next: Whose) => void; canPick: boolean } {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const [kept, setKept] = useKept<Whose>(KEY, "mine", isWhose);
  return { whose: admin ? kept : "mine", setWhose: setKept, canPick: admin };
}
