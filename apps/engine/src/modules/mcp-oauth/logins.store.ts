/**
 * What is not a secret about each remote MCP server a person logged in to (`069_baseline.sql`): where its
 * authorization server is, the client the login was made as, when the access token expires, who logged it in. The
 * tokens themselves — and a confidential client's secret — are the secret store's (`mcp-oauth/index.ts` names them).
 */

import type { SqliteDb } from "@nouride/runtime";
import type { OAuthDiscovery } from "@nouride/mcp";

export interface McpLogin {
  agentId: string;
  server: string;
  discovery: OAuthDiscovery;
  clientId: string;
  /** How the token endpoint is shown the client's secret, as its registration said; null for a public client. */
  tokenMethod: string | null;
  /** When the access token stops working, in ms; null when the server did not say. */
  expiresAt: number | null;
  scope: string | null;
  /** A dashboard account's name, or `cli`. */
  loggedInBy: string;
  loggedInAt: number;
}

interface Row {
  agent_id: string;
  server: string;
  discovery: string;
  client_id: string;
  token_method: string | null;
  expires_at: number | null;
  scope: string | null;
  logged_in_by: string;
  logged_in_at: number;
}

export class McpLoginStore {
  constructor(private readonly db: SqliteDb) {}

  get(agentId: string, server: string): McpLogin | undefined {
    const row = this.db
      .prepare<Row>(
        `SELECT agent_id, server, discovery, client_id, token_method, expires_at, scope, logged_in_by, logged_in_at
         FROM mcp_oauth WHERE agent_id = ? AND server = ?`,
      )
      .get(agentId, server);
    return row ? loginOf(row) : undefined;
  }

  /** A login made, in place of the one before it. */
  put(login: McpLogin): void {
    this.db
      .prepare(
        `INSERT INTO mcp_oauth (agent_id, server, discovery, client_id, token_method, expires_at, scope, logged_in_by, logged_in_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, server) DO UPDATE SET discovery = excluded.discovery, client_id = excluded.client_id,
           token_method = excluded.token_method, expires_at = excluded.expires_at, scope = excluded.scope,
           logged_in_by = excluded.logged_in_by, logged_in_at = excluded.logged_in_at`,
      )
      .run(login.agentId, login.server, JSON.stringify(login.discovery), login.clientId, login.tokenMethod, login.expiresAt, login.scope, login.loggedInBy, login.loggedInAt);
  }

  /** The tokens renewed: when the new access token expires, and the scope it carries. */
  renewed(agentId: string, server: string, expiresAt: number | null, scope: string | null): void {
    this.db.prepare("UPDATE mcp_oauth SET expires_at = ?, scope = ? WHERE agent_id = ? AND server = ?").run(expiresAt, scope, agentId, server);
  }

  /** A login moved to another server name: a pack's server folded into the library under a name of its own. */
  rename(agentId: string, from: string, to: string): boolean {
    return this.db.prepare("UPDATE mcp_oauth SET server = ? WHERE agent_id = ? AND server = ?").run(to, agentId, from).changes > 0;
  }

  /** Whether there was one to remove. */
  remove(agentId: string, server: string): boolean {
    return this.db.prepare("DELETE FROM mcp_oauth WHERE agent_id = ? AND server = ?").run(agentId, server).changes > 0;
  }
}

function loginOf(row: Row): McpLogin {
  return {
    agentId: row.agent_id,
    server: row.server,
    discovery: JSON.parse(row.discovery) as OAuthDiscovery,
    clientId: row.client_id,
    tokenMethod: row.token_method,
    expiresAt: row.expires_at,
    scope: row.scope,
    loggedInBy: row.logged_in_by,
    loggedInAt: row.logged_in_at,
  };
}
