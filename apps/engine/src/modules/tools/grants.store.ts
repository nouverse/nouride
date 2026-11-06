/**
 * Durable exec grants — the persistence half of `allow-always`.
 *
 * `@nouride/policy` decides; this stores. The split is deliberate: the decision is a pure
 * function a test can drive exhaustively, and everything that needs a database lives here where
 * it can be exercised against a real one.
 *
 * Revocation is a tombstone, never a `DELETE`. A grant is a permission a human handed out on
 * their own machine, and "when did I approve that, and when did I take it back" is a question
 * they are entitled to be able to answer later.
 */

import { createLogger, newId, type ExecPolicySection, type Port} from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { ExecPolicy } from "@nouride/policy";
import type { AuditLog } from "@/commons/audit.store.ts";

const log = createLogger("tools.grants");

interface GrantRow {
  id: string;
  grant_key: string;
  agent_id: string;
  command_text: string;
  argv: string;
  cwd: string;
  file_sha256: string | null;
  created_at: number;
  created_by: string;
  approval_id: string | null;
  policy_snapshot: string;
  revoked_at: number | null;
  revoked_by: string | null;
  last_used_at: number | null;
  use_count: number;
}

export interface ExecGrantRecord {
  id: string;
  grantKey: string;
  agentId: string;
  commandText: string;
  argv: string[];
  cwd: string;
  fileSha256: string | null;
  createdAt: number;
  createdBy: string;
  approvalId: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
  useCount: number;
}

export interface GrantInput {
  grantKey: string;
  agentId: string;
  argv: string[];
  cwd: string;
  fileSha256?: string | undefined;
  createdBy: string;
  approvalId?: string | undefined;
  policy: ExecPolicy | ExecPolicySection;
}

export class GrantStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly audit?: AuditLog,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Live grant keys for one agent.
   *
   * Returned as a `Set` because that is what the decision layer takes, and because the caller
   * must not be tempted to match on anything other than the key.
   */
  liveKeys(agentId: string): Set<string> {
    const rows = this.db
      .prepare<{ grant_key: string }>(
        "SELECT grant_key FROM exec_grants WHERE agent_id = ? AND revoked_at IS NULL",
      )
      .all(agentId);
    return new Set(rows.map((row) => row.grant_key));
  }

  /**
   * Record a grant, or return the existing one.
   *
   * Idempotent on `(agent_id, grant_key)` among live rows: answering `allow-always` twice for the
   * same command — easy to do when the same prompt is visible in chat and in the CLI — must not
   * leave two rows that both have to be revoked separately to actually stop it.
   */
  grant(input: GrantInput): ExecGrantRecord {
    const existing = this.db
      .prepare<GrantRow>(
        `SELECT * FROM exec_grants
         WHERE agent_id = ? AND grant_key = ? AND revoked_at IS NULL LIMIT 1`,
      )
      .get(input.agentId, input.grantKey);
    if (existing) return toRecord(existing);

    const id = newId("gnt");
    const commandText = input.argv.join(" ");
    this.db
      .prepare(
        `INSERT INTO exec_grants
           (id, grant_key, agent_id, command_text, argv, cwd, file_sha256,
            created_at, created_by, approval_id, policy_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.grantKey,
        input.agentId,
        commandText,
        JSON.stringify(input.argv),
        input.cwd,
        input.fileSha256 ?? null,
        this.now(),
        input.createdBy,
        input.approvalId ?? null,
        JSON.stringify(input.policy),
      );

    this.audit?.record({
      action: "exec_grant_created",
      agentId: input.agentId,
      actor: input.createdBy,
      details: { grant: id, command: commandText, cwd: input.cwd, key: input.grantKey },
    });
    log.info("exec grant created", { grant: id, agent_id: input.agentId, command: commandText });

    return toRecord(
      this.db.prepare<GrantRow>("SELECT * FROM exec_grants WHERE id = ?").get(id) as GrantRow,
    );
  }

  /**
   * Note that a grant authorized a run.
   *
   * Cheap, and it is what makes `nouride grants list` able to distinguish a grant carrying daily
   * work from one made in a hurry six weeks ago and never used since — which is the only way an
   * operator can prune a grant list with any confidence.
   */
  touch(agentId: string, grantKey: string): void {
    this.db
      .prepare(
        `UPDATE exec_grants SET last_used_at = ?, use_count = use_count + 1
         WHERE agent_id = ? AND grant_key = ? AND revoked_at IS NULL`,
      )
      .run(this.now(), agentId, grantKey);
  }

  list(options: { agentId?: string; includeRevoked?: boolean } = {}): ExecGrantRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.agentId) {
      clauses.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (!options.includeRevoked) clauses.push("revoked_at IS NULL");

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare<GrantRow>(`SELECT * FROM exec_grants ${where} ORDER BY created_at DESC`)
      .all(...params)
      .map(toRecord);
  }

  /** Revoke by grant id. Returns false when unknown or already revoked. */
  revoke(id: string, by: string): boolean {
    const row = this.db.prepare<GrantRow>("SELECT * FROM exec_grants WHERE id = ?").get(id);
    if (!row || row.revoked_at !== null) return false;

    this.db
      .prepare("UPDATE exec_grants SET revoked_at = ?, revoked_by = ? WHERE id = ?")
      .run(this.now(), by, id);

    this.audit?.record({
      action: "exec_grant_revoked",
      agentId: row.agent_id,
      actor: by,
      details: { grant: id, command: row.command_text },
    });
    log.info("exec grant revoked", { grant: id, agent_id: row.agent_id, by });
    return true;
  }

  /**
   * Revoke every live grant for an agent, or for everything.
   *
   * The panic button: `nouride grants revoke --all`. An operator who suspects an agent has been
   * talked into something needs one command that ends every standing permission, without having
   * to read a list first.
   */
  revokeAll(by: string, agentId?: string): number {
    const targets = this.list(agentId ? { agentId } : {});
    for (const grant of targets) this.revoke(grant.id, by);
    return targets.length;
  }
}

function toRecord(row: GrantRow): ExecGrantRecord {
  return {
    id: row.id,
    grantKey: row.grant_key,
    agentId: row.agent_id,
    commandText: row.command_text,
    argv: parseArgv(row.argv),
    cwd: row.cwd,
    fileSha256: row.file_sha256,
    createdAt: row.created_at,
    createdBy: row.created_by,
    approvalId: row.approval_id,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

/**
 * A row we wrote, so this should never fail — but a corrupted column must not take the whole
 * grant list down with it, because that list is how an operator revokes things.
 */
function parseArgv(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Durable exec grants, as the daemon depends on it.
 *
 * Business logic takes this, never `GrantStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type GrantsPort = Port<GrantStore>;
