/**
 * The knowledge base in everyday words (0.8.20): who may be answered from a collection, which agents look in it, whom it
 * is about, and how each document reads. The people who use the dashboard are not technical, so
 * a collection's settings are said as sentences, never as the values they are kept as.
 *
 * Pure.
 */

import type { KnowledgeDocument, KnowledgeReaders, KnowledgeSection } from "@nouride/wire";
import { ago } from "@/commons/lib/format";

/** "Dina", "Dina and Kak Sam", "Dina, Kak Sam and Raka". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** How the page names who a collection's settings name. */
export interface Names {
  /** A person, by their key. */
  person: (key: string) => string;
  /** A group by memory's key for its chat, where the page knows its name. */
  group: (chat: string) => string | undefined;
  /** The person this account is, when it is somebody in People. */
  me: string | null;
}

/**
 * Who may be answered from a collection, as a sentence. A collection kept to people is used only in a chat with one of
 * them alone, never in a group, even one they are all in: the rule memory keeps.
 */
export function readersLine(readers: KnowledgeReaders, names: Names): string {
  switch (readers.kind) {
    case "everyone":
      return "Your agents may answer anyone from it.";
    case "group": {
      const name = names.group(readers.chat);
      return name ? `Your agents may answer the ${name} group from it.` : "Your agents may answer one group chat from it.";
    }
    case "admins":
      return "Your agents may answer only the admins from it, each in a chat with just them.";
    case "people": {
      if (readers.people.length === 1 && readers.people[0] === names.me) return "Your agents may answer only you from it, in a chat with just you.";
      const who = listed(readers.people.map((key) => (key === names.me ? "you" : names.person(key))));
      return readers.people.length === 1 ? `Your agents may answer only ${who} from it, in a chat with just them.` : `Your agents may answer only ${who} from it, each in a chat with just them.`;
    }
  }
}

/** Which agents look in a collection: every one, or those it names. */
export function agentsLine(agents: readonly string[] | null, agentName: (id: string) => string): string {
  if (agents === null) return "Every agent looks in it.";
  if (agents.length === 0) return "No agent looks in it.";
  return agents.length === 1 ? `Only ${agentName(agents[0]!)} looks in it.` : `Only ${listed(agents.map(agentName))} look in it.`;
}

/** Whom a collection is about, or null when it names nobody. */
export function aboutLine(about: readonly string[], names: Names): string | null {
  if (about.length === 0) return null;
  return `About ${listed(about.map((key) => (key === names.me ? "you" : names.person(key))))}.`;
}

const counted = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

export function countsLine(documents: number, sections: number): string {
  return `${counted(documents, "document", "documents")} · ${counted(sections, "section", "sections")}`;
}

/** How a document reads: ready to search, being read, or not, and why (its `reason`). */
export function statusOf(document: Pick<KnowledgeDocument, "status">): { label: string; tone: "ready" | "reading" | "not-read" } {
  if (document.status === "indexed") return { label: "Ready", tone: "ready" };
  if (document.status === "unreadable") return { label: "Could not be read", tone: "not-read" };
  // A picture or a video: nothing went wrong, it is a kind kept without being searched.
  if (document.status === "listed") return { label: "Kept, not searched", tone: "not-read" };
  // A state this page does not know yet is the document on its way in.
  return { label: "Being read", tone: "reading" };
}

/** A section's pages, where its document has them. */
export function pagesLine(section: Pick<KnowledgeSection, "pageFrom" | "pageTo">): string | null {
  if (section.pageFrom === undefined) return null;
  return section.pageTo === undefined || section.pageTo === section.pageFrom ? `Page ${section.pageFrom}` : `Pages ${section.pageFrom} to ${section.pageTo}`;
}

/** What the orchestrator is asked when a program must be installed before a document can be read. */
export function installMessage(needs: string, title: string, collection: string): string {
  return `Please install the ${needs} package, so the knowledge base can read "${title}" in ${collection}.`;
}

/** Memory's key for a group chat, as a collection's readers name one: the connection, then the chat. */
export const groupKey = (gatewayId: string, chatId: string): string => `${gatewayId}:${chatId}`;

/**
 * Under a document's title (0.8.23): what the title does, in plain words. An agent always gives an English one; a person
 * may write any language, and is told what English adds.
 */
export const TITLE_HINT = "A few words saying what it is. Written in English, your agents find it whatever language they search in.";

/** When a document came in: the time its file was saved here, which a later change to it moves. */
export function addedLine(mtime: number, now = Date.now()): string {
  return `Added ${ago(mtime, now)}`;
}
