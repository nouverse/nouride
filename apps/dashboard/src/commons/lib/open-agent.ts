/**
 * An agent open to everyone, in the words its pages share: where strangers reach it, and what it used today. Said on
 * its own Access tab and on the Open agents page, so the two never word one number two ways.
 */

import type { AgentOpen } from "@nouride/wire";
import { connectionSaid } from "./platform";

/** Where strangers would reach it, as one sentence. */
export function reachedOn(connections: readonly string[]): string {
  if (connections.length === 0) return "It has no connection of its own yet, so nobody can reach it. Give it one on its Connections tab first.";
  return `Anyone who finds it can write to it on ${connections.map(connectionSaid).join(", ")}, with no code for you to approve.`;
}

/**
 * Today against the limit, in one line. Named where the page is one agent's of several and the line does not stand under
 * its name (the Open agents page): `WA Test used … of its …`.
 */
export function todaySaid(today: NonNullable<AgentOpen["today"]>, maxDailyTokens: number, name?: string): string {
  const used = `${today.tokens.toLocaleString("en-US")} of ${name ? "its " : ""}${maxDailyTokens.toLocaleString("en-US")} tokens`; // plain-words-ok: tokens, the unit a model's use is billed in, as the spend limits name it
  const tokens = `${name ? `${name} used ${used} today` : `${used} used today`}${today.estimated ? " (part of it counted by Nouride, as an estimate)" : ""}`;
  const people = today.people === 0 ? "nobody has written yet" : `${today.people} ${today.people === 1 ? "person has" : "people have"} written, ${today.messages} ${today.messages === 1 ? "message" : "messages"} answered`;
  return `${tokens}; ${people}.`;
}
