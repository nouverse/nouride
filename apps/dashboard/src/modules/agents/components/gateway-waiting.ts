/**
 * What a connection that is not up yet waits on, as its row says it.
 *
 * "Connecting" for half an hour reads as hung. Where the connection said why (`GatewayInstance.waiting`), the row
 * says it, with when it comes back where the chat app named a time: on a live box a Telegram connection waited thirty
 * minutes the app had asked for, and nothing on its row told that from a connection that would never come back.
 */

import type { GatewayInstance } from "@nouride/wire";
import { ago, inTime } from "@/commons/lib/format";

type Waiting = NonNullable<GatewayInstance["waiting"]>;

/** The line under a connection's name, or null where it waits on nothing that is known. */
export function waitingSaid(gateway: Pick<GatewayInstance, "enabled" | "status" | "waiting">, now = Date.now()): string | null {
  const waiting: Waiting | undefined = gateway.waiting;
  if (!gateway.enabled || !waiting || (gateway.status !== "connecting" && gateway.status !== "reconnecting")) return null;
  const when = waiting.until !== undefined && waiting.until > now ? `Connects ${inTime(waiting.until, now)}.` : `Not connected yet, since ${ago(waiting.since, now)}.`;
  return `${when} ${waiting.reason}`;
}
