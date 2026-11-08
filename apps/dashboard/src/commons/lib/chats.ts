/**
 * What a chat is, in words, for a picker or a card: "DM · Sam", "Group · Nouride". A bare chat id said nothing — the
 * Schedule form offered `5550001111` and `-1005550002` side by side, and nobody could tell a one-to-one from a group.
 */

import type { KnownChat } from "@nouride/wire";

export function chatLabel(chat: Pick<KnownChat, "kind" | "title" | "people">): string {
  if (chat.kind === "dm") return `DM · ${chat.people[0] ?? "someone"}`;
  if (chat.title) return `Group · ${chat.title}`;
  return chat.people.length > 0 ? `Group with ${chat.people.slice(0, 3).join(", ")}` : "Group";
}
