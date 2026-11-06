/**
 * What Nouride's MCP server offers external clients — Claude Code, Zed — is an API: a parameter renamed or a
 * description reworded for the agents' prompt changes it for every client calling it, with no version to say so. Two
 * drifts shipped that way: `persona_read` said `user` after USER.md had left the persona, and `memory_read` offered
 * `earlier` and `query`, which read back the calling chat's archive and mean nothing to a client.
 *
 * So the surface is pinned in `docs/contracts/mcp-surface.json`: built the way the daemon builds it
 * (`boot/control-plane.ts` hands the surface `createBuiltinTools`' map, `memory_read` made with the turn log), for each
 * scope alone and all of them. A change is made on purpose —
 *
 *   NOURIDE_WRITE_CONTRACTS=1 bun test apps/engine/tests/contracts/mcp-surface.test.ts
 *
 * rewrites the file, and its diff is what a reviewer reads.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedAgent } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import type { Memory } from "@/modules/memory/index.ts";
import { SCOPES, type Scope } from "@/modules/mcp-server/scopes.ts";
import { createSurface } from "@/modules/mcp-server/surface.ts";
import type { McpToken } from "@/modules/mcp-server/tokens.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";

const CONTRACT = join(import.meta.dir, "../../../../docs/contracts/mcp-surface.json");

function surfaceAsServed() {
  const memory = {} as Memory;
  const tools = createBuiltinTools({
    security: structuredClone(DEFAULT_CONFIG).security,
    memory,
    earlierTurns: { between: () => [], timezone: "UTC" },
  });
  const agents = new Map(["nouva", "nix"].map((id) => [id, { config: { id }, dir: `/tmp/${id}`, persona: {} } as unknown as LoadedAgent]));
  return createSurface({ memory, tools, agents: { get: (id) => agents.get(id) } });
}

const token = (scopes: Scope[]): McpToken => ({ id: "tok", person: "gading", agents: ["nouva", "nix"], scopes, label: "zed", createdAt: 1, lastUsedAt: null, expiresAt: null });

/** What each set of scopes is offered: every scope alone, then all of them. */
function served(): Record<string, unknown> {
  const surface = surfaceAsServed();
  const sets: Scope[][] = [...SCOPES.map((scope) => [scope]), [...SCOPES]];
  return Object.fromEntries(sets.map((scopes) => [scopes.join(" "), { instructions: surface.instructions(token(scopes)), ...surface.offered(token(scopes)) }]));
}

describe("the MCP server's surface", () => {
  test("is what docs/contracts/mcp-surface.json says — changed only on purpose", () => {
    const now = `${JSON.stringify(served(), null, 2)}\n`;
    if (process.env.NOURIDE_WRITE_CONTRACTS === "1") writeFileSync(CONTRACT, now);
    expect(now).toBe(readFileSync(CONTRACT, "utf8"));
  });

  test("offers no parameter that reads the calling chat's own archive", () => {
    const read = (served()["memory"] as { tools: { name: string; parameters: { properties: Record<string, unknown> } }[] }).tools.find((tool) => tool.name === "memory_read")!;
    // `document` opens a knowledge section (0.8.20): the knowledge base, not the calling chat's archive.
    expect(Object.keys(read.parameters.properties).sort()).toEqual(["agent", "conversation", "document", "related"]);
  });

  test("names in persona_read's description exactly the files it can read", () => {
    const persona = (served()["personas"] as { tools: { name: string; description: string; parameters: { properties: { file: { enum: string[] } } } }[] }).tools.find((tool) => tool.name === "persona_read")!;
    expect(persona.description).toBe(`Read one of an agent's persona files: identity, soul, agents or memory.`);
    expect(persona.parameters.properties.file.enum).toEqual(["identity", "soul", "agents", "memory"]);
  });
});
