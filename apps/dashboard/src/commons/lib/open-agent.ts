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

/** Today against the limit, in one line. */
export function todaySaid(today: NonNullable<AgentOpen["today"]>, maxDailyTokens: number): string {
  const tokens = `${today.tokens.toLocaleString("en-US")} of ${maxDailyTokens.toLocaleString("en-US")} tokens used today${today.estimated ? " (part of it counted by Nouride, as an estimate)" : ""}`; // plain-words-ok: tokens, the unit a model's use is billed in, as the spend limits name it
  const people = today.people === 0 ? "nobody has written yet" : `${today.people} ${today.people === 1 ? "person has" : "people have"} written, ${today.messages} ${today.messages === 1 ? "message" : "messages"} answered`;
  return `${tokens}; ${people}.`;
}
