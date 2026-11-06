/**
 * Where a remote MCP server's login goes: the names its tokens are kept under, the address the browser comes back to,
 * the link a person is sent to log in — and what the browser came back with.
 */

import { assertSecretName } from "@nouride/secrets";
import type { McpServerConfig } from "@nouride/shared";
import { publicBase } from "@/modules/web/links.ts";

/** `[dashboard]`, as far as a login needs it. */
export interface DashboardAddress {
  publicUrl: string;
  port: number;
}

/** The secret store's names for a server's login, or null when they would not fit its 63 characters. */
export function loginSecrets(agentId: string, server: string): { access: string; refresh: string; client: string } | null {
  const base = `mcp-oauth-${agentId}-${server}`;
  const names = { access: `${base}-access`, refresh: `${base}-refresh`, client: `${base}-client` };
  try {
    for (const name of Object.values(names)) assertSecretName(name, "an MCP login's secret");
    return names;
  } catch {
    return null;
  }
}

/**
 * Whether a server brings a credential of its own — `auth_secret`, or an `Authorization` header written in the pack.
 * Such a server is reached as it always was; one without is tried with none, and a 401 says it wants a login.
 */
export function hasOwnCredential(config: McpServerConfig): boolean {
  return Boolean(config.authSecret) || Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

/**
 * Where the authorization server sends the browser back: the dashboard's callback page at its public address, or on
 * this machine's loopback (RFC 8252) — which reaches the daemon when the browser runs here, and is otherwise the
 * address a person copies back from the browser's bar.
 */
export function redirectUriFor(dashboard: DashboardAddress): string {
  const base = publicBase(dashboard) || `http://127.0.0.1:${dashboard.port}`;
  return `${base}/dashboard/oauth/mcp/callback`;
}

/**
 * Where a person logs a login in: the library's on Configure → MCP, an agent's own on that agent's MCP tab —
 * and the command for a terminal.
 */
export function loginLinkFor(dashboard: DashboardAddress, holder: string, server: string): string {
  const base = publicBase(dashboard) || `http://127.0.0.1:${dashboard.port}`;
  if (holder === "shared") return `${base}/dashboard/mcp (or \`nouride mcp login --server ${server}\`)`;
  return `${base}/dashboard/agents/${encodeURIComponent(holder)}/mcp (or \`nouride mcp login --server ${server} --agent ${holder}\`)`;
}

/**
 * The `code` and `state` a login came back with: given as such, or as the address the browser ended on — the
 * authorization server's refusal, when that is what the address says.
 */
export function redirectAnswer(input: { code?: unknown; state?: unknown; url?: unknown }): { code: string; state: string } | { error: string; state?: string } {
  let params: URLSearchParams;
  if (typeof input.url === "string" && input.url.trim()) {
    const pasted = input.url.trim();
    if (!URL.canParse(pasted)) return { error: "that is not the address the browser ended on. Copy the whole of it, from the address bar" };
    params = new URL(pasted).searchParams;
  } else {
    params = new URLSearchParams();
    if (typeof input.code === "string") params.set("code", input.code);
    if (typeof input.state === "string") params.set("state", input.state);
  }
  const state = params.get("state") ?? undefined;
  const refused = params.get("error");
  if (refused) {
    const why = (params.get("error_description") ?? "").slice(0, 300);
    return { error: `the login was not given: ${refused}${why ? ` (${why})` : ""}`, ...(state ? { state } : {}) };
  }
  const code = params.get("code");
  if (!code || !state) return { error: "the address carries no code and state. Copy the one the browser ended on after the login, whole" };
  return { code, state };
}
