/**
 * Tags — the one vocabulary memory counts by, so it has to stay one vocabulary (`docs/SPEC.md` §12.2).
 *
 * A tag is worth having because many conversations share it: that is what draws a cluster in the
 * graph and makes a count mean something. A model left alone writes `reminder`, `reminders` and
 * `reminder-setup` for one subject, and an import writes another system's vocabulary wholesale — on a
 * production box three quarters of 668 tags were used once, most of them from one import.
 *
 * So every tag from every writer — the nightly pass, a saved conversation, a tidy, a hand merge — goes through
 * {@link fileTags}: folded to a tag already in use where the match is certain, then limited, so a
 * conversation coins at most one new tag and an import none that its own batch does not share.
 * Meaning beyond that is a person's call, in the tidy's preview.
 *
 * Pure.
 */

import { slugOf } from "./vault.ts";

/** Tags one episode keeps: few and broad draw a readable graph; the pass averaged 3.4. */
export const MAX_TAGS = 4;

/** Tags that would be on every conversation. */
const STOP = new Set(["chat", "conversation", "question", "questions", "help", "misc", "general", "other", "talk", "obrolan", "tanya", "pertanyaan", "lainnya", "umum"]);

/** One tag, folded to its canonical spelling, or null when it is not a tag worth keeping. */
export function normalizeTag(raw: string, aliases: ReadonlyMap<string, string>): string | null {
  // `#nouride`, `[[tags/nouride]]` and `tags/nouride` are all the tag a model or a hand edit meant.
  const slug = slugOf(raw.trim().replace(/^\[\[|\]\]$/g, "").replace(/^tags\//, "").replace(/^#/, ""));
  // A bare date is the day hub's job, not a topic.
  if (!slug || slug.length > 40 || STOP.has(slug) || /^\d{4}-\d{2}(-\d{2})?$/.test(slug)) return null;
  return aliases.get(slug) ?? slug;
}

/** Tags folded and de-duplicated, in the order given — no limit; {@link fileTags} decides what is kept. */
export function normalizeTags(raw: readonly string[], aliases: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const tag of raw) {
    const normal = normalizeTag(tag, aliases);
    if (normal && !out.includes(normal)) out.push(normal);
  }
  return out;
}

export type FoldRule = "R1" | "R2" | "R3" | "R5";

export interface TagContext {
  /** Every tag in the vault, with the episodes it is on. The fold reads all of it: it is code, not text a model is shown. */
  inUse: ReadonlyMap<string, number>;
  aliases: ReadonlyMap<string, string>;
  /** New tags this episode may coin: 1 for a conversation, 3 while its audience is young ({@link newAllowedFor}), 0 for an import. */
  newAllowed: number;
  /** R5: a word of a qualified tag must be a tag on at least this many episodes — {@link qualifiedAtFor}. */
  qualifiedAt: number;
}

export interface Fold {
  from: string;
  into: string;
  rule: FoldRule;
}

export interface FiledTags {
  tags: string[];
  /** Tags already in use, kept as they were. */
  reused: number;
  folded: Fold[];
  /** New tags kept. */
  created: string[];
  /** Past the new-tag limit or the cap. */
  dropped: string[];
}

/** A tag's spelling with separators and an English plural folded away: `open-sources` → `opensource`. */
function stem(tag: string): string {
  const flat = tag.replace(/-/g, "");
  if (flat.length > 4 && flat.endsWith("ies")) return `${flat.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh)es$/.test(flat)) return flat.slice(0, -2);
  if (flat.length > 3 && /[^su]s$/.test(flat) && !flat.endsWith("is")) return flat.slice(0, -1);
  return flat;
}

/**
 * Whether `a` and `b` are one edit apart — a letter changed, added or removed — anywhere but the last
 * letter. An edit there is far more often another word than a typo: `router` and `routes`, `photos`
 * and `photon`. A plural there is R1's.
 */
function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i >= Math.min(a.length, b.length) - (a.length === b.length ? 1 : 0)) return false;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** The most used of some tags; the first in sort order on a tie, so the answer never depends on map order. */
function mostUsed(tags: readonly string[], inUse: ReadonlyMap<string, number>): string | undefined {
  return [...tags].sort((a, b) => (inUse.get(b) ?? 0) - (inUse.get(a) ?? 0) || a.localeCompare(b))[0];
}

/** What may follow a word for the longer tag to be the same word: `blog` → `blogging`, `photo` → `photography`. */
const DERIVED = /^(?:([b-df-hj-np-tv-z])\1?)?(?:ing|ings|er|ers|ed|ion|ions|ation|ations|ment|ments|ist|ists|ism|graphy|ography|ics)$/;

/**
 * The tag in use `tag` should become, when the match is certain — or null.
 *
 * - **R1 same word**: equal once separators and English plurals are folded (`reminders` → `reminder`).
 * - **R2 typo**: one edit apart and not at the last letter, same first letter, both 6+ letters, the other
 *   on 3+ episodes (`kubernets` → `kubernetes`; `routes` is not `router`).
 * - **R3 short form**: one word of 4+ letters that a one-word tag in use extends by an English suffix
 *   (`blog` → `blogging`). Only a suffix: `home` is not `homelab`, and `book` is not `bookkeeping`.
 * - **R5 qualified**, only when `qualified` is asked for: two or more words, exactly one of which is a
 *   tag on `qualifiedAt`+ episodes (`architecture-review` → `architecture`). Not certain — `home-assistant`
 *   is a product, not `home` — so the nightly pass folds by it only for an import, whose alternative is
 *   dropping the tag, and the tidy offers it for a person to tick.
 *
 * R4 — a compound of two tags in use, `homelab-architecture` — is never folded: the compound may be the
 * subject itself, and splitting it would invent links. The new-tag limit bounds it instead.
 *
 * `accept` narrows the tags it may fold into — the tidy's "only into a more used tag" — so a rule that
 * matches a tag it may not use does not hide a later rule that matches one it may. `rules` narrows the
 * rules tried: the tidy asks for R5 alone in a round of its own.
 */
export function foldTag(
  tag: string,
  ctx: Pick<TagContext, "inUse" | "qualifiedAt">,
  options: { qualified?: boolean; accept?: (known: string) => boolean; rules?: readonly FoldRule[] } = {},
): Fold | null {
  const accept = options.accept ?? (() => true);
  const tries = (rule: FoldRule) => options.rules?.includes(rule) ?? true;
  const others = [...ctx.inUse.keys()].filter((known) => known !== tag && accept(known));
  const count = (known: string) => ctx.inUse.get(known) ?? 0;

  const key = stem(tag);
  const same = tries("R1") ? mostUsed(others.filter((known) => stem(known) === key), ctx.inUse) : undefined;
  if (same) return { from: tag, into: same, rule: "R1" };

  if (tries("R2") && tag.length >= 6) {
    const typo = mostUsed(others.filter((known) => known.length >= 6 && known[0] === tag[0] && count(known) >= 3 && oneEdit(known, tag)), ctx.inUse);
    if (typo) return { from: tag, into: typo, rule: "R2" };
  }

  if (tries("R3") && !tag.includes("-") && tag.length >= 4) {
    const longer = mostUsed(others.filter((known) => !known.includes("-") && known.startsWith(tag) && DERIVED.test(known.slice(tag.length))), ctx.inUse);
    if (longer) return { from: tag, into: longer, rule: "R3" };
  }

  const words = tag.split("-");
  if (tries("R5") && options.qualified && words.length >= 2) {
    const big = [...new Set(words)].filter((word) => word !== tag && count(word) >= ctx.qualifiedAt && accept(word));
    if (big.length === 1) return { from: tag, into: big[0]!, rule: "R5" };
  }
  return null;
}

/**
 * What an episode is tagged with, from whatever a writer proposed. The only way a tag reaches an episode.
 *
 * 1. Normalized (spelling, stop words, aliases) and de-duplicated.
 * 2. A tag not in use is folded into one that is, where {@link foldTag} is certain.
 * 3. Tags in use first, in the order proposed; then new ones, up to `newAllowed`.
 * 4. Never empty: when nothing survives, the first normalized tag is kept — an episode with no tag at
 *    all is the one thing worse than a new one.
 * 5. At most {@link MAX_TAGS}.
 *
 * Idempotent: filing what it returned, in the same context, returns the same.
 */
export function fileTags(raw: readonly string[], ctx: TagContext): FiledTags {
  const normalized = normalizeTags(raw, ctx.aliases);
  const folded: Fold[] = [];
  const known: string[] = [];
  const fresh: string[] = [];
  for (const tag of normalized) {
    if (ctx.inUse.has(tag)) {
      if (!known.includes(tag)) known.push(tag);
      continue;
    }
    // R5 only where the alternative is dropping the tag: an import may coin nothing.
    const fold = foldTag(tag, ctx, { qualified: ctx.newAllowed === 0 });
    if (fold) {
      folded.push(fold);
      if (!known.includes(fold.into)) known.push(fold.into);
    } else if (!fresh.includes(tag)) fresh.push(tag);
  }

  let kept = [...known, ...fresh.slice(0, Math.max(0, ctx.newAllowed))];
  if (kept.length === 0 && normalized.length > 0) kept = [normalized[0]!];
  const tags = kept.slice(0, MAX_TAGS);
  return {
    tags,
    reused: tags.filter((tag) => normalized.includes(tag) && ctx.inUse.has(tag)).length,
    folded: folded.filter((fold) => tags.includes(fold.into)),
    created: tags.filter((tag) => !ctx.inUse.has(tag)),
    dropped: [...known, ...fresh].filter((tag) => !tags.includes(tag)),
  };
}

/** R5's bar: a tag on 5 episodes, or on 1% of the tagged ones — whichever is more. */
export function qualifiedAtFor(taggedEpisodes: number): number {
  return Math.max(5, Math.ceil(taggedEpisodes / 100));
}

/**
 * How many new tags a conversation may coin: 3 for an audience's first 20 tagged conversations, then 1.
 *
 * Counted in conversations, not in tags shared: a model that never reuses a tag never makes one
 * shared, and would keep an audience young — and coining three a time — forever.
 */
export function newAllowedFor(taggedInAudience: number): number {
  return taggedInAudience < 20 ? 3 : 1;
}

/** What the nightly pass shows a model as the tags to choose from. */
export interface Vocabulary {
  tags: string[];
  /** Of them, the tags this audience has on two or more episodes. */
  shared: number;
  /** Conversations in this audience with a tag at all — {@link newAllowedFor} reads it. */
  tagged: number;
}

/** How long a once-used tag stays in the vocabulary: young enough to be a vault's growing one, not an old import's leftover. */
const RECENT_MS = 30 * 86_400_000;
/** Characters of tags shown, about 1,000 tokens. The production box's whole shared vocabulary is 2,254. */
const VOCABULARY_CHARS = 4_000;

/**
 * The vocabulary for one audience: every tag it has on 2+ episodes, most used first, then tags used
 * once in the last 30 days, newest first — within {@link VOCABULARY_CHARS}.
 *
 * Old once-used tags are left out on purpose: they are the noise a tidy removes, and listing them
 * invites reuse of exactly those. Recent ones stay, or a young vault — where every tag is still used
 * once — would show its model nothing, and get yesterday's tags coined again under new names.
 */
export function vocabularyOf(use: readonly { tag: string; n: number; last: number }[], now: number, tagged = 0): Vocabulary {
  const shared = use.filter((row) => row.n >= 2).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
  const recent = use.filter((row) => row.n === 1 && row.last >= now - RECENT_MS).sort((a, b) => b.last - a.last || a.tag.localeCompare(b.tag));
  const tags: string[] = [];
  let chars = 0;
  for (const row of [...shared, ...recent]) {
    if (chars + row.tag.length + 2 > VOCABULARY_CHARS) break;
    tags.push(row.tag);
    chars += row.tag.length + 2;
  }
  return { tags, shared: shared.length, tagged };
}
