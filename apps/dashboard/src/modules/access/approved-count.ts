/**
 * How many are approved among the connections the page shows. Counted on each connection by the daemon, past the
 * newest it sends: an open agent's approved, kept for when it is closed, are not this page's while it is open, and an
 * agent picked is counted on its own. What a search found is what it found. A daemon before those counts gave the
 * whole install's, from which only the open agents' sent rows could be taken.
 */
export function approvedCounted(
  listing: { senders: readonly { gatewayId: string; status: string }[]; approvedTotal?: number; approvedOn?: Record<string, number> } | undefined,
  listed: number,
  { inScope, found, wholeInstall, onOpen }: { inScope: (gatewayId: string) => boolean; found: string; wholeInstall: boolean; onOpen: (gatewayId: string) => boolean },
): number {
  if (found || !listing) return listed;
  if (listing.approvedOn) return Math.max(Object.entries(listing.approvedOn).reduce((sum, [gatewayId, n]) => sum + (inScope(gatewayId) ? n : 0), 0), listed);
  if (!wholeInstall) return listed;
  const onOpenSent = listing.senders.filter((sender) => sender.status === "approved" && onOpen(sender.gatewayId)).length;
  return Math.max((listing.approvedTotal ?? 0) - onOpenSent, listed);
}
