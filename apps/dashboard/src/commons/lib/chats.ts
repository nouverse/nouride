/**
 * What a chat is, in words, for a picker or a card: "DM · Sam", "Group · Nouride". A bare chat id said nothing — the
 * Schedule form offered `5550001111` and `-1005550002` side by side, and nobody could tell a one-to-one from a group.
 */

import type { KnownChat } from "@nouride/wire";

/**
 * Whether a person's name is one: somebody the install has no name for is sent as the id they write from, and an id
 * is what this label is here not to show. A one-to-one on Discord read "DM · 1200000000000000042" at the head of an
 * automation's page.
 */
const named = (name: string | undefined): name is string => name !== undefined && name.trim() !== "" && !/^[+\-\d\s]+$/.test(name);

export function chatLabel(chat: Pick<KnownChat, "kind" | "title" | "people">): string {
  const people = chat.people.filter(named);
  if (chat.kind === "dm") return `DM · ${people[0] ?? "someone"}`;
  if (chat.title) return `Group · ${chat.title}`;
  return people.length > 0 ? `Group with ${people.slice(0, 3).join(", ")}` : "Group";
}
