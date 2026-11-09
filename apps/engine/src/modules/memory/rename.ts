/**
 * A gateway renamed, in the vault — `nouride gateway rename` does the database in `modules/gateways/rename.ts` and
 * calls this for the files.
 *
 * Memory's chat key is `<gateway>:<chat>` (`access.ts`), and the vault is where the index is rebuilt from, so a rename
 * the database alone saw was undone by the next reindex. The vault carries the key in five places:
 *
 * - an episode's frontmatter, `chat:` — a group sees its own episodes by it;
 * - a group stub's frontmatter, `chat:` — what ties a group's name to its conversation (`graph.ts`);
 * - a fact's readers, `{…, in <chat>}`, in a profile and in `shared.md` (`profile.ts`) — and in their earlier versions
 *   under `.history/`, which Undo puts back;
 * - a waiting proposal's readers, which become the fact's when it is approved (`proposals.ts`);
 * - `.deleted.json`, where each chat's deleted conversations ended (`deleted.ts`).
 *
 * Missed, a group on the renamed gateway lost every episode and group fact it could see, and the next nightly pass
 * cut its retained history again as new conversations.
 *
 * Archives are left as they are: only an archived transcript is ever read back (`maintain.ts`). Person ids need
 * nothing: memory spells a sender by platform, `telegram:814…`, never by connection (`people.ts`).
 *
 * Planned whole before anything is written, so a file that cannot be read stops the rename before the database moves;
 * the caller snapshots the vault first.
 */

import { join, listDir, readTextFileIfExists, relative } from "@nouride/runtime";
import { renameDeletedChats } from "./deleted.ts";
import { escapeRegex } from "@/commons/text.ts";
import { episodeFiles } from "./episodes.ts";
import type { Vault } from "./vault.ts";
import { writeSide } from "./write.ts";

/** One file the rename rewrites, and what it will say. */
export interface VaultFileRename {
  /** The file, absolute. */
  file: string;
  /** The same, from the vault's root, for the report. */
  path: string;
  after: string;
}

export interface VaultRename {
  files: VaultFileRename[];
  /** Files per kind, for the report: episodes, groups, profiles, history, proposals. */
  counts: Record<VaultPart, number>;
}

type VaultPart = "episodes" | "groups" | "profiles" | "history" | "proposals" | "deleted";

/**
 * `chat:` in a file's frontmatter, moved to the new gateway when it begins with the old one. However it is quoted —
 * the writer quotes a chat id with `@` in it (`frontmatter.ts`), a person may use single quotes — and only inside the
 * frontmatter, so a transcript line that happens to start with `chat:` is what was said.
 */
export function renameFrontChat(text: string, from: string, to: string): string {
  const fence = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!fence) return text;
  const line = new RegExp(`^(chat:[ \\t]*["']?)${escapeRegex(from)}:`, "m");
  const front = fence[1]!.replace(line, `$1${to}:`);
  // The block starts after the opening fence's line, which holds nothing else.
  const start = fence[0].indexOf("\n") + 1;
  return front === fence[1] ? text : `${text.slice(0, start)}${front}${text.slice(start + fence[1]!.length)}`;
}

/**
 * Each fact's readers, `{alex, sam, in telegram:bot:-1001}`, moved to the new gateway. Only a bullet's trailing list
 * is read — the part `profile.ts` parses — so a fact whose text mentions a gateway keeps its words.
 */
export function renameFactReaders(text: string, from: string, to: string): string {
  const inChat = new RegExp(`^(\\s*in\\s+)${escapeRegex(from)}:`);
  return text
    .split("\n")
    .map((line) => {
      if (!/^[-*]\s+/.test(line)) return line;
      return line.replace(/\{([^{}]*)\}(\s*)$/, (whole, inner: string, tail: string) => {
        const items = inner.split(",");
        const moved = items.map((item) => item.replace(inChat, `$1${to}:`));
        return moved.every((item, index) => item === items[index]) ? whole : `{${moved.join(",")}}${tail}`;
      });
    })
    .join("\n");
}

/**
 * A waiting proposal's readers, moved. Parsed rather than matched as text, because the fact a proposal carries is
 * free text that may hold anything; a file that is not JSON is left for a person, as `proposals.ts` leaves it.
 */
export function renameProposal(text: string, from: string, to: string): string {
  let proposal: unknown;
  try {
    proposal = JSON.parse(text);
  } catch {
    return text;
  }
  const readers = (proposal as { provenance?: { readers?: { chat?: unknown } } } | null)?.provenance?.readers;
  if (!readers || typeof readers.chat !== "string" || !readers.chat.startsWith(`${from}:`)) return text;
  readers.chat = `${to}:${readers.chat.slice(from.length + 1)}`;
  return `${JSON.stringify(proposal, null, 2)}\n`;
}

/** Every `.md` under a directory, however deep — `.history/<file's path>/<stamp>.md`. */
function markdownUnder(dir: string): string[] {
  return listDir(dir).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory) return markdownUnder(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

/** `.md` files directly in a directory. */
function markdownIn(dir: string): string[] {
  return listDir(dir)
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name));
}

/** What renaming `from` to `to` would rewrite in the vault — read whole, written nowhere. */
export async function planVaultRename(vault: Vault, from: string, to: string): Promise<VaultRename> {
  const facts = (text: string) => renameFactReaders(text, from, to);
  const front = (text: string) => renameFrontChat(text, from, to);
  const parts: [VaultPart, string[], (text: string) => string][] = [
    ["episodes", episodeFiles(vault).map((episode) => episode.file), front],
    ["groups", markdownIn(vault.groupsDir), front],
    ["profiles", [...markdownIn(vault.peopleDir), vault.shared], facts],
    ["history", markdownUnder(vault.history), facts],
    [
      "proposals",
      listDir(vault.proposals)
        .filter((entry) => !entry.isDirectory && entry.name.endsWith(".json"))
        .map((entry) => join(vault.proposals, entry.name)),
      (text) => renameProposal(text, from, to),
    ],
    // Where its deleted conversations ended: missed, the next cut after the rename would file them again.
    ["deleted", [vault.deleted], (text) => renameDeletedChats(text, from, to)],
  ];

  const files: VaultFileRename[] = [];
  const counts: Record<VaultPart, number> = { episodes: 0, groups: 0, profiles: 0, history: 0, proposals: 0, deleted: 0 };
  for (const [part, paths, rename] of parts) {
    for (const file of paths) {
      const before = await readTextFileIfExists(file);
      if (before === null) continue;
      const after = rename(before);
      if (after === before) continue;
      files.push({ file, path: relative(vault.root, file), after });
      counts[part] += 1;
    }
  }
  return { files, counts };
}

/**
 * Write what the plan says, each file atomically and under its lock. As a file beside memory's own, not as a profile
 * edit: that keeps the text it replaces as a version, and an Undo would then put the old gateway back into a profile.
 * Not indexed either — the daemon is stopped, and its next start syncs the index with what changed.
 */
export async function applyVaultRename(plan: VaultRename): Promise<void> {
  for (const { file, after } of plan.files) await writeSide(file, () => after);
}
