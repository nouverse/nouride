/**
 * Filing one episode — `docs/SPEC.md` §12.2.
 *
 * 1. The model is shown what this conversation's own audience may see (`pass-prompt.ts`), and asked
 *    for a summary, tags, importance, mentions and fact operations — in English, asked once more when
 *    not (`english.ts`). Its tags go through the one gate every tag does (`tags.ts:fileTags`).
 * 2. Facts are kept by §5.4, per person (`factsModeFor`): with `facts = "auto"` every addition,
 *    rewrite and removal is applied now; `"ask"` proposes each; `"off"` keeps none about them.
 *    `shared.md` always waits for a person, because it is read in every chat and a private detail
 *    promoted into it would leak into all of them — and is proposed only with `propose_shared`.
 * 3. Every fact written is stamped with this episode and its audience, so it is readable exactly where
 *    this conversation is.
 * 4. The episode is marked summarized **last**: until then it is still raw, so a crash midway means it
 *    is filed again the next night, and additions already made are skipped as duplicates.
 *
 * Which model and whether today's budget allows the call are the caller's (`boot/memory-pass.ts`);
 * this file is handed an `ask`.
 */

import { readTextFileIfExists } from "@nouride/runtime";
import type { MemorySection, Person, SystemBlock } from "@nouride/shared";
import { redact } from "@nouride/secrets";
import { audienceOf, canSeeFact, readersOf, scopeOf, type Audience } from "./access.ts";
import type { Episode } from "./episode.ts";
import { ensureStubs } from "./graph.ts";
import { fileTags, type FiledTags } from "./tags.ts";
import type { TagBook } from "./tag-book.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryStatePort } from "./memory-state.store.ts";
import { ADDS_PER_PERSON, buildPassPrompt, inEnglishPrompt, nonEnglishParts, parsePassAnswer, SHARED_MIN_IMPORTANCE, SHARED_PER_EPISODE, withoutNonEnglish, type PassAnswer, type PromptFact, type PromptPerson } from "./pass-prompt.ts";
import { factsModeFor, nameOf } from "./people.ts";
import { factsOf, readProfile, type Fact, type FactOperation, type Provenance } from "./profile.ts";
import { listProposals, propose, type Proposal } from "./proposals.ts";
import { fuse, rankByMeaning, type Semantic } from "./semantic.ts";
import { SAME_FACT, wordOverlap } from "./terms.ts";
import { SHARED, subjectFile, type Vault } from "./vault.ts";
import { changeEpisode, editProfile } from "./write.ts";

/** Related episodes kept per episode, and how far back they are looked for. */
const RELATED = 3;
const RELATED_WINDOW_MS = 90 * 86_400_000;
/** Candidates by shared people and tags, before meaning reorders them. */
const RELATED_CANDIDATES = 10;
/** Word overlap past which an addition says nothing a kept fact does not. */
const KNOWN = 0.9;
/*
 * Limits imported from `pass-prompt.ts`, so the prompt states the numbers enforced here.
 *
 * `SHARED_MIN_IMPORTANCE`, `SHARED_PER_EPISODE`: shared knowledge only from a conversation that
 * mattered, and a couple at most from any one.
 *
 * `ADDS_PER_PERSON`: new facts one conversation may add about one person. A long working session
 * otherwise turns into a work log in the profile — watched on the live box: twelve "implemented…",
 * "architected…" lines from one pass, into a profile its owner had just cut to seven facts by hand.
 * Updates and removals are not counted: keeping a fact current is the point.
 */

export interface PassDeps {
  vault: Vault;
  index: MemoryIndexPort;
  /** The run's tags: each audience's vocabulary, and the counts the gate folds against. */
  tags: TagBook;
  /** Where what the pass changed is recorded, for a person to read. */
  state: Pick<MemoryStatePort, "recordChanges">;
  config: { memory: MemorySection; people: Person[] };
  /** Ask the model, for this episode's agent; null when the call failed or the budget refused it. */
  ask: (agentId: string, prompt: { system: string | SystemBlock[]; user: string }) => Promise<string | null>;
  now: () => number;
  /** When semantic search is on: `related` also weighs how alike the summaries are. */
  semantic?: Semantic;
}

/** What the gate did with one episode's tags — summed into the pass report, so drift shows the next morning. */
export interface TagOutcome {
  reused: number;
  folded: number;
  created: string[];
  dropped: number;
  /** For a new tag, the known one the model judged nearest — the morning review offers merging into it. */
  closest?: string;
}

export type FileOutcome =
  | { status: "filed"; applied: number; proposed: number; dropped: number; tags: TagOutcome }
  /**
   * `unreachable`: the model could not be asked at all — a provider down, an account not set up, a
   * budget refusal. Not the conversation's fault, so it is not held against it: the next pass tries
   * again, however many nights it takes, instead of giving up after `max_attempts` and waiting for
   * someone to press Retry after the model was fixed.
   */
  | { status: "failed"; reason: string; unreachable: boolean }
  /** Deleted, or filed by someone else, while the model was being asked: nothing it said is kept. */
  | { status: "gone" };

/** The audience this episode's facts and prompt are held to. */
function episodeAudience(episode: Episode): Audience {
  return audienceOf({ chat: episode.chat, chatType: episode.kind === "group" ? "group" : "dm", person: episode.people[0] ?? "", present: episode.people });
}

async function profileFacts(vault: Vault, subject: string): Promise<Fact[]> {
  return factsOf(readProfile((await readTextFileIfExists(subjectFile(vault, subject))) ?? "").body);
}

/**
 * A subject's facts with the changes already waiting on them, as far as this audience may see.
 *
 * A proposal is shown only where the conversation it came from could be read, like a fact: its text
 * may carry what that conversation said. One this audience may not see is not revised either — the
 * model never read it, so an answer written without it would drop what it says.
 */
function withWaiting(subject: string, facts: Fact[], pending: readonly Proposal[], audience: Audience) {
  const visible = pending.filter((proposal) => proposal.subject === subject && canSeeFact({ readers: proposal.provenance.readers }, subject, audience));
  const revisable = new Map<number, Proposal>();
  const shown: PromptFact[] = facts.map((fact) => {
    const change = visible.find((proposal) => proposal.operation.op !== "add" && proposal.current === fact.text);
    if (!change) return fact;
    revisable.set(fact.n, change);
    return { ...fact, waiting: change.operation.op === "update" ? { op: "update", text: change.operation.text } : { op: "remove" } };
  });
  const waiting = visible.flatMap((proposal) => (proposal.operation.op === "add" ? [proposal.operation.text] : []));
  return { shown, waiting, revisable };
}

export async function fileEpisode(deps: PassDeps, episode: Episode): Promise<FileOutcome> {
  const audience = episodeAudience(episode);
  const known = deps.config.people.filter((person): person is Person & { key: string } => typeof person.key === "string");
  const keys = new Set(known.map((person) => person.key));

  // What the model may see: the participants' facts that this conversation's audience may read, with
  // the numbers their files give them, so an operation names the right line.
  const pending = await listProposals(deps.vault);
  const people: PromptPerson[] = [];
  const visible = new Map<string, Fact[]>();
  const revisable = new Map<string, Map<number, Proposal>>();
  for (const key of episode.people.filter((who) => keys.has(who))) {
    const facts = (await profileFacts(deps.vault, key)).filter((fact) => canSeeFact(fact, key, audience));
    visible.set(key, facts);
    const view = withWaiting(key, facts, pending, audience);
    revisable.set(key, view.revisable);
    people.push({ key, name: nameOf(deps.config.people, key), facts: view.shown, waiting: view.waiting });
  }
  const shared = withWaiting(SHARED, await profileFacts(deps.vault, SHARED), pending, audience);
  revisable.set(SHARED, shared.revisable);
  visible.set(SHARED, shared.shown);

  const vocabulary = deps.tags.vocabulary(scopeOf(audience));
  const prompt = buildPassPrompt({
    agents: episode.agents,
    day: episode.day,
    // `started` is local ISO time: `2026-09-25T04:59:44+07:00`.
    time: episode.started.slice(11, 16),
    kind: episode.kind,
    participants: episode.people.map((who) => nameOf(deps.config.people, who)),
    transcript: redact(episode.transcript).text,
    people,
    known: known.map((person) => ({ key: person.key, name: person.name })),
    shared: shared.shown,
    sharedWaiting: shared.waiting,
    vocabulary: vocabulary.tags,
    chatTags: deps.tags.chatTags(episode.chat),
  });

  const agent = episode.agents[0] ?? "";
  const read = (text: string | null) => (text === null ? null : parsePassAnswer(text, { known: [...keys], aliases: deps.index.aliases() }));
  const answer = await deps.ask(agent, prompt);
  let parsed = read(answer);
  if (!parsed) return answer === null ? { status: "failed", reason: "the model could not be asked", unreachable: true } : { status: "failed", reason: "the answer had no usable summary", unreachable: false };
  // Memory is English whatever the conversation was in. One more ask names what to write again; what is
  // still not English after it is not kept — a summary fails the attempt, a fact is dropped.
  const foreign = nonEnglishParts(parsed);
  if (foreign.length) {
    const again = read(await deps.ask(agent, inEnglishPrompt(prompt, answer!, foreign)));
    parsed = again && !nonEnglishParts(again).includes("summary") ? withoutNonEnglish(again) : null;
    if (!parsed) return { status: "failed", reason: "the summary was not in English, asked twice", unreachable: false };
  }
  const tags = fileTags(candidates(parsed, deps.tags), deps.tags.context(vocabulary.tagged));
  const related = await relatedTo(deps, episode, tags.tags, parsed.summary);

  /**
   * Its facts and its summary under the episode's lock, the episode read again first. The model call above
   * takes seconds to minutes, and a person may delete the conversation meanwhile — from the dashboard, or an
   * MCP client saving its session again. Its facts were written anyway, after the delete had swept the
   * profiles, and a fact outlived the conversation that justified who may read it. A delete takes the same
   * lock, so now it comes first and is seen here, or comes after and sweeps these facts with the rest.
   */
  const provenance: Provenance = { source: episode.id, readers: readersOf(episode) };
  const answered = parsed;
  const done: { facts: Applied | null } = { facts: null };
  const summarized = await changeEpisode(deps, episode.id, async (current) => {
    if (current.status !== "raw") return null;
    done.facts = await applyAnswer(deps, current, answered, { visible, revisable, provenance });
    return { ...current, status: "summarized", summary: answered.summary, tags: tags.tags, importance: answered.importance, mentions: answered.mentions.filter((key) => !current.people.includes(key)), related: [...new Set([...current.related, ...related])] };
  });
  if (!summarized || !done.facts) return { status: "gone" };
  deps.tags.record(summarized.tags);
  // A tag's stub is written on its second use: a tag one conversation has links nothing yet.
  await ensureStubs(deps.vault, summarized, (tag) => deps.tags.count(tag) >= 2);
  return { status: "filed", ...done.facts, dropped: done.facts.dropped + parsed.dropped.length, tags: tagOutcome(tags, parsed) };
}

/** What one conversation's facts came to: kept, proposed, and passed over. */
interface Applied {
  applied: number;
  proposed: number;
  dropped: number;
}

/** What the model proposed, ordered for the gate: tags in use first, then the one it called new, then the rest. */
function candidates(answer: PassAnswer, book: TagBook): string[] {
  const inUse = answer.tags.filter((tag) => book.count(tag) > 0);
  const rest = answer.tags.filter((tag) => book.count(tag) === 0);
  return [...inUse, ...(answer.newTag ? [answer.newTag.tag] : []), ...rest];
}

function tagOutcome(filed: FiledTags, answer: PassAnswer): TagOutcome {
  const closest = answer.newTag?.closest;
  return {
    reused: filed.reused,
    folded: filed.folded.length,
    created: filed.created,
    dropped: filed.dropped.length,
    ...(closest && filed.created.length ? { closest } : {}),
  };
}

/**
 * An addition that restates a fact already kept, in other words: the same fact told again. Nearly
 * the same words is nothing new; mostly the same is the newer telling of it, so it replaces that
 * fact rather than sitting beside it as a second version. Only facts the model was shown are
 * compared — a fact this conversation may not read is not its to replace.
 */
function restated(operation: FactOperation, known: readonly Fact[]): FactOperation | null {
  if (operation.op !== "add") return operation;
  let closest: { fact: Fact; overlap: number } | null = null;
  for (const fact of known) {
    const overlap = wordOverlap(fact.text, operation.text);
    if (overlap >= SAME_FACT && (!closest || overlap > closest.overlap)) closest = { fact, overlap };
  }
  if (!closest) return operation;
  return closest.overlap >= KNOWN ? null : { op: "update", n: closest.fact.n, text: operation.text };
}

async function applyAnswer(
  deps: PassDeps,
  episode: Episode,
  parsed: PassAnswer,
  context: { visible: Map<string, Fact[]>; revisable: Map<string, Map<number, Proposal>>; provenance: Provenance },
): Promise<Applied> {
  const out: Applied = { applied: 0, proposed: 0, dropped: 0 };
  const now = deps.now();
  const toApply = new Map<string, FactOperation[]>();

  const added = new Map<string, number>();
  for (const { subject, operation: said } of parsed.facts) {
    const mode = factsModeFor(deps.config, subject);
    if (mode === "off") {
      out.dropped += 1;
      continue;
    }
    if (said.op === "add") {
      const count = (added.get(subject) ?? 0) + 1;
      added.set(subject, count);
      if (count > ADDS_PER_PERSON) {
        out.dropped += 1;
        continue;
      }
    }
    const shown = context.visible.get(subject) ?? [];
    // A number is only meaningful if the model was shown that fact.
    if (said.op !== "add" && !shown.some((known) => known.n === said.n)) {
      out.dropped += 1;
      continue;
    }
    const operation = restated(said, shown);
    if (!operation) {
      out.dropped += 1;
      continue;
    }
    if (mode === "ask") {
      const revises = operation.op === "add" ? undefined : context.revisable.get(subject)?.get(operation.n);
      if (await propose(deps.vault, { episode: episode.id, subject, operation, provenance: context.provenance, why: "review" }, now, revises)) out.proposed += 1;
      else out.dropped += 1;
    } else toApply.set(subject, [...(toApply.get(subject) ?? []), operation]);
  }
  /**
   * Shared knowledge is read by every agent in every chat and waits for a person, so what reaches
   * Proposals has to be worth that — and nothing at all unless `propose_shared` is on: nothing from small talk or a question answered (importance 1-2),
   * nothing already known, at most a couple per conversation.
   */
  const sharedWorthIt = deps.config.memory.proposeShared && parsed.importance >= SHARED_MIN_IMPORTANCE ? parsed.shared.slice(0, SHARED_PER_EPISODE) : [];
  out.dropped += parsed.shared.length - sharedWorthIt.length;
  for (const proposed of sharedWorthIt) {
    const operation = restated(proposed, context.visible.get(SHARED) ?? []);
    if (!operation) {
      out.dropped += 1;
      continue;
    }
    const revises = operation.op === "add" ? undefined : context.revisable.get(SHARED)?.get(operation.n);
    if (await propose(deps.vault, { episode: episode.id, subject: SHARED, operation, provenance: context.provenance, why: "shared" }, now, revises)) out.proposed += 1;
    else out.dropped += 1;
  }

  for (const [subject, operations] of toApply) {
    // One edit per profile, the way every other writer makes one. An operation the file no longer fits is dropped, never forced.
    const written = await editProfile(deps, subject, { operations, provenance: context.provenance, cause: "pass", secondhand: !episode.people.includes(subject), name: nameOf(deps.config.people, subject) });
    out.applied += written.applied;
    out.dropped += written.rejected;
  }
  return out;
}

/**
 * The episodes this one continues: shared people and tags in the last 90 days, the closest few —
 * `docs/SPEC.md` §12.2. With semantic search on, how alike the summaries are is fused in
 * (RRF), so of two candidates sharing as much, the one about the same thing wins. The candidates are
 * the same either way: meaning reorders, it never adds an episode sharing no person or tag. A failed
 * embed keeps the order by what is shared.
 */
async function relatedTo(deps: Pick<PassDeps, "index" | "semantic">, episode: Episode, tags: readonly string[], summary: string): Promise<string[]> {
  const since = Date.parse(episode.started) - RELATED_WINDOW_MS;
  const byShared = deps.index
    .neighbours({ id: episode.id, people: episode.people, tags, since: Number.isFinite(since) ? since : 0 }, RELATED_CANDIDATES)
    .map((neighbour) => neighbour.id);
  const byMeaning = deps.semantic && byShared.length > 1 ? ((await rankByMeaning(deps.semantic, summary, byShared))?.map((hit) => hit.item) ?? []) : [];
  if (byMeaning.length === 0) return byShared.slice(0, RELATED);
  return [...fuse([byShared, byMeaning])].sort((a, b) => b[1] - a[1]).slice(0, RELATED).map(([id]) => id);
}
