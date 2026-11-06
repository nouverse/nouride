/**
 * Durable grants for tools that are not `exec`.
 *
 * The operator asked for a third answer on a `write` prompt: yes, no, and *always*. The gate had only
 * offered two, and the code said why — a durable grant is bound to a command identity, and `write` has
 * none, so "always allow writes" is a policy change rather than an answer to one prompt.
 *
 * That reasoning was right about an *unscoped* grant and wrong to stop there. Bound to a directory, the
 * grant is no broader than the sandbox the agent is already confined to: always allow `write` inside this
 * agent's workspace, and keep asking for anywhere else. That is a bounded answer to the prompt in front
 * of them, which is what they were asking for.
 *
 * Mirrors `GrantStore` deliberately — same tombstone-not-delete rule, same audit records, same
 * `liveKeys` shape the gate consults on every call.
 */

import { createLogger, newId, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { AuditLog } from "@/commons/audit.store.ts";

const log = createLogger("tools.grants");

interface ToolGrantRow {
  id: string;
  grant_key: string;
  agent_id: string;
  tool: string;
  scope_dir: string;
  created_at: number;
  created_by: string;
  approval_id: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
  last_used_at: number | null;
  use_count: number;
}

export interface ToolGrantRecord {
  id: string;
  grantKey: string;
  agentId: string;
  tool: string;
  scopeDir: string;
  createdAt: number;
  createdBy: string;
  approvalId: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
  useCount: number;
}

function toRecord(row: ToolGrantRow): ToolGrantRecord {
  return {
    id: row.id,
    grantKey: row.grant_key,
    agentId: row.agent_id,
    tool: row.tool,
    scopeDir: row.scope_dir,
    createdAt: row.created_at,
    createdBy: row.created_by,
    approvalId: row.approval_id,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

export interface ToolGrantStoreOptions {
  db: SqliteDb;
  audit?: AuditLog;
  now?: () => number;
}

export class ToolGrantStore {
  constructor(private options: ToolGrantStoreOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Record a grant, or return the live one that already covers this key.
   *
   * Idempotent because two approvals for the same scope can be answered `always` in quick succession —
   * the second must not fail on the unique index, and must not create a duplicate the operator then has
   * to revoke twice.
   */
  grant(input: {
    grantKey: string;
    agentId: string;
    tool: string;
    scopeDir: string;
    createdBy: string;
    approvalId?: string;
  }): ToolGrantRecord {
    const existing = this.find(input.grantKey);
    if (existing) return existing;

    const id = newId("tgr");
    const createdAt = this.now();
    this.options.db
      .prepare(
        `INSERT INTO tool_grants (id, grant_key, agent_id, tool, scope_dir, created_at, created_by,
                                  approval_id, use_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        input.grantKey,
        input.agentId,
        input.tool,
        input.scopeDir,
        createdAt,
        input.createdBy,
        input.approvalId ?? null,
      );

    log.info("tool grant recorded", {
      grant: id,
      agent_id: input.agentId,
      tool: input.tool,
      scope: input.scopeDir,
    });
    this.options.audit?.record({
      action: "tool_grant_created",
      agentId: input.agentId,
      actor: input.createdBy,
      details: { tool: input.tool, scope_dir: input.scopeDir, grant: id },
    });

    return this.find(input.grantKey)!;
  }

  /** The live grant for a key, or null. */
  find(grantKey: string): ToolGrantRecord | null {
    const row = this.options.db
      .prepare<ToolGrantRow>(`SELECT * FROM tool_grants WHERE grant_key = ? AND revoked_at IS NULL`)
      .get(grantKey);
    return row ? toRecord(row) : null;
  }

  /**
   * Every live grant key for one agent.
   *
   * A set of keys rather than records: the gate has a key in hand and asks one question of it, and
   * handing the gate full records would invite it to make decisions from fields the key already encodes.
   */
  liveKeys(agentId: string): Set<string> {
    const rows = this.options.db
      .prepare<{ grant_key: string }>(
        `SELECT grant_key FROM tool_grants WHERE agent_id = ? AND revoked_at IS NULL`,
      )
      .all(agentId);
    return new Set(rows.map((r) => r.grant_key));
  }

  /** Everything, live and revoked, newest first — the operator's view. */
  list(agentId?: string): ToolGrantRecord[] {
    const rows = agentId
      ? this.options.db
          .prepare<ToolGrantRow>(`SELECT * FROM tool_grants WHERE agent_id = ? ORDER BY created_at DESC`)
          .all(agentId)
      : this.options.db
          .prepare<ToolGrantRow>(`SELECT * FROM tool_grants ORDER BY created_at DESC`)
          .all();
    return rows.map(toRecord);
  }

  /** Tombstone, never a delete. False when there was no live grant to revoke. */
  revoke(grantKey: string, by: string): boolean {
    const existing = this.find(grantKey);
    if (!existing) return false;

    this.options.db
      .prepare(`UPDATE tool_grants SET revoked_at = ?, revoked_by = ? WHERE id = ?`)
      .run(this.now(), by, existing.id);

    log.info("tool grant revoked", { grant: existing.id, by });
    this.options.audit?.record({
      action: "tool_grant_revoked",
      agentId: existing.agentId,
      actor: by,
      details: { tool: existing.tool, scope_dir: existing.scopeDir, grant: existing.id },
    });
    return true;
  }

  /**
   * Note that a grant was used.
   *
   * Best-effort and never on the caller's critical path: a grant that has stopped recording its use
   * count is a worse audit trail, while a tool call that fails because the counter could not be written
   * is a broken agent.
   */
  touch(grantKey: string): void {
    try {
      this.options.db
        .prepare(
          `UPDATE tool_grants SET last_used_at = ?, use_count = use_count + 1
           WHERE grant_key = ? AND revoked_at IS NULL`,
        )
        .run(this.now(), grantKey);
    } catch (err) {
      log.warn("could not record tool grant use", { error: String(err) });
    }
  }
}

/**
 * Durable per-tool grants, as the daemon depends on it.
 *
 * Business logic takes this, never `ToolGrantStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type ToolGrantsPort = Port<ToolGrantStore>;
