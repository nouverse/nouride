/**
 * What Home's box card lists as something to look at: the daemon's own issues, and each pack that did not load.
 *
 * A daemon whose one pack had failed showed "System Healthy" and nothing else — `/health` was `ok`, and the agent
 * was simply missing from the list below. The daemon names them now; this says each
 * as a line a person can act on. A daemon older than the field names none. In plain words (0.8.19): who fixes it, not
 * the command (`nouride agent reload <id>`), which is for whoever runs the server.
 */

import type { HealthPayload } from "@nouride/wire";

/** A connection's own issue, in the daemon's words (`whatsapp:shop: dead`), said as a person reads it. */
function said(issue: string): string {
  const stopped = /^(\S+:\S+): dead$/.exec(issue);
  return stopped ? `The ${stopped[1]} connection stopped and does not come back by itself: see its agent's Connections page.` : issue;
}

export function healthWarnings(health: Pick<HealthPayload, "issues" | "failedAgents">): string[] {
  return [
    ...(health.issues ?? []).map(said),
    ...(health.failedAgents ?? []).map((id) => `Agent ${id} did not start: something in its files is wrong. Whoever runs this server needs to fix them, then reload it.`),
  ];
}
