/**
 * What "Let in a list" says: how a line is written for each kind of connection, and how a check or a run went.
 *
 * Kept apart from the panel so the words can be read, and tested, without drawing it. Plain words: who reads this
 * page pastes a list of customers, and has never seen a terminal.
 */

import type { AccessImported, GatewayInstance } from "@nouride/wire";

/** How one line is written, by where the connection is. The daemon reads each line the same way. */
export const HOW_TO_WRITE: Record<GatewayInstance["platform"], { line: string; example: string }> = {
  whatsapp: { line: "One phone number a line, with its country code. A name may follow, after a comma.", example: "+62 812 3456 7890, Bu Rina\n62 813 0000 0001" },
  telegram: { line: "One account a line: its @username, or its id in digits. A name may follow, after a comma. A phone number cannot be used: Telegram shows a bot nobody's.", example: "@sam_lee, Sam\n123456789" },
  discord: { line: "One account a line: its username, or its id in digits. A name may follow, after a comma.", example: "sam.lee, Sam\n123456789012345678" },
};

const n = (count: number) => count.toLocaleString("en-US");
const people = (count: number) => `${n(count)} ${count === 1 ? "person" : "people"}`;
const lines = (count: number) => `${n(count)} ${count === 1 ? "line" : "lines"}`;

/** How a check went, a sentence each: who would be let in first, then everything left out and why. */
export function checkSaid(result: AccessImported): string[] {
  const said = [result.added > 0 ? `${people(result.added)} would be let in.` : "Nobody new is on this list."];
  if (result.already > 0) said.push(`${n(result.already)} ${result.already === 1 ? "is" : "are"} in already.`);
  if (result.blocked > 0) said.push(`${n(result.blocked)} ${result.blocked === 1 ? "is blocked and stays" : "are blocked and stay"} out.`);
  if (result.duplicates > 0) said.push(`${lines(result.duplicates)} ${result.duplicates === 1 ? "names" : "name"} somebody twice.`);
  if (result.invalid.count > 0) {
    const shown = result.invalid.examples.slice(0, 5).join(", ");
    said.push(`${lines(result.invalid.count)} could not be read: ${shown}${result.invalid.count > Math.min(5, result.invalid.examples.length) ? ", …" : ""}.`);
  }
  return said;
}

/** What the toast says once a list is in. */
export function letInSaid(result: AccessImported): string {
  return `${people(result.added)} let in on ${result.gateway}`;
}
