/**
 * Where each chat's deleted conversations ended — so a cut never files one of them again.
 *
 * A cut starts where the chat was last cut, which the vault says: where its latest episode ended
 * (`run.ts:cutChat`). Delete that episode on purpose — from the dashboard, or by forgetting somebody — and the vault
 * no longer says the chat was cut that far: the next cut started from the episode before, read the deleted
 * conversation back out of the turn log, and filed it again — the operator's delete undone at one model call.
 *
 * So a deleted episode leaves where it ended, here, and the cut does not start before it. In the vault and not the
 * database on purpose: the database is the thing a restore rolls back. It keeps a chat and a moment per chat —
 * nothing anyone said.
 */

import { readTextFileIfExists } from "@nouride/runtime";
import { WITHIN_THE_SECOND_MS } from "./episode.ts";
import type { Vault } from "./vault.ts";
import { writeSide } from "./write.ts";

/** Chat key → the last moment a deleted conversation in it could have reached, as an ISO instant. */
type Deleted = Record<string, string>;

function parse(text: string | null): Deleted {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1]))));
  } catch {
    return {};
  }
}

function render(deleted: Deleted): string {
  return `${JSON.stringify(Object.fromEntries(Object.entries(deleted).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
}

/** Record that these conversations were deleted, each by its chat and when it ended. Never moves a chat's mark back. */
export async function recordDeleted(vault: Vault, episodes: readonly { chat: string; endedAt: number }[]): Promise<void> {
  if (episodes.length === 0) return;
  await writeSide(vault.deleted, (text) => {
    const deleted = parse(text);
    let changed = false;
    for (const { chat, endedAt } of episodes) {
      const until = endedAt + WITHIN_THE_SECOND_MS;
      const known = deleted[chat] ? Date.parse(deleted[chat]) : -Infinity;
      if (until <= known) continue;
      deleted[chat] = new Date(until).toISOString();
      changed = true;
    }
    return changed ? render(deleted) : undefined;
  });
}

/** The last moment a deleted conversation in this chat reached, or null when none was deleted. */
export async function deletedUpTo(vault: Vault, chat: string): Promise<number | null> {
  const at = parse(await readTextFileIfExists(vault.deleted))[chat];
  return at ? Date.parse(at) : null;
}

/** The file's text with every chat on gateway `from` moved to `to` — what a gateway rename does to it. */
export function renameDeletedChats(text: string, from: string, to: string): string {
  const deleted = parse(text);
  if (!Object.keys(deleted).some((chat) => chat.startsWith(`${from}:`))) return text;
  const moved: Deleted = {};
  for (const [chat, at] of Object.entries(deleted)) {
    const key = chat.startsWith(`${from}:`) ? `${to}:${chat.slice(from.length + 1)}` : chat;
    // The later of two marks for one chat: neither may move back.
    if (!moved[key] || Date.parse(at) > Date.parse(moved[key])) moved[key] = at;
  }
  return render(moved);
}
