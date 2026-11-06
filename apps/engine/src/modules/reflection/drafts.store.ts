/**
 * Where a draft waits — the one piece of RSI that is genuinely new state.
 *
 * The table it owns is `skill_drafts`, and the rule that shapes every method here is the one the
 * migration explains: a draft **never expires**. There is no TTL, no sweep of pending rows, and no
 * "stale" status. A proposal that quietly disappeared overnight is worse than one nobody got round
 * to, because the second is visible.
 *
 * A denial is a hard delete: nothing of a refused draft stays on disk or in the database. Everything
 * else keeps its row: an approved draft is how you answer "where did this skill come from" six months
 * later, and that is half the reason the loop is supervised at all.
 *
 * `transcript` is what the synthesis pass read, already scrubbed of anything that looked like a
 * credential, and it is kept beside the draft so the person deciding can trace a procedure back to the
 * turn that produced it. Approving one you cannot trace is approving a model's word for it. (The
 * baseline migration's comment on that column calls this the Origin Trajectory Inspector, §3.4 of a
 * design note that has since been retired.)
 */

import { newId, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { DraftStatus, SkillDraft, SkillFile, TriggerKind } from "./types.ts";

interface DraftRow {
  id: string;
  created_at: number;
  agent_id: string;
  gateway_id: string | null;
  chat_id: string | null;
  session_id: string | null;
  trigger_kind: string;
  trigger_reason: string;
  name: string;
  description: string;
  requires: string;
  needs_tools: string | null;
  body: string;
  transcript: string | null;
  model: string | null;
  status: string;
  decided_at: number | null;
  decided_by: string | null;
  published_path: string | null;
  target: string | null;
  files: string | null;
  carries: string | null;
  retire: string | null;
}

/**
 * The reason separator, and the two places that must agree on it.
 *
 * A draft's reason is `<why> · masked: api-key` — the lesson, then the bookkeeping. `lessonOf` pulls
 * the first half back out when one draft absorbs another, and putting both here is what stops them
 * drifting: the writer is in the engine, the reader was too, and a separator changed in one place
 * would have started recording "masked: api-key" as something an agent learned.
 */
export const REASON_SEPARATOR = " · ";

/** The lesson out of a reason string, without the bookkeeping that follows it. */
export function lessonOf(reason: string): string {
  return reason.split(REASON_SEPARATOR)[0]?.trim() ?? reason;
}

/** A JSON array of strings — `SkillDraft.carries`, `SkillDraft.retire`. Unreadable is none, never a throw. */
function parseStrings(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toDraft(row: DraftRow): SkillDraft {
  return {
    id: row.id,
    createdAt: row.created_at,
    agentId: row.agent_id,
    gatewayId: row.gateway_id,
    chatId: row.chat_id,
    sessionId: row.session_id,
    triggerKind: row.trigger_kind as TriggerKind,
    triggerReason: row.trigger_reason,
    name: row.name,
    description: row.description,
    requires: row.requires,
    needsTools: row.needs_tools ?? "",
    body: row.body,
    target: row.target,
    // Stored as JSON because it is a list the daemon never queries into — only reads back whole.
    // A malformed value is treated as none rather than throwing: a draft with an unreadable
    // support-file column is still a draft somebody should be able to read and discard.
    files: parseFiles(row.files),
    // Stored in the same column as the additions, under a reserved path prefix — see `NewDraft`.
    removeFiles: parseRemovals(row.files),
    retire: parseStrings(row.retire),
    /**
     * The `why` lines of the drafts this one absorbed, oldest first.
     *
     * A malformed or absent value is an empty list rather than a throw, for the same reason `files`
     * is: a draft whose history column is unreadable is still a draft somebody should be able to
     * read and decide.
     */
    carries: parseStrings(row.carries),
    transcript: row.transcript,
    model: row.model,
    status: row.status as DraftStatus,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    publishedPath: row.published_path,
  };
}

function parseFiles(raw: string | null): SkillFile[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SkillFile => typeof e === "object" && e !== null && typeof (e as SkillFile).content === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Deletions ride in the same JSON as the additions, marked by a null body.
 *
 * One column rather than a second migration: both are "what this draft does to the files beside
 * SKILL.md", they are always read together, and the daemon never queries into either.
 */
function parseRemovals(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is { path: string; content: null } =>
        typeof e === "object" && e !== null && (e as { content?: unknown }).content === null,
      )
      .map((e) => e.path);
  } catch {
    return [];
  }
}

export interface NewDraft {
  agentId: string;
  gatewayId?: string;
  chatId?: string;
  sessionId?: string;
  triggerKind: TriggerKind;
  triggerReason: string;
  name: string;
  description: string;
  requires: string;
  needsTools?: string;
  body: string;
  /** The skill being improved. Absent proposes a new one. */
  target?: string;
  /** Earlier drafts' `why` lines, oldest first — see `SkillDraft.carries`. */
  carries?: string[];
  files?: SkillFile[];
  /** Support files to delete on approval. Stored beside `files` with a null body. */
  removeFiles?: string[];
  /** Skills archived on approval — see `SkillDraft.retire`. */
  retire?: string[];
  transcript?: string;
  model?: string;
}

function serializeFiles(files: SkillFile[], removeFiles: string[]): string | null {
  const entries = [...files, ...removeFiles.map((path) => ({ path, content: null }))];
  return entries.length > 0 ? JSON.stringify(entries) : null;
}

export class DraftStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  create(draft: NewDraft): SkillDraft {
    const id = newId("dft");
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO skill_drafts
           (id, created_at, agent_id, gateway_id, chat_id, session_id,
            trigger_kind, trigger_reason, name, description, requires, needs_tools, body,
            transcript, model, target, files, carries, retire, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        createdAt,
        draft.agentId,
        draft.gatewayId ?? null,
        draft.chatId ?? null,
        draft.sessionId ?? null,
        draft.triggerKind,
        draft.triggerReason,
        draft.name,
        draft.description,
        draft.requires,
        draft.needsTools ?? null,
        draft.body,
        draft.transcript ?? null,
        draft.model ?? null,
        draft.target ?? null,
        serializeFiles(draft.files ?? [], draft.removeFiles ?? []),
        draft.carries && draft.carries.length > 0 ? JSON.stringify(draft.carries) : null,
        draft.retire && draft.retire.length > 0 ? JSON.stringify(draft.retire) : null,
      );
    return this.get(id)!;
  }

  get(id: string): SkillDraft | null {
    const row = this.db.prepare<DraftRow>("SELECT * FROM skill_drafts WHERE id = ?").get(id);
    return row ? toDraft(row) : null;
  }

  /**
   * Resolve what a person typed into one draft.
   *
   * By id, or by the skill's name when only one pending draft carries it — because the id is
   * `dft_` plus twenty-odd characters and nobody types that into Telegram correctly on the first
   * attempt. Ambiguity resolves to nothing rather than to a guess: two drafts proposing the same
   * name is exactly the case where approving the wrong one is invisible.
   */
  resolve(reference: string): SkillDraft | null {
    const byId = this.get(reference);
    if (byId) return byId;

    const named = this.db
      .prepare<DraftRow>(
        "SELECT * FROM skill_drafts WHERE status = 'pending' AND name = ? ORDER BY created_at DESC",
      )
      .all(reference);
    return named.length === 1 ? toDraft(named[0]!) : null;
  }

  pending(): SkillDraft[] {
    return this.db
      .prepare<DraftRow>("SELECT * FROM skill_drafts WHERE status = 'pending' ORDER BY created_at DESC")
      .all()
      .map(toDraft);
  }

  /** Everything, newest first — the drafts surface shows recent decisions beside the queue. */
  recent(limit = 50): SkillDraft[] {
    return this.db
      .prepare<DraftRow>("SELECT * FROM skill_drafts ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(toDraft);
  }

  pendingCount(): number {
    const row = this.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM skill_drafts WHERE status = 'pending'")
      .get();
    return row?.n ?? 0;
  }

  /** When this agent last had a draft raised, whatever became of it — the cooldown reads this. */
  lastDraftAt(agentId: string): number | null {
    const row = this.db
      .prepare<{ created_at: number }>(
        "SELECT created_at FROM skill_drafts WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(agentId);
    return row?.created_at ?? null;
  }

  /**
   * Every pending draft under one name, newest first.
   *
   * Names collide on purpose now: two sessions can each propose an improvement to the same skill and
   * both wait for a person. `resolve` refuses an ambiguous name rather than guessing, so the caller
   * needs this to tell somebody *why* their name did not resolve.
   */
  pendingAllByName(name: string): SkillDraft[] {
    return this.db
      .prepare<DraftRow>(
        "SELECT * FROM skill_drafts WHERE status = 'pending' AND name = ? ORDER BY created_at DESC",
      )
      .all(name)
      .map(toDraft);
  }

  /** A pending draft under this name, if there is one — what a new proposal for the same skill builds on. */
  pendingByName(name: string): SkillDraft | null {
    const row = this.db
      .prepare<DraftRow>("SELECT * FROM skill_drafts WHERE status = 'pending' AND name = ? LIMIT 1")
      .get(name);
    return row ? toDraft(row) : null;
  }

  markApproved(id: string, by: string, publishedPath: string): void {
    this.db
      .prepare(
        "UPDATE skill_drafts SET status = 'approved', decided_at = ?, decided_by = ?, published_path = ? WHERE id = ?",
      )
      .run(this.now(), by, publishedPath, id);
  }

  /**
   * Discard: the row goes, transcript and all.
   *
   * Hard-deleted with zero filesystem or database residue. A tombstone would keep the
   * rejected procedure and whatever its transcript quoted sitting in the operator's database
   * forever, which is not what "discard" means to the person clicking it.
   */
  deny(id: string): boolean {
    const result = this.db.prepare("DELETE FROM skill_drafts WHERE id = ?").run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Drop *decided* rows older than `days`. Pending rows are never touched.
   *
   * Runs on the daily retention sweep, on the audit knob, because that is what these are: the record
   * of a decision somebody made. `0` keeps everything, matching every other retention setting.
   */
  sweep(days: number, now: number = this.now()): number {
    if (days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60_000;
    const result = this.db
      .prepare("DELETE FROM skill_drafts WHERE status != 'pending' AND decided_at IS NOT NULL AND decided_at < ?")
      .run(cutoff);
    return Number(result.changes ?? 0);
  }
}

/**
 * Which tools an agent has already succeeded with.
 *
 * Exists so "first time it got something new working" is a fact and not a guess. In the database
 * because an in-memory set is empty after a restart — and then the first turn of every boot looks
 * like a first integration, which would make the trigger fire on `read` and discredit the whole
 * detector on day one.
 */
export class ToolMemory {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record these tool names for this agent, and return the ones that were genuinely new.
   *
   * Returns nothing while the agent is still being learned — under `warmup` distinct tools on
   * record, every tool is new, and reporting that would fire the trigger on the first few turns of a
   * fresh install for `read` and `exec`. The point of the rule is a tool appearing *after* the
   * agent's ordinary working set is established.
   */
  observe(agentId: string, names: string[], warmup = 5): string[] {
    if (names.length === 0) return [];

    const known = this.count(agentId);
    const insert = this.db.prepare(
      `INSERT INTO rsi_tool_seen (agent_id, tool_name, first_seen_at) VALUES (?, ?, ?)
       ON CONFLICT (agent_id, tool_name) DO NOTHING`,
    );
    const at = this.now();

    const fresh: string[] = [];
    this.db.transaction(() => {
      for (const name of new Set(names)) {
        const result = insert.run(agentId, name, at);
        if (Number(result.changes ?? 0) > 0) fresh.push(name);
      }
    });

    return known >= warmup ? fresh : [];
  }

  private count(agentId: string): number {
    const row = this.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM rsi_tool_seen WHERE agent_id = ?")
      .get(agentId);
    return row?.n ?? 0;
  }
}

/**
 * Skill drafts awaiting a human, as the daemon depends on it.
 *
 * Business logic takes this, never `DraftStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type DraftsPort = Port<DraftStore>;
