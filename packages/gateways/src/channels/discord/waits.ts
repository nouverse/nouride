/**
 * What a Discord login waits on, said (`BaseGateway.waitingFor`).
 *
 * A limit met while it logs in is waited out by discord.js in silence, and the login then times out with no reason.
 * Its REST client says each limit it meets; while this connection is the one logging in, that is why it waits.
 */

import type { Client } from "discord.js";
import { contained, type Logger } from "@nouride/shared";
import { waitWords } from "../../commons/waits.ts";

/** Why a login waits on a limit Discord set, for a person: `timeToReset` is what discord.js waits before it asks again. */
export function discordWait(timeToResetMs: number): string {
  return `Discord asked this bot to wait ${waitWords(timeToResetMs / 1_000)} before it connects: too many requests in a short time. It connects by itself once the wait is over.`;
}

/** Each limit `client` meets is said through `say`, while it is this connection's client (`current`). */
export function sayWhatLoginWaitsOn(client: Pick<Client, "rest">, log: Logger, current: () => boolean, say: (reason: string, untilMs: number) => void): void {
  client.rest.on(
    "rateLimited",
    contained(log, "could not say what a login waits on", (limit) => {
      if (current()) say(discordWait(limit.timeToReset), Date.now() + limit.timeToReset);
    }),
  );
}
