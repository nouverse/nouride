/**
 * `nouride mcp-server …` — Nouride as an MCP server, for other tools (`modules/mcp-server`).
 *
 * Not `nouride mcp`, which is the other direction: the MCP servers an agent here uses. All of this is
 * an admin's on the daemon's side; a token's value is printed once, here, and kept nowhere else.
 */

import type { Client } from "@/cli/client.ts";
import { flagValue } from "@/cli/args.ts";
import { saidSaved } from "@/cli/saved.ts";
import { BOLD, DIM, GREEN, RESET, YELLOW, say, usageError, usageLines, plain } from "@/cli/ui.ts";

interface TokenView {
  id: string;
  person: string;
  agents: string[];
  scopes: string[];
  label: string;
  lastUsedAt: number | null;
  /** Absent from a daemon before 0.7.9; null never expires. */
  expiresAt?: number | null;
}

const USAGE =
  `${DIM}nouride mcp-server                  on or off, and its tokens\n` +
  `nouride mcp-server on | off\n` +
  `nouride mcp-server token create --person <key> --agents <id,id> --label <client> [--scopes memory,memory:write,personas] [--ttl <days>]\n` +
  `nouride mcp-server token list\n` +
  `nouride mcp-server token revoke <id>${RESET}`;

/** When it stops working — or that it does not, which since 0.7.9 is something somebody asked for. */
function expiry(token: TokenView): string {
  if (token.expiresAt === undefined) return "";
  if (token.expiresAt === null) return " · never expires";
  return token.expiresAt <= Date.now() ? ` · ${YELLOW}expired${RESET}${DIM}` : ` · expires ${new Date(token.expiresAt).toLocaleDateString()}`;
}

function printToken(token: TokenView): void {
  const used = token.lastUsedAt ? `used ${new Date(token.lastUsedAt).toLocaleString()}` : "never used";
  say(`${BOLD}${token.id}${RESET}  ${token.label}  ${token.person} → ${token.agents.join(", ")}  ${DIM}${token.scopes.join(" ")} · ${used}${expiry(token)}${RESET}`);
}

export async function mcpServerCommand(client: Client, args: string[]): Promise<void> {
  const [what, verb, target] = args;

  if (what === undefined) {
    const { enabled, tokens } = await client.get<{ enabled: boolean; tokens: TokenView[] }>("/mcp-server");
    say(`${BOLD}MCP server${RESET}  ${enabled ? `${GREEN}on${RESET} ${DIM}${client.baseUrl}/mcp${RESET}` : `off ${DIM}(nouride mcp-server on)${RESET}`}`);
    if (tokens.length === 0) return say(`${DIM}no tokens: nouride mcp-server token create${RESET}`);
    for (const token of tokens) printToken(token);
    return;
  }
  if (what === "on" || what === "off") {
    const answer = await client.put<{ restartRequired?: boolean }>("/mcp-server", { enabled: what === "on" });
    return saidSaved(`the MCP server is ${what} (${client.baseUrl}/mcp)`, answer);
  }
  if (what !== "token") usageError(`\`nouride mcp-server\` has no "${what}".`, plain(USAGE));

  if (verb === "create") {
    const person = flagValue(args, "--person");
    const agents = flagValue(args, "--agents")?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
    const label = flagValue(args, "--label");
    const scopes = flagValue(args, "--scopes")?.split(",").map((scope) => scope.trim()).filter(Boolean);
    // Days until it stops working: 90 when not given, 0 for never. The daemon refuses anything else.
    const ttl = flagValue(args, "--ttl");
    if (!person || agents.length === 0 || !label) usageLines(USAGE);
    if (ttl !== undefined && !/^\d+$/.test(ttl)) usageError("--ttl is a whole number of days; 0 never expires", plain(USAGE));
    const made = await client.post<{ token: TokenView; value: string; enabled: boolean }>("/mcp-server/tokens", {
      person,
      agents,
      label,
      ...(scopes ? { scopes } : {}),
      ...(ttl !== undefined ? { ttl_days: Number(ttl) } : {}),
    });
    say(`${GREEN}✓${RESET} token ${BOLD}${made.token.id}${RESET} for ${person}: ${agents.join(", ")}, ${made.token.scopes.join(" ")}${DIM}${expiry(made.token)}${RESET}`);
    say(`\n  ${BOLD}${made.value}${RESET}\n  ${DIM}Shown once. In the client: URL ${client.baseUrl}/mcp, header Authorization: Bearer <that>.${RESET}`);
    if (!made.enabled) say(`${YELLOW}!${RESET} the MCP server is off: ${DIM}nouride mcp-server on${RESET}`);
    return;
  }
  if (verb === "list") {
    const { tokens } = await client.get<{ tokens: TokenView[] }>("/mcp-server");
    if (tokens.length === 0) return say(`${DIM}no tokens${RESET}`);
    for (const token of tokens) printToken(token);
    return;
  }
  if (verb === "revoke" && target) {
    await client.del(`/mcp-server/tokens/${encodeURIComponent(target)}`);
    return say(`${GREEN}✓${RESET} token ${target} revoked`);
  }
  usageError(verb ? `\`nouride mcp-server token\` has no "${verb}"${verb === "revoke" ? " without an id" : ""}.` : "usage: nouride mcp-server token create|list|revoke", plain(USAGE));
}
