/**
 * Changes the nightly pass wants and a person decides — `docs/SPEC.md` §12.2.
 *
 * Proposed, never applied on the pass's own say: anything for `shared.md` (every agent reads it, in
 * every chat); and with `[memory] facts = "ask"`, everything. Proposals still waiting from `ask` are
 * applied by the next pass once the setting is back on `auto` (`applyWaiting`).
 *
 * One proposal per change, however many nights raise it. Watched on the live box on 2026-09-26: six
 * conversations each proposed a rewrite of the same fact, every one carrying something the others
 * did not, and approving one made the other five stale. So the pass is shown the change already
 * waiting on a fact and writes on top of it, and its answer *revises* that proposal — same id, one
 * decision — rather than queueing a second. The same addition proposed twice is kept once.
 *
 * One JSON file each under `.proposals/`, hidden from the graph. A proposal names the fact it would
 * change by its text, not its number: numbers move when anything above them is edited, and approving
 * Monday's proposal must not remove whatever line sits at that number on Tuesday.
 *
 * Read back through {@link isProposal}, never cast: the folder is in a vault people edit and copy between
 * builds, and a file of another shape is left for a person rather than acted on.
 */

import { join, listDir, randomHex, readTextFileIfExists, removePath } from "@nouride/runtime";
import { withFileLock } from "@/commons/file-lock.ts";
import type { ChangeCause, MemoryChange } from "./changes.ts";
import { factsOf, readProfile, type FactOperation, type Provenance, type Readers } from "./profile.ts";
import { SAME_FACT, wordOverlap } from "./terms.ts";
import { isSegment, SHARED, subjectFile, type Vault } from "./vault.ts";
import { editProfile, writeSide, type ProfileWrites } from "./write.ts";

export type ProposalReason = "shared" | "review";

export interface Proposal {
  id: string;
  createdAt: number;
  /** The episode it came from — the latest, once revised. */
  episode: string;
  /** When a later conversation last revised it. */
  revisedAt?: number;
  /** A person key, or `shared`. */
  subject: string;
  operation: FactOperation;
  /** What the fact said when this was proposed, for an update or a removal. */
  current?: string;
  provenance: Provenance;
  why: ProposalReason;
}

const ID = /^[a-z0-9]{12}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A change as the pass writes one: an addition under a heading, or a fact's number with its new text, or without. */
function isOperation(value: unknown): value is FactOperation {
  if (!isObject(value)) return false;
  if (value.op === "add") return typeof value.section === "string" && typeof value.text === "string";
  if (value.op === "update") return isWhole(value.n) && typeof value.text === "string";
  return value.op === "remove" && isWhole(value.n);
}

/** Who may read what it would write: person keys, and the group chat it came from when it came from one. */
function isReaders(value: unknown): value is Readers {
  return isObject(value) && Array.isArray(value.people) && value.people.every((person) => typeof person === "string") && (value.chat === undefined || typeof value.chat === "string");
}

/**
 * A proposal as this build writes one. A file under `.proposals/` of any other shape — broken by hand, or left by a
 * build whose proposals were shaped differently — is never acted on: one with no subject would be applied to
 * `people/undefined.md`, and one with no provenance stops the nightly pass at the first conversation it bears on.
 */
export function isProposal(value: unknown): value is Proposal {
  if (!isObject(value) || !isObject(value.provenance)) return false;
  const { provenance } = value;
  return (
    typeof value.id === "string" &&
    ID.test(value.id) &&
    isTime(value.createdAt) &&
    typeof value.episode === "string" &&
    (value.revisedAt === undefined || isTime(value.revisedAt)) &&
    typeof value.subject === "string" &&
    (value.subject === SHARED || isSegment(value.subject)) &&
    isOperation(value.operation) &&
    (value.current === undefined || typeof value.current === "string") &&
    (provenance.source === undefined || typeof provenance.source === "string") &&
    isReaders(provenance.readers) &&
    (value.why === "shared" || value.why === "review")
  );
}

/** A proposal file's text as a proposal, or null when it is not one. */
function readProposal(raw: string): Proposal | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isProposal(value) ? value : null;
  } catch {
    return null;
  }
}

/** Why a proposal that is there cannot be decided, and what to do about it. */
const unreadable = (id: string) => `proposal ${id} is not one this build can read: fix or remove .proposals/${id}.json by hand`;

function proposalFile(vault: Vault, id: string): string {
  if (!ID.test(id)) throw new Error(`"${id}" is not a proposal id`);
  return join(vault.proposals, `${id}.json`);
}

/**
 * Where both may be read: a DM reader must be a reader of each, a group fact must come from the same
 * group. A revision carries what the earlier proposal said, so it may go no further than either.
 */
function narrower(a: Readers, b: Readers): Readers {
  const people = a.people.filter((person) => b.people.includes(person));
  return { people, ...(a.chat !== undefined && a.chat === b.chat ? { chat: a.chat } : {}) };
}

/**
 * Queue a change, or fold it into the one it continues.
 *
 * `revises` is the pending proposal the model was shown on this fact and wrote on top of; it is
 * rewritten in place. An addition that restates one already waiting — mostly the same words — is the
 * same fact told again: it revises that one, newest wording kept, rather than queueing a twin. Null when
 * the change is not proposed: a revision of a numbered fact whose proposal was decided meanwhile.
 */
export async function propose(
  vault: Vault,
  input: Omit<Proposal, "id" | "createdAt" | "current" | "revisedAt">,
  now: number,
  revises?: Proposal,
): Promise<{ proposal: Proposal; merged: boolean } | null> {
  const { operation } = input;
  if (!revises && operation.op === "add") {
    const twin = (await listProposals(vault)).find((pending) => pending.subject === input.subject && pending.operation.op === "add" && wordOverlap(pending.operation.text, operation.text) >= SAME_FACT);
    if (twin && twin.operation.op === "add" && wordOverlap(twin.operation.text, operation.text) === 1) return { proposal: twin, merged: true };
    if (twin) revises = twin;
  }
  if (revises) {
    /**
     * Under the proposal's lock, read again: it may have been decided since the pass read it. Written over
     * the decided proposal's id, a revision brought it back — and one approved a moment before came back as
     * a duplicate. An addition revised that way is proposed as an addition of its own. A change to a numbered
     * fact is not proposed at all: its number was read against a profile the decision has since changed, and
     * would name another line; tomorrow's pass sees the profile as it is now.
     */
    let revised: Proposal | null = null;
    await writeSide(proposalFile(vault, revises.id), (raw) => {
      const waiting = raw === null ? null : readProposal(raw);
      if (!waiting) return undefined;
      revised = { ...waiting, ...input, provenance: { ...input.provenance, readers: narrower(waiting.provenance.readers, input.provenance.readers) }, revisedAt: now };
      return `${JSON.stringify(revised, null, 2)}\n`;
    });
    if (revised) return { proposal: revised, merged: true };
    if (operation.op !== "add") return null;
    return await propose(vault, input, now);
  }
  let current: string | undefined;
  if (operation.op !== "add") {
    const n = operation.n;
    current = factsOf(readProfile((await readTextFileIfExists(subjectFile(vault, input.subject))) ?? "").body).find((fact) => fact.n === n)?.text;
  }
  const proposal: Proposal = { ...input, id: randomHex(6), createdAt: now, ...(current ? { current } : {}) };
  await writeSide(proposalFile(vault, proposal.id), () => `${JSON.stringify(proposal, null, 2)}\n`);
  return { proposal, merged: false };
}

export async function listProposals(vault: Vault): Promise<Proposal[]> {
  const out: Proposal[] = [];
  for (const entry of listDir(vault.proposals)) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const proposal = readProposal((await readTextFileIfExists(join(vault.proposals, entry.name))) ?? "");
    // A file broken by hand, or of another build's shape, is left for a person; nothing here can act on it.
    if (proposal) out.push(proposal);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export type Decision =
  | { status: "applied"; subject: string; changes: MemoryChange[] }
  | { status: "denied"; subject: string }
  | { status: "refused"; reason: string };

/**
 * Decide a proposal: read, decided and removed under its lock, which a revision takes too. Approving read the file,
 * edited the profile, then removed the file, and a revision the nightly pass wrote in between was removed with it,
 * never applied. A decision refused leaves the proposal where it is.
 */
async function decide(vault: Vault, id: string, decision: (proposal: Proposal) => Promise<Decision>): Promise<Decision> {
  const file = proposalFile(vault, id);
  return await withFileLock(file, async (): Promise<Decision> => {
    const raw = await readTextFileIfExists(file);
    if (raw === null) return { status: "refused", reason: `no proposal ${id}` };
    const proposal = readProposal(raw);
    if (!proposal) return { status: "refused", reason: unreadable(id) };
    const decided = await decision(proposal);
    if (decided.status !== "refused") removePath(file);
    return decided;
  });
}

/** Apply a proposal, if the fact it names still says what it said — and what that changed, for the record. */
export async function approveProposal(deps: ProfileWrites, id: string, cause: ChangeCause): Promise<Decision> {
  return await decide(deps.vault, id, async (proposal) => {
    const { operation } = proposal;
    const result = await editProfile(deps, proposal.subject, {
      // Named by its words, not its number: numbers move when anything above the fact is edited.
      operations: (facts) => {
        if (operation.op === "add") return [operation];
        const fact = facts.find((candidate) => candidate.text === proposal.current);
        return fact ? [{ ...operation, n: fact.n }] : { refused: "that fact has changed since this was proposed: deny it and let the next night propose again" };
      },
      provenance: proposal.provenance,
      cause,
      whole: true,
    });
    return result.status === "refused" ? { status: "refused", reason: result.reason } : { status: "applied", subject: proposal.subject, changes: result.changes };
  });
}

/** Drop a proposal. */
export async function denyProposal(vault: Vault, id: string): Promise<Decision> {
  return await decide(vault, id, async (proposal) => ({ status: "denied", subject: proposal.subject }));
}

/**
 * Apply every waiting proposal that `facts = "auto"` would not have asked about — all but `shared.md`.
 * One whose fact has changed since is left for a person, like a refused approval. How many changes it made.
 */
export async function applyWaiting(deps: ProfileWrites, auto: (subject: string) => boolean): Promise<number> {
  let changes = 0;
  for (const proposal of await listProposals(deps.vault)) {
    if (proposal.subject === SHARED || !auto(proposal.subject)) continue;
    const decision = await approveProposal(deps, proposal.id, "pass");
    if (decision.status === "applied") changes += decision.changes.length;
  }
  return changes;
}
