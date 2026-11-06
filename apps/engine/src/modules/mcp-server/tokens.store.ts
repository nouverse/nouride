/**
 * Tokens for Nouride's MCP server (`mcp_tokens` in `069_baseline.sql`). The value is made here, shown once, and only
 * its hash kept; a request is matched by hashing what it carries.
 */

import { randomBytes, sha256Text, type SqliteDb } from "@nouride/runtime";
import type { Port } from "@nouride/shared";
import { scopesFromColumn, scopesToColumn, type Scope } from "./scopes.ts";

export interface McpToken {
  id: string;
  /** The `[[people]]` key it belongs to: memory is what this person would see. */
  person: string;
  agents: string[];
  scopes: Scope[];
  /** The client — `claude_code`, `zed` — and where its notes say they came from. */
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** When it stops working (G13); null for one that never does — every token made before 0.7.9 among them. */
  expiresAt: number | null;
}

interface Row {
  id: string;
  person: string;
  agents: string;
  scopes: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

const toToken = (row: Row): McpToken => ({
  id: row.id,
  person: row.person,
  agents: row.agents.split(",").filter(Boolean),
  scopes: scopesFromColumn(row.scopes),
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
});

const COLUMNS = "id, person, agents, scopes, label, created_at, last_used_at, expires_at";

export class McpTokenStore {
  constructor(private readonly db: SqliteDb) {}

  /**
   * A new token; `value` is the only time it exists outside the client that holds it. `expiresAt` null is one that
   * never expires, which is the caller's to choose deliberately (`--ttl 0`).
   */
  create(input: { person: string; agents: readonly string[]; scopes: readonly Scope[]; label: string; now: number; expiresAt: number | null }): { token: McpToken; value: string } {
    const id = randomBytes(6).toString("hex");
    const value = `nmcp_${randomBytes(32).toString("base64url")}`;
    const scopes = scopesToColumn(input.scopes);
    this.db
      .prepare("INSERT INTO mcp_tokens (id, token_hash, person, agents, scopes, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, sha256Text(value), input.person, input.agents.join(","), scopes, input.label, input.now, input.expiresAt);
    return {
      token: toToken({ id, person: input.person, agents: input.agents.join(","), scopes, label: input.label, created_at: input.now, last_used_at: null, expires_at: input.expiresAt }),
      value,
    };
  }

  /**
   * The live token this value is, marking it used; null for anything else — a revoked one, and since 0.7.9 one past
   * its time (G13). A token that never expired was a credential copied into an editor's settings that stayed good
   * for as long as nobody remembered to revoke it.
   */
  use(value: string, now: number): McpToken | null {
    if (!value.startsWith("nmcp_")) return null;
    const row = this.db
      .prepare<Row>(`SELECT ${COLUMNS} FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .get(sha256Text(value), now);
    if (!row) return null;
    this.db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return toToken({ ...row, last_used_at: now });
  }

  list(): McpToken[] {
    return this.db.prepare<Row>(`SELECT ${COLUMNS} FROM mcp_tokens WHERE revoked_at IS NULL ORDER BY created_at`).all().map(toToken);
  }

  revoke(id: string, now: number): boolean {
    return this.db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes > 0;
  }

  /**
   * Every live token of one person, revoked — they were removed from People. A token is resolved by its
   * person's key when it is used, so one left live answered again for whoever was given that key next.
   */
  revokeFor(person: string, now: number): string[] {
    return this.db
      .prepare<{ id: string }>("UPDATE mcp_tokens SET revoked_at = ? WHERE person = ? AND revoked_at IS NULL RETURNING id")
      .all(now, person)
      .map((row) => row.id);
  }
}

export type McpTokenPort = Port<McpTokenStore>;
