/**
 * Nouride as an MCP server, end to end: Nouride's own MCP client, over real HTTP, against `/mcp` — a
 * token that belongs to a person sees what that person would see talking to the agents it names,
 * only as far as its scopes reach, and nothing more.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { serveHttp, type HttpServer } from "@nouride/runtime";
import { McpClient, streamableHttpTransport } from "@nouride/mcp";
import type { LoadedAgent, Tool } from "@nouride/shared";
import { DEFAULT_SCOPES, type Scope } from "@/modules/mcp-server/scopes.ts";
import { createSurface } from "@/modules/mcp-server/surface.ts";
import { McpTokenStore } from "@/modules/mcp-server/tokens.store.ts";
import { createMemoryReadTool } from "@/modules/tools/builtins/memory.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { createMemoryAnalyzeTool } from "@/modules/tools/builtins/memory-analyze.ts";
import { mountMcp } from "@/modules/web/mcp/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { audited } from "@/modules/tools/audited.ts";
import { registerMcpServerRoutes } from "@/modules/web/control/routes/mcp-server.ts";
import { GADING_DM, SAM_DM, at, household, scripted, type Household } from "../memory/fixture.ts";

let h: Household;
let tokens: McpTokenStore;
const serverConfig = { mcpServer: { enabled: true } };
let server: HttpServer;
let url: string;
let audit: AuditLog;
let tools: Map<string, Tool>;

const agent = (id: string) =>
  ({
    config: { id },
    dir: `/tmp/${id}`,
    persona: { identity: `I am ${id}.`, soul: "Calm and direct.", agents: "Nero does infra.", memory: "Agent notes." },
  }) as unknown as LoadedAgent;

beforeEach(async () => {
  h = await household();
  serverConfig.mcpServer = { enabled: true };
  h.dm(GADING_DM, "nouva", "Rencana ke Bali Desember", "Oke.", at(9));
  h.dm({ ...GADING_DM, gatewayId: "telegram:nix" }, "nix", "Bali lagi ya", "Siap.", at(10));
  h.dm(SAM_DM, "nix", "Resep rendang", "Ini.", at(11));
  await h.memory.pass(
    scripted([
      { when: "Desember", answer: { summary: "Gading plans a trip to Bali in December.", tags: ["bali"] } },
      { when: "Bali lagi", answer: { summary: "Nix hears about Bali.", tags: ["bali"] } },
      { when: "rendang", answer: { summary: "Sam minta resep rendang." } },
    ]).ask,
  );
  tokens = new McpTokenStore(h.db);

  // Audited as the daemon's are: `buildTools` wraps every built-in before the surface is handed them.
  audit = new AuditLog(h.db, () => 1);
  tools = new Map<string, Tool>([
    ["memory_search", audited("memory_search", createMemorySearchTool(h.memory), audit)],
    ["memory_read", audited("memory_read", createMemoryReadTool(h.memory), audit)],
    ["memory_analyze", audited("memory_analyze", createMemoryAnalyzeTool(h.memory), audit)],
  ]);
  const agents = new Map([["nouva", agent("nouva")], ["nix", agent("nix")]]);
  const app = new Hono();
  mountMcp(app, { config: serverConfig, tokens, version: "0.6.0", surface: createSurface({ memory: h.memory, tools, agents: { get: (id) => agents.get(id) } }) });
  server = serveHttp({ port: 0, hostname: "127.0.0.1", fetch: (request) => app.fetch(request) });
  url = `http://127.0.0.1:${server.port}/mcp`;
});

afterEach(async () => {
  await server.stop(true);
  h.close();
});

const make = (person: string, scopes: readonly Scope[] = DEFAULT_SCOPES, agents = ["nouva"]) => tokens.create({ person, agents, scopes, label: "zed", now: 1, expiresAt: null }).value;

async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

function client(token: string): McpClient {
  return new McpClient({ name: "nouride-memory", transport: streamableHttpTransport({ url, headers: { authorization: `Bearer ${token}` } }) });
}

describe("what a call through it leaves behind", () => {
  test("a tool_exec row like any other, with no turn — and nothing on a turn's event stream", async () => {
    const hit = await rpc(make("gading"), "tools/call", { name: "memory_search", arguments: { query: "bali" } });
    expect(hit.error).toBeUndefined();
    audit.flush();
    const rows = h.db.prepare<{ action: string; turn_id: string | null; details: string }>("SELECT action, turn_id, details FROM audit_log WHERE action = 'tool_exec'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn_id: null });
    expect(JSON.parse(rows[0]!.details)).toMatchObject({ tool: "memory_search", args: { query: "bali" } });
    expect(h.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);
  });

  test("a parameter it is not offered is not taken by name either — the chat's own archive stays the chat's", async () => {
    let given: Record<string, unknown> = {};
    tools.set("memory_search", { ...tools.get("memory_search")!, execute: async (args) => ((given = args), { content: "ok", isError: false }) });
    await rpc(make("gading"), "tools/call", { name: "memory_search", arguments: { query: "bali", earlier: "1790658397401-1790662000000", path: "/etc/passwd" } });
    expect(Object.keys(given).sort()).toEqual(["agents", "query"]);
  });

  test("a tool that throws answers as an error the client can read, sanitized — no longer a JSON-RPC internal error", async () => {
    tools.set("memory_read", audited("memory_read", { ...tools.get("memory_read")!, execute: async () => { throw new Error("SQLITE_CORRUPT at /srv/nouride/.nouride/data/nouride.db"); } }, audit));
    const answer = await rpc(make("gading"), "tools/call", { name: "memory_read", arguments: { path: "people/gading.md" } });
    expect(answer.error).toBeUndefined();
    expect(answer.result).toMatchObject({ isError: true });
    const text = JSON.stringify(answer.result);
    expect(text).toContain('Tool \\"memory_read\\" failed:');
    expect(text).not.toContain("nouride.db");
  });
});

describe("the door", () => {
  test("off is absent; only POST; no token or a revoked one is a 401", async () => {
    const value = make("gading");
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    tokens.revoke(tokens.list()[0]!.id, 2);
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${value}` }, body: "{}" })).status).toBe(401);
    serverConfig.mcpServer = { enabled: false };
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("a person's every live token is revoked at once, and nobody else's", async () => {
    const gading = make("gading");
    make("gading");
    const sam = make("sam");
    expect(tokens.revokeFor("gading", 3)).toHaveLength(2);
    expect(tokens.use(gading, 4)).toBeNull();
    expect(tokens.use(sam, 4)?.person).toBe("sam");
    expect(tokens.revokeFor("gading", 5)).toEqual([]);
  });
});

describe("Gading's token, through Nouride's own MCP client", () => {
  test("connects, lists read tools and no note tool, and searches what Gading would see", async () => {
    const mcp = client(make("gading"));
    try {
      expect(await mcp.connect()).toMatchObject({ name: "nouride" });
      expect((await mcp.listTools()).map((tool) => tool.name).sort()).toEqual(["memory_analyze", "memory_read", "memory_search", "persona_read"]);
      const hit = await mcp.callTool("memory_search", { query: "bali" });
      expect(hit.isError).toBe(false);
      expect(hit.text).toContain("Gading plans a trip to Bali in December.");
      expect((await mcp.callTool("memory_read", { conversation: "2026-09-25-0900-nouva" })).text).toContain("Rencana ke Bali Desember");
      expect((await mcp.callTool("persona_read", { file: "agents" })).text).toBe("Nero does infra.");
    } finally {
      await mcp.close();
    }
  });

  test("the persona prompt and resources, every file included", async () => {
    const token = make("gading");
    expect(JSON.stringify((await rpc(token, "prompts/get", { name: "persona/nouva" })).result)).toContain("Calm and direct.");
    const resources = (await rpc(token, "resources/list")).result?.resources as { uri: string }[];
    expect(resources.map((r) => r.uri)).toContain("persona://nouva/AGENTS.md");
    // USER.md is not a persona file since 0.7.0.
    expect(resources.map((r) => r.uri)).not.toContain("persona://nouva/USER.md");
  });

  test("only the agents the token names: a wider list is cut back, another agent's conversation refused", async () => {
    const token = make("gading");
    const search = await rpc(token, "tools/call", { name: "memory_search", arguments: { query: "bali", agents: ["nouva", "nix"] } });
    expect(JSON.stringify(search.result)).toContain("a trip to Bali");
    expect(JSON.stringify(search.result)).not.toContain("Nix hears about Bali");
    expect((await rpc(token, "tools/call", { name: "memory_read", arguments: { conversation: "2026-09-25-1000-nix" } })).result).toMatchObject({ isError: true });
    expect((await rpc(token, "tools/call", { name: "memory_search", arguments: { query: "bali", agent: "nero" } })).result).toMatchObject({ isError: true });
  });

  test("a read's related list is bounded the same way: nix's conversation next to nouva's is not listed", async () => {
    const related = (token: string) => rpc(token, "tools/call", { name: "memory_read", arguments: { conversation: "2026-09-25-0900-nouva", related: true } });
    const bounded = JSON.stringify((await related(make("gading"))).result);
    expect(bounded).toContain("Rencana ke Bali Desember");
    expect(bounded).not.toContain("Nix hears about Bali");
    expect(bounded).not.toContain("2026-09-25-1000-nix");
    // A token that names nix too is shown it, so the neighbour is there to cut.
    expect(JSON.stringify((await related(make("gading", DEFAULT_SCOPES, ["nouva", "nix"]))).result)).toContain("Nix hears about Bali");
  });
});

describe("somebody else's token", () => {
  test("sees none of Gading's conversations; the agent's persona files, as the agent's own prompt has them", async () => {
    const token = make("sam", DEFAULT_SCOPES, ["nix"]);
    const search = await rpc(token, "tools/call", { name: "memory_search", arguments: { query: "bali" } });
    expect(JSON.stringify(search.result)).not.toContain("Bali");
    expect(JSON.stringify((await rpc(token, "tools/call", { name: "memory_search", arguments: { query: "rendang" } })).result)).toContain("Sam minta resep rendang.");
    const resources = (await rpc(token, "resources/list")).result?.resources as { uri: string }[];
    // Every file: MEMORY.md is in the prompt of every chat nix has, Sam's included.
    expect(resources.map((r) => r.uri).sort()).toEqual(["persona://nix/AGENTS.md", "persona://nix/IDENTITY.md", "persona://nix/MEMORY.md", "persona://nix/SOUL.md"]);
    expect((await rpc(token, "resources/read", { uri: "persona://nix/AGENTS.md" })).error).toBeUndefined();
    expect((await rpc(token, "tools/call", { name: "memory_read", arguments: {} })).result).toMatchObject({ isError: false });
    // Still not another agent's: the token names nix alone.
    expect((await rpc(token, "resources/read", { uri: "persona://nouva/AGENTS.md" })).error?.message).toBe("no such resource");
  });
});

describe("a token that may write", () => {
  const save = (token: string, args: Record<string, unknown>) => rpc(token, "tools/call", { name: "memory_save_conversation", arguments: args });
  const writer = () => make("gading", ["memory", "memory:write", "personas"]);
  const turns = [
    { role: "user", text: "Decide where the MCP server lives." },
    { role: "assistant", text: "Moved it to its own menu, Integrations, with scoped tokens." },
  ];

  test("a saved conversation is kept exactly as a chat is: the same transcript, a raw episode filed by the next pass", async () => {
    expect((await save(writer(), { turns })).result).toMatchObject({ isError: false });
    const [saved] = h.memory.episodes({ statuses: ["raw"] }, 10);
    expect(saved).toMatchObject({ chat: "mcp:zed", participants: ["gading"], agents: ["nouva"], preview: "Decide where the MCP server lives." });
    const transcript = (await h.memory.episode(saved!.id))?.episode.transcript ?? "";
    // The same lines a cut writes: `HH:MM · Name`, then the text, a blank line between turns.
    expect(transcript).toMatch(/^\d\d:\d\d · Gading\nDecide where the MCP server lives\.\n\n\d\d:\d\d · zed\nMoved it to its own menu, Integrations, with scoped tokens\.\n$/);
    expect(saved!.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-nouva$/);
    expect(await h.memory.pass(scripted([{ when: "MCP server lives", answer: { summary: "Moved the MCP server to Integrations." } }]).ask)).toMatchObject({ filed: 1 });
  });

  test("one session is one conversation, however often it is saved", async () => {
    const token = writer();
    await save(token, { turns, session: "claude-session-42" });
    const again = await save(token, { turns: [...turns, { role: "user", text: "And the recall line goes in AGENTS.md." }], session: "claude-session-42" });
    expect(JSON.stringify(again.result)).toContain("Updated");
    const kept = h.memory.episodes({ statuses: ["raw"] }, 10).filter((episode) => episode.chat === "mcp:zed:claude-session-42");
    expect(kept).toHaveLength(1);
    expect((await h.memory.episode(kept[0]!.id))?.episode.transcript).toContain("And the recall line goes in AGENTS.md.");
  });

  test("condensed or refused: a whole chat pasted, or a side missing, is sent back", async () => {
    const whole = await save(writer(), { turns: [{ role: "user", text: "x".repeat(8_000) }, { role: "assistant", text: "y".repeat(8_000) }] });
    expect(whole.result).toMatchObject({ isError: true });
    expect(JSON.stringify(whole.result)).toContain("Condense it");
    expect((await save(writer(), { turns: [{ role: "user", text: "only me" }] })).result).toMatchObject({ isError: true });
    expect((await save(writer(), { turns: "not a list" })).result).toMatchObject({ isError: true });
    expect(h.memory.episodes({ statuses: ["raw"] }, 10)).toEqual([]);
  });

  test("a read-only token may not", async () => {
    expect((await save(make("gading"), { turns })).result).toMatchObject({ isError: true });
  });
});

describe("scopes: what a token does not name is neither offered nor answered", () => {
  const names = async (token: string) => ((await rpc(token, "tools/list")).result?.tools as { name: string }[]).map((tool) => tool.name).sort();

  test("memory only: the memory tools, no persona anywhere", async () => {
    const token = make("gading", ["memory"]);
    expect(await names(token)).toEqual(["memory_analyze", "memory_read", "memory_search"]);
    expect((await rpc(token, "prompts/list")).result?.prompts).toEqual([]);
    expect((await rpc(token, "resources/list")).result?.resources).toEqual([]);
    expect((await rpc(token, "prompts/get", { name: "persona/nouva" })).error?.message).toBe("no such prompt");
    expect((await rpc(token, "resources/read", { uri: "persona://nouva/SOUL.md" })).error?.message).toBe("no such resource");
    expect((await rpc(token, "tools/call", { name: "persona_read", arguments: { file: "soul" } })).result).toMatchObject({ isError: true });
  });

  test("personas only: who the agents are, and not a word of what was said", async () => {
    const token = make("gading", ["personas"]);
    expect(await names(token)).toEqual(["persona_read"]);
    expect(JSON.stringify((await rpc(token, "prompts/get", { name: "persona/nouva" })).result)).toContain("I am nouva.");
    const search = await rpc(token, "tools/call", { name: "memory_search", arguments: { query: "bali" } });
    expect(search.result).toMatchObject({ isError: true });
    expect(JSON.stringify(search.result)).not.toContain("Bali");
    expect((await rpc(token, "tools/call", { name: "memory_read", arguments: { conversation: "2026-09-25-0900-nouva" } })).result).toMatchObject({ isError: true });
  });

  test("write only: saves conversations, reads nothing", async () => {
    const token = make("gading", ["memory:write"]);
    expect(await names(token)).toEqual(["memory_save_conversation"]);
    expect((await rpc(token, "tools/call", { name: "memory_search", arguments: { query: "bali" } })).result).toMatchObject({ isError: true });
  });

  test("the model is told what the token reaches", async () => {
    const text = JSON.stringify((await rpc(make("gading", ["personas"]), "initialize")).result);
    expect(text).toContain("who each agent is");
    expect(text).not.toContain("past conversations");
  });
});

describe("the protocol", () => {
  /**
   * What `initialize` answers (G4). It sent back whatever string a client asked for, as though agreed — `2099-01-01`
   * included — and 2024-11-05 to a client that asked for none.
   */
  test("initialize answers a version it speaks with that version, and anything else with the newest", async () => {
    const token = make("gading");
    const answered = async (protocolVersion?: unknown) => (await rpc(token, "initialize", protocolVersion === undefined ? {} : { protocolVersion })).result?.protocolVersion;
    expect(await answered("2025-06-18")).toBe("2025-06-18");
    expect(await answered("2025-03-26")).toBe("2025-03-26");
    expect(await answered("2024-11-05")).toBe("2024-11-05");
    expect(await answered("2099-01-01")).toBe("2025-06-18");
    expect(await answered(20250618)).toBe("2025-06-18");
    expect(await answered()).toBe("2025-06-18");
  });

  test("a request naming a version it does not speak in MCP-Protocol-Version is refused with 400; one it speaks, or none, is answered", async () => {
    const token = make("gading");
    const ping = (version?: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(version ? { "mcp-protocol-version": version } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    const refused = await ping("2099-01-01");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('unsupported MCP-Protocol-Version "2099-01-01"');
    expect((await ping("2025-06-18")).status).toBe(200);
    expect((await ping("2024-11-05")).status).toBe(200);
    expect((await ping()).status).toBe(200);
  });

  test("Nouride's own client agrees 2025-06-18 with it, and every call after names it", async () => {
    const mcp = client(make("gading"));
    try {
      expect((await mcp.connect()).protocolVersion).toBe("2025-06-18");
      // Refused with 400 had the header been anything this server does not speak.
      expect((await mcp.callTool("persona_read", { file: "agents" })).text).toBe("Nero does infra.");
    } finally {
      await mcp.close();
    }
  });

  test("a notification gets 202 and no body; a batch gets a batch; an unknown method its error", async () => {
    const token = make("gading");
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const note = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    const batch = await fetch(url, { method: "POST", headers, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "nope" }]) });
    const replies = (await batch.json()) as { id: number; result?: unknown; error?: { code: number } }[];
    expect(replies.map((reply) => [reply.id, reply.error?.code ?? "ok"])).toEqual([[1, "ok"], [2, -32601]]);
  });
});

describe("making tokens", () => {
  function app(role: "operator" | "admin") {
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role });
      await next();
    });
    const settings = {
      setMcpServerEnabled: async ({ enabled }: { enabled: boolean }) => {
        serverConfig.mcpServer = { enabled };
        return { ok: true, restartRequired: false };
      },
    };
    registerMcpServerRoutes(hono as never, { mcpTokens: tokens, settings, ctx: { config: { ...h.config, get mcpServer() { return serverConfig.mcpServer; } } }, registry: { get: (id: string) => (id === "nouva" ? {} : undefined) }, audit: { record: () => {} } } as never);
    return hono;
  }
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("an admin's; only for a person with a key, agents that exist, a slug label; the value once", async () => {
    expect((await app("operator").request("/mcp-server/tokens", post({ person: "gading", agents: ["nouva"], label: "zed" }))).status).toBe(403);
    expect((await app("admin").request("/mcp-server/tokens", post({ person: "tamu", agents: ["nouva"], label: "zed" }))).status).toBe(400);
    expect((await app("admin").request("/mcp-server/tokens", post({ person: "gading", agents: ["nero"], label: "zed" }))).status).toBe(400);
    expect((await app("admin").request("/mcp-server/tokens", post({ person: "gading", agents: ["nouva"], label: "Zed Editor" }))).status).toBe(400);
    const made = await app("admin").request("/mcp-server/tokens", post({ person: "gading", agents: ["nouva"], label: "zed" }));
    expect(made.status).toBe(201);
    const { value, token } = (await made.json()) as { value: string; token: { id: string } };
    expect(value).toStartWith("nmcp_");
    const listed = await (await app("admin").request("/mcp-server")).text();
    expect(listed).not.toContain(value);
    expect((await app("admin").request(`/mcp-server/tokens/${token.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app("admin").request(`/mcp-server/tokens/${token.id}`, { method: "DELETE" })).status).toBe(404);
  });

  /**
   * A token has an end (G13). One lasted until somebody revoked it — a credential pasted into an editor's settings,
   * good for as long as nobody remembered it was there.
   */
  test("lasts 90 days unless it says otherwise, 0 is never, and a token past its time no longer opens the door", async () => {
    const make = async (body: object) => {
      const response = await app("admin").request("/mcp-server/tokens", post({ person: "gading", agents: ["nouva"], label: "zed", ...body }));
      return { status: response.status, json: response.status === 201 ? ((await response.json()) as { value: string; token: { expiresAt: number | null; createdAt: number } }) : null };
    };
    const quarter = (await make({})).json!;
    expect(quarter.token.expiresAt! - quarter.token.createdAt).toBe(90 * 24 * 60 * 60 * 1000);
    expect((await make({ ttl_days: 0 })).json!.token.expiresAt).toBeNull();
    expect((await make({ ttl_days: -1 })).status).toBe(400);
    expect((await make({ ttl_days: 1.5 })).status).toBe(400);

    const week = (await make({ ttl_days: 7 })).json!;
    expect(tokens.use(week.value, week.token.expiresAt! - 1)?.id).toBeDefined();
    expect(tokens.use(week.value, week.token.expiresAt!)).toBeNull();
    // Through the door itself: the server is reached with `now`, and an expired token is told it needs one.
    const expired = tokens.create({ person: "gading", agents: ["nouva"], scopes: DEFAULT_SCOPES, label: "zed", now: 1, expiresAt: 2 }).value;
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${expired}` }, body: "{}" })).status).toBe(401);
  });

  test("scopes are named or the default; an unknown one, or none, is refused", async () => {
    const scopesOf = async (body: unknown) => {
      const response = await app("admin").request("/mcp-server/tokens", post({ person: "gading", agents: ["nouva"], label: "zed", ...(body as object) }));
      return response.status === 201 ? ((await response.json()) as { token: { scopes: string[] } }).token.scopes : response.status;
    };
    expect(await scopesOf({})).toEqual(["memory", "personas"]);
    expect(await scopesOf({ scopes: ["personas", "memory:write", "personas"] })).toEqual(["memory:write", "personas"]);
    expect(await scopesOf({ scopes: ["skills"] })).toBe(400);
    expect(await scopesOf({ scopes: [] })).toBe(400);
  });

  test("switched on and off by an admin, live", async () => {
    const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect((await app("operator").request("/mcp-server", put({ enabled: false }))).status).toBe(403);
    expect((await app("admin").request("/mcp-server", put({ enabled: "no" }))).status).toBe(400);
    expect(await (await app("admin").request("/mcp-server", put({ enabled: false }))).json()).toEqual({ enabled: false });
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(404);
  });
});
