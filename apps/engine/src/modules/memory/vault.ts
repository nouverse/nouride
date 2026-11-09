/**
 * The memory vault's layout — the only place a memory path is built (`docs/SPEC.md` §12.2).
 *
 * One folder per kind of node, so an Obsidian graph can colour them by path, and so a person browsing
 * the folder finds conversations, people and topics where they expect them:
 *
 * ```
 * episodes/2026/09/2026-09-25-0459-nouva.md   one conversation
 * archive/2026/09/2026-09-25-0459-nouva.md.gz its transcript, once the episode is compacted
 * days/2026/09/2026-09-25.md                  the day's hub, generated — by month, like episodes
 * people/sam.md                               a profile
 * agents/nouva.md, groups/keluarga.md, tags/nouride.md   graph stubs, generated
 * shared.md                                   what every agent knows
 * .proposals/, .history/                      hidden: not memory, the machinery around it
 * .deleted.json                               where each chat's deleted conversations ended (`deleted.ts`)
 * .nouride-vault.json                         which format the vault is in (`format.ts`)
 * ```
 *
 * Every segment that came from outside — a person key, an agent id, a tag, an episode id a model or a
 * browser typed — is checked before it is joined, so nothing can climb out of the root.
 */

import { join } from "@nouride/runtime";

/** A path segment that cannot climb, hide, or name a directory. Lower case: file systems that fold case must not merge two. */
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `2026-09-25-0459-nouva`, and `…-nouva-2` for a second conversation in the same minute. */
export const EPISODE_ID = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-([a-z0-9][a-z0-9_-]{0,63})$/;

/** The day an episode id starts with — for a fact, the day it was learned. Undefined for a fact written by hand. */
export function episodeDay(id: string | undefined): string | undefined {
  return /^\d{4}-\d{2}-\d{2}/.exec(id ?? "")?.[0];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The subject `shared.md`'s facts are indexed under — which is why no person may have it as a key. */
export const SHARED = "shared";

/** Whether a value can be a path segment as it stands — what `segment` checks, as a question rather than a refusal. */
export function isSegment(value: string): boolean {
  return SEGMENT.test(value);
}

/** Whether a value is a day as hubs are named, `2026-09-25` — what `day()` checks, asked by whoever reads one first. */
export function isDay(value: string): boolean {
  return DAY.test(value);
}

function segment(value: string, what: string): string {
  if (!isSegment(value)) {
    throw new Error(`${what} "${value}" cannot be part of a memory path: lowercase letters, digits, "-" and "_" only`);
  }
  return value;
}

/**
 * A name folded to a segment: `Liburan Bali` → `liburan-bali`, `Keluarga Besar!` → `keluarga-besar`.
 * Null when nothing is left to fold — the caller decides whether that is a refusal or a fallback.
 */
export function slugOf(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return SEGMENT.test(slug) ? slug : null;
}

function episodeParts(id: string): { year: string; month: string } {
  const match = EPISODE_ID.exec(id);
  if (!match) throw new Error(`"${id}" is not an episode id`);
  return { year: match[1]!, month: match[2]! };
}

/** A day hub's place in the vault, as links name it: `days/2026/09/2026-09-25`. By month, so no folder grows past 31. */
export function dayPath(day: string): string {
  return `days/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}`;
}

export interface Vault {
  readonly root: string;
  readonly episodesDir: string;
  episode(id: string): string;
  readonly archiveDir: string;
  archive(id: string): string;
  readonly daysDir: string;
  day(day: string): string;
  readonly peopleDir: string;
  person(key: string): string;
  readonly agentsDir: string;
  /**
   * An agent's stub, or null for an id no file can be named by. A pack directory may be called anything
   * — `nouva.v2` loads — and its conversations are filed like any other; the stub is what it goes without,
   * so its link stays unresolved in the graph. A slug of the id would be a file no episode links to.
   */
  agent(id: string): string | null;
  readonly groupsDir: string;
  group(slug: string): string;
  readonly tagsDir: string;
  tag(tag: string): string;
  readonly shared: string;
  readonly proposals: string;
  readonly history: string;
  readonly formatFile: string;
  readonly deleted: string;
}

/** Where a subject's facts are: a person's profile, or `shared.md` for `SHARED`. */
export function subjectFile(vault: Pick<Vault, "shared" | "person">, subject: string): string {
  return subject === SHARED ? vault.shared : vault.person(subject);
}

export function vaultAt(root: string): Vault {
  return {
    root,
    episodesDir: join(root, "episodes"),
    episode: (id) => {
      const { year, month } = episodeParts(id);
      return join(root, "episodes", year, month, `${id}.md`);
    },
    archiveDir: join(root, "archive"),
    archive: (id) => {
      const { year, month } = episodeParts(id);
      return join(root, "archive", year, month, `${id}.md.gz`);
    },
    daysDir: join(root, "days"),
    day: (day) => {
      if (!DAY.test(day)) throw new Error(`"${day}" is not a day (YYYY-MM-DD)`);
      return join(root, `${dayPath(day)}.md`);
    },
    peopleDir: join(root, "people"),
    person: (key) => join(root, "people", `${segment(key, "person key")}.md`),
    agentsDir: join(root, "agents"),
    agent: (id) => (isSegment(id.toLowerCase()) ? join(root, "agents", `${id.toLowerCase()}.md`) : null),
    groupsDir: join(root, "groups"),
    group: (slug) => join(root, "groups", `${segment(slug, "group")}.md`),
    tagsDir: join(root, "tags"),
    tag: (tag) => join(root, "tags", `${segment(tag, "tag")}.md`),
    shared: join(root, "shared.md"),
    proposals: join(root, ".proposals"),
    history: join(root, ".history"),
    formatFile: join(root, ".nouride-vault.json"),
    deleted: join(root, ".deleted.json"),
  };
}
