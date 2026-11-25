/**
 * The messages this daemon's numbers sent, by id, across every number in the process: how a message that comes in from
 * one of the install's own numbers is told apart as the daemon's own words or a person's on that number's phone.
 *
 * With two numbers in a group, each is handed what the other sent. Taken for a person's, an agent's words were asked
 * to pair, or answered with no limit; taken for an agent's by the address alone, a person typing on the shop's phone to
 * the household number was ignored as a bot. WhatsApp keeps a message's id from sender to receiver, so an id this
 * process chose for a send, written down before the send leaves, is the daemon's word on it, with no race against the
 * other number's copy arriving first. Every number of an install runs in the daemon's one process.
 *
 * Bounded: the newest `SENT_MAX`, each for `SENT_FOR_MS`, long enough for a copy WhatsApp holds while a number is
 * offline. Lost on a restart, as the copies a restart waits for are few.
 */

import { generateMessageIDV2 } from "@whiskeysockets/baileys";

const SENT_MAX = 5_000;
const SENT_FOR_MS = 24 * 60 * 60 * 1000;

const sent = new Map<string, number>();

/** A new message's id, chosen here and written down before it is sent. */
export function idToSend(now: number = Date.now()): string {
  const id = generateMessageIDV2();
  sent.set(id, now);
  for (const [one, at] of sent) {
    if (sent.size <= SENT_MAX && now - at <= SENT_FOR_MS) break;
    sent.delete(one);
  }
  return id;
}

/** Whether a message with this id was sent by one of this daemon's numbers. */
export function sentHere(id: string | null | undefined, now: number = Date.now()): boolean {
  const at = id ? sent.get(id) : undefined;
  return at !== undefined && now - at <= SENT_FOR_MS;
}
