/**
 * What an export holds, in the words the page says it with: a line for each part there is something of, largest
 * things first as a person thinks of them (their chats, then what was set up, then what the agents keep).
 */

import type { TransferParts } from "@nouride/wire";
import { formatBytes } from "@/commons/lib/format";

const PART_WORDS: Record<keyof TransferParts, string> = {
  config: "Settings and people",
  agents: "Agents and their skills",
  memory: "Memory",
  knowledge: "Documents",
  attachments: "Files sent in chats",
  uploads: "Files sent in the dashboard's chats",
  notes: "Work notes",
  workspace: "The agents' own folders",
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The lines of what a file holds: the database first, then each part that has a file in it. */
export function holdsLines(parts: TransferParts, database: number): string[] {
  return [
    `Chats, missions, automations and accounts (${formatBytes(database)})`,
    ...(Object.keys(PART_WORDS) as (keyof TransferParts)[]).flatMap((name) => {
      const part = parts[name];
      return part && part.files > 0 ? [`${PART_WORDS[name]}: ${count(part.files, "file")}, ${formatBytes(part.bytes)}`] : [];
    }),
  ];
}

/** What never travels in a file, whatever is ticked: said beside every export and after every import. */
export const NEVER_IN_IT = "Never in the file: the sign-ins of coding CLIs, backups, logs, installed tools, and a chat app's own session.";

/** What waits for "Go live", as one sentence: the connections and the automations that were on. */
export function waitingLine(held: { connections: string[]; automations: number }): string {
  const parts = [
    ...(held.connections.length > 0 ? [`${count(held.connections.length, "connection")} to chat apps`] : []),
    ...(held.automations > 0 ? [count(held.automations, "automation")] : []),
  ];
  if (parts.length === 0) return "Nothing is waiting. Go live says this Nouride is the one in use.";
  return `${parts.join(" and ")} ${held.connections.length + held.automations === 1 ? "is" : "are"} waiting for Go live.`;
}

export { count };
