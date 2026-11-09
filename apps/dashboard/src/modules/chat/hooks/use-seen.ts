/**
 * What this browser has read: a row is marked when something an agent said came after the person last had it open, and
 * the Groups switch carries a dot when a group heard something after the person last looked at Groups.
 *
 * Kept in the browser, as the daemon keeps no read marks per person. From the first time the list is opened here, so
 * a first visit does not mark everything at once: what came before it counts as read.
 */

import { useCallback, useEffect } from "react";
import { useKept } from "@/commons/hooks/use-kept";

interface Seen {
  /** When this browser first opened the list: anything older counts as read. */
  since: number;
  /** When each row was last open, by its key, so a reply after that marks it. */
  rows: Record<string, number>;
  /** When Groups was last looked at. */
  groups: number;
}

const KEY = "nouride-chat-seen";
/** Enough rows for any household's list; the oldest marks go first. */
const KEEP = 300;

const isSeen = (value: unknown): value is Seen =>
  typeof value === "object" && value !== null && typeof (value as Seen).since === "number" && typeof (value as Seen).groups === "number" && typeof (value as Seen).rows === "object";

export function useSeen() {
  const [seen, setSeen] = useKept<Seen | null>(KEY, null, (value): value is Seen | null => value === null || isSeen(value));
  useEffect(() => {
    if (!seen) setSeen({ since: Date.now(), rows: {}, groups: Date.now() });
  }, [seen, setSeen]);

  const unread = useCallback(
    (key: string, at: number | undefined, fromAgent: boolean) => Boolean(seen && fromAgent && at && at > Math.max(seen.since, seen.rows[key] ?? 0)),
    [seen],
  );
  const markSeen = useCallback(
    (key: string, at: number) =>
      setSeen((was) => {
        if (!was || (was.rows[key] ?? 0) >= at) return was;
        const rows = Object.entries({ ...was.rows, [key]: at }).sort((a, b) => b[1] - a[1]).slice(0, KEEP);
        return { ...was, rows: Object.fromEntries(rows) };
      }),
    [setSeen],
  );
  const groupsNew = useCallback((latest: number) => Boolean(seen && latest > Math.max(seen.since, seen.groups)), [seen]);
  const lookedAtGroups = useCallback(() => setSeen((was) => (was ? { ...was, groups: Date.now() } : was)), [setSeen]);
  return { unread, markSeen, groupsNew, lookedAtGroups };
}

export type SeenMarks = ReturnType<typeof useSeen>;
