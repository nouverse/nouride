/**
 * Whose chats the chat page lists: the reader's own, or — an admin's alone — everyone's, set apart by person, and
 * narrowed to one person, or to the private chats nobody in People is known for. Kept in this browser, so an admin who
 * looks at someone's chats finds the page as they left it; anyone else has nothing to pick, and the daemon answers
 * them with their own whatever they ask.
 */

import { isAdmin, useMe } from "@/commons/lib/session";
import { useKept } from "@/commons/hooks/use-kept";

export type Whose = "mine" | "everyone";
/** Whose of everyone's: all of them (`""`), one person's (`person:<key>`), or nobody known's (`unknown`). */
export type WhoseOf = "" | "unknown" | `person:${string}`;

const KEY = "nouride-chat-whose";
const OF_KEY = "nouride-chat-whose-of";
const isWhose = (value: unknown): value is Whose => value === "mine" || value === "everyone";
const isWhoseOf = (value: unknown): value is WhoseOf => value === "" || value === "unknown" || (typeof value === "string" && /^person:.+/.test(value));

export function useWhose(): {
  whose: Whose;
  setWhose: (next: Whose) => void;
  of: WhoseOf;
  setOf: (next: WhoseOf) => void;
  /** What the daemon is asked (`?whose=`): `mine`, `everyone`, `person:<key>` or `unknown`. */
  asked: string;
  canPick: boolean;
} {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const [kept, setKept] = useKept<Whose>(KEY, "mine", isWhose);
  const [of, setOf] = useKept<WhoseOf>(OF_KEY, "", isWhoseOf);
  const whose = admin ? kept : "mine";
  return { whose, setWhose: setKept, of: admin ? of : "", setOf, asked: whose === "mine" ? "mine" : of || "everyone", canPick: admin };
}
