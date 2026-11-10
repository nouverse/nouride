/**
 * Where the registry's copy is offered (0.7.19): the control API the Explore tab reads, the agent's `mcp_search` — which
 * finds and links, and never adds — and the CLI's `nouride mcp search` and `nouride mcp add --from`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { linksFor } from "@/modules/web/links.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { CatalogCard, CatalogEntry, McpCatalog } from "@/modules/mcp-registry/index.ts";
import { normalizeEntry, publisherOf } from "@/modules/mcp-registry/entry.ts";
import { draftFor, routeOf, summaryOf } from "@/modules/mcp-registry/draft.ts";
import { createMcpSearchTool } from "@/modules/tools/builtins/mcp-search.ts";
import type { Client } from "@nouride/cli-kit";
import { mcp } from "../../../cli/src/commands/mcp.ts";
import { cheapPasswords } from "../helpers.ts";
import { plain } from "../cli-harness.ts";

const ENTRIES: CatalogEntry[] = [
  normalizeEntry({ name: "com.notion/mcp", version: "1.0.1", title: "Notion", description: "Official Notion MCP server", remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] })!,
  normalizeEntry({
    name: "io.github.acme/weather",
    version: "2.0.0",
    description: "Weather.",
    packages: [{ registryType: "npm", identifier: "@acme/weather", version: "2.0.0", environmentVariables: [{ name: "ACME_TOKEN", isSecret: true, isRequired: true }] }],
  })!,
  normalizeEntry({ name: "com.example/slugged", version: "1.0.0", description: "Needs a slug.", remotes: [{ type: "streamable-http", url: "https://x.example/{slug}" }] })!,
];

/** A row as the catalog shows it, made the way the real one makes it. */
const cardOf = (entry: CatalogEntry): CatalogCard => {
  const { link: _link, runs: _runs, other: _other, ...shown } = summaryOf(entry);
  const route = routeOf(summaryOf(entry), () => true);
  return { ...shown, publisher: publisherOf(entry.name), ...("runsVia" in route ? { runsVia: route.runsVia } : {}) };
};

function fakeCatalog(): McpCatalog {
  return {
    search: async (query) => {
      const cards = ENTRIES.filter((entry) => `${entry.name} ${entry.title ?? ""} ${entry.description}`.toLowerCase().includes(query.toLowerCase())).map(cardOf);
      return { cards, total: cards.length, syncedAt: "2026-10-19T02:01:02.666Z" };
    },
    open: async (name) => {
      const entry = ENTRIES.find((candidate) => candidate.name === name);
      if (name === "com.example/unreachable") throw new Error("catalog.example did not answer in time");
      return entry ? { card: cardOf(entry), result: draftFor(entry, () => true) } : undefined;
    },
  };
}

describe("the control API", () => {
  const TOKEN = "control-token-for-tests-0000000000";
  let dir = "";
  let db: SqliteDb;
  let app: Hono;
  let catalog: McpCatalog | undefined;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-catalog-routes-"));
    db = openDatabase(join(dir, "t.db"));
    await migrate(db);
    catalog = fakeCatalog();
    const users = new UserStore({ db, passwords: cheapPasswords });
    await users.create({ username: "vic", password: "viewer-password-1", role: "viewer", createdBy: "test" });
    await users.create({ username: "opal", password: "operator-password-1", role: "operator", createdBy: "test" });
    app = new Hono();
    mountControlRoutes(app, {
      ctx: { config: structuredClone(DEFAULT_CONFIG), db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
      token: TOKEN,
      audit: new AuditLog(db),
      users,
      files: {},
      registry: { get: () => undefined },
      get mcpCatalog() {
        return catalog;
      },
    } as unknown as ControlDeps);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (method: string, path: string, cookie?: string, body?: unknown) =>
    app.request(`/api/control${path}`, { method, headers: { ...(cookie ? { cookie } : { "x-nouride-token": TOKEN }), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, { clientAddress: "203.0.113.10" });
  const login = async (username: string, password: string) =>
    ((await call("POST", "/auth/login", undefined, { username, password })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  test("a search answers each entry with its publisher, how it runs here and what it asks for", async () => {
    const answer = (await (await call("GET", "/mcp/catalog?q=weather")).json()) as { entries: unknown[]; total: number; syncedAt: string };
    expect(answer.entries).toEqual([{ name: "io.github.acme/weather", version: "2.0.0", description: "Weather.", publisher: "github.com/acme", runsVia: "npm", needs: ["ACME_TOKEN"] }]);
    expect(answer.total).toBe(1);
    expect(answer.syncedAt).toBe("2026-10-19T02:01:02.666Z");
  });

  test("a catalog that does not answer is a 502 that says so; one turned off is a 501", async () => {
    catalog = { ...fakeCatalog(), search: async () => Promise.reject(new Error("HTTP 503 from catalog.example")) };
    const down = await call("GET", "/mcp/catalog?q=x");
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: string }).error).toBe("the MCP catalog did not answer: HTTP 503 from catalog.example");
    catalog = undefined;
    expect((await call("GET", "/mcp/catalog?q=x")).status).toBe(501);
    expect((await call("GET", "/mcp/catalog/entry?name=com.notion/mcp")).status).toBe(501);
  });

  test("one entry comes with the form it fills in; a name not in it is a 404, a registry that does not answer a 502", async () => {
    const answer = (await (await call("GET", `/mcp/catalog/entry?name=${encodeURIComponent("com.notion/mcp")}`)).json()) as { result: { draft: { url: string } } };
    expect(answer.result.draft.url).toBe("https://mcp.notion.com/mcp");
    expect((await call("GET", "/mcp/catalog/entry?name=com.nope/x")).status).toBe(404);
    const unreachable = await call("GET", "/mcp/catalog/entry?name=com.example/unreachable");
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { error: string }).error).toBe("the MCP catalog did not give com.example/unreachable: catalog.example did not answer in time");
  });

  test("an operator reads it, a viewer does not — and nothing here copies the registry any more", async () => {
    expect((await call("GET", "/mcp/catalog?q=x", await login("vic", "viewer-password-1"))).status).toBe(403);
    const operator = await login("opal", "operator-password-1");
    expect((await call("GET", "/mcp/catalog?q=x", operator)).status).toBe(200);
    expect((await call("POST", "/mcp/catalog/refresh", undefined, { full: true })).status).toBe(404);
  });
});

describe("mcp_search", () => {
  const ctx = { agentId: "nouva" } as ToolContext;
  test("finds, says how each runs and what it needs, and links to adding it — it adds nothing", async () => {
    const tool = createMcpSearchTool({ catalog: fakeCatalog(), linkFor: linksFor({ dashboard: () => ({ publicUrl: "https://agents.example.com/" }), hasAccount: () => true }) });
    const result = await tool.execute({ query: "weather" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("You cannot add one yourself");
    expect(result.content).toContain("runs here through npm · needs ACME_TOKEN");
    expect(result.content).toContain("add it: https://agents.example.com/dashboard/mcp?install=io.github.acme%2Fweather&agent=nouva");
    expect(tool.requiresApproval).toBe(false);
  });

  test("a server this machine cannot run says what it lacks, and how to get it", async () => {
    const blockedCard: CatalogCard = {
      name: "io.github.acme/py",
      version: "1.0.0",
      description: "Python.",
      publisher: "github.com/acme",
      needs: [],
      unsupported: "It needs uv, which this machine does not have. uv: `nouride pkg install pipx`, then `pipx install uv` as the service user.",
      blocked: { needs: ["uvx"], label: "needs uv" },
    };
    const catalog = { ...fakeCatalog(), search: async () => ({ cards: [blockedCard], total: 1, syncedAt: null }) };
    const result = await createMcpSearchTool({ catalog, linkFor: () => null }).execute({ query: "py" }, ctx);
    expect(result.content).toContain("cannot run here (needs uv): It needs uv, which this machine does not have. uv: `nouride pkg install pipx`");
  });

  test("nothing found is said; a catalog that does not answer is an error the agent can read", async () => {
    const result = await createMcpSearchTool({ catalog: fakeCatalog(), linkFor: () => null }).execute({ query: "zzz" }, ctx);
    expect(result).toMatchObject({ content: 'No MCP server in the registry matches "zzz".', isError: false });
    const down = { ...fakeCatalog(), search: async () => Promise.reject(new Error("HTTP 503 from catalog.example")) };
    const failed = await createMcpSearchTool({ catalog: down, linkFor: () => null }).execute({ query: "zzz" }, ctx);
    expect(failed).toEqual({ content: "The MCP catalog did not answer: HTTP 503 from catalog.example. Try again later.", isError: true });
  });
});

describe("the CLI", () => {
  function client() {
    const catalog = fakeCatalog();
    const posted: Record<string, unknown>[] = [];
    const get = async (path: string) => {
      const url = new URL(path, "http://x");
      if (url.pathname === "/mcp/catalog") {
        const page = await catalog.search(url.searchParams.get("q") ?? "");
        return { total: page.total + 40, syncedAt: page.syncedAt, entries: page.cards.map((entry) => ({ name: entry.name, version: entry.version, description: entry.description, publisher: "p", runsVia: "remote" })) };
      }
      const name = url.searchParams.get("name") ?? "";
      const opened = await catalog.open(name);
      return { name, result: opened?.result };
    };
    return { posted, client: { baseUrl: "http://x", get, post: async (_: string, body: Record<string, unknown>) => (posted.push(body), { ok: true, restartRequired: false }) } as unknown as Client };
  }
  const quietly = async (run: () => Promise<void>) => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
    const error = spyOn(console, "error").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await run();
    } catch (err) {
      lines.push(String(err));
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
    return lines;
  };

  test("`mcp search` lists the matches and how to add one", async () => {
    const { client: c } = client();
    const lines = await quietly(() => mcp(c, ["search", "notion"]));
    // No title: the name once.
    expect(lines[0]).toBe("com.notion/mcp v1.0.1 · by p · remote");
    expect(lines.at(-1)).toBe("1 of 41 (more words narrow it); add one: nouride mcp add --agent <id> --from <name>");
  });

  test("`mcp search` says what a server this machine cannot run lacks", async () => {
    const entries = [{ name: "io.github.acme/py", version: "1.0.0", description: "Python.", publisher: "github.com/acme", unsupported: "It needs uv.", blocked: { needs: ["uvx"], label: "needs uv" } }];
    const c = { baseUrl: "http://x", get: async () => ({ entries, total: 1, syncedAt: null }) } as unknown as Client;
    expect((await quietly(() => mcp(c, ["search", "py"])))[0]).toBe("io.github.acme/py v1.0.0 · by github.com/acme · needs uv");
  });

  test("`mcp search` with no words lists the catalog's own picks, and says when nothing matches", async () => {
    const { client: c } = client();
    expect((await quietly(() => mcp(c, ["search"]))).filter((line) => line.startsWith("com.") || line.startsWith("io."))).toHaveLength(3);
    expect(await quietly(() => mcp(c, ["search", "zzz"]))).toEqual(['nothing in the MCP catalog matches "zzz"']);
  });

  test("`mcp add --from` adds what the registry says, with the secrets it needs named", async () => {
    const { client: c, posted } = client();
    await quietly(() => mcp(c, ["add", "--agent", "nouva", "--from", "io.github.acme/weather", "--env-secret", "ACME_TOKEN=acme_token"]));
    expect(posted).toEqual([{ name: "weather", transport: "stdio", command: "npx", args: ["-y", "@acme/weather@2.0.0"], envSecrets: { ACME_TOKEN: { secret: "acme_token" } }, enable: ["nouva"] }]);
  });

  test("…refuses without a required secret, and refuses an entry that needs editing, adding nothing", async () => {
    const { client: c, posted } = client();
    expect((await quietly(() => mcp(c, ["add", "--agent", "nouva", "--from", "io.github.acme/weather"]))).join("\n")).toContain("needs ACME_TOKEN");
    expect((await quietly(() => mcp(c, ["add", "--agent", "nouva", "--from", "com.example/slugged"]))).join("\n")).toContain("Replace {slug} in the URL");
    expect(posted).toEqual([]);
  });
});

/**
 * Its add link goes where a link goes (0.8.11, `web/links.ts`): without one — no `public_url`, or a DM whose person
 * holds no dashboard account — a bare `/dashboard/mcp?…` path opened nothing from a chat. The way there, said.
 */
describe("mcp_search without a link for this chat", () => {
  test("says where to add it, in words, and holds no dashboard path", async () => {
    const result = await createMcpSearchTool({ catalog: fakeCatalog(), linkFor: () => null }).execute({ query: "weather" }, { agentId: "nouva" } as ToolContext);
    expect(result.content).toContain('add it: on the dashboard, Configure → MCP, search "io.github.acme/weather"');
    expect(result.content).not.toContain("/dashboard/");
  });
});
