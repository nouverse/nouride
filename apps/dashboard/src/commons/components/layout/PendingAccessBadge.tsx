/**
 * How many people are waiting, beside Access in the sidebar.
 *
 * In the sidebar because it is on every page, and a pairing code expires in fifteen minutes: the
 * person waiting should not depend on somebody happening to open the right screen. The same query key
 * and interval as the page, so answering there clears this without either knowing the other exists.
 * Nothing at all when nobody waits — a permanent zero is a thing you learn to stop seeing.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";

export function PendingAccessBadge() {
  const access = useQuery({ queryKey: ["access"], queryFn: api.access, refetchInterval: 15_000, retry: false });
  const waiting = (access.data?.senders ?? []).filter((sender) => sender.status === "pending").length;
  if (waiting === 0) return null;
  return (
    <span className="badge badge-xs badge-warning ml-auto font-semibold font-mono" title={`${waiting} waiting to be approved`}>
      {waiting}
    </span>
  );
}
