/**
 * Whose chats the chat page lists: the reader's own, or — an admin's alone — everyone's, set apart by person. Kept in
 * this browser, so an admin who looks at everyone's finds the page as they left it; anyone else has nothing to pick,
 * and the daemon answers them with their own whatever they ask.
 */

import { isAdmin, useMe } from "@/commons/lib/session";
import { useKept } from "@/commons/hooks/use-kept";

export type Whose = "mine" | "everyone";

const KEY = "nouride-chat-whose";
const isWhose = (value: unknown): value is Whose => value === "mine" || value === "everyone";

export function useWhose(): { whose: Whose; setWhose: (next: Whose) => void; canPick: boolean } {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const [kept, setKept] = useKept<Whose>(KEY, "mine", isWhose);
  return { whose: admin ? kept : "mine", setWhose: setKept, canPick: admin };
}
