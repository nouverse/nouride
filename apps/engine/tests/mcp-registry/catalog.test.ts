/**
 * The MCP catalog as the daemon asks it (0.7.19): Nouverse keeps the copy of the official registry and its ranking
 * (`GET /mcp-catalog`); the daemon searches it, opens an entry to add it, and decides what the entry means here.
 * Driven against a catalog that answers from a script, in the shape Nouverse's does — the registry's own
 * `{ server, _meta }` items in Nouverse's response envelope.
 */

import { describe, expect, test } from "bun:test";
import { catalogAddress, CATALOG_URL, createMcpCatalog } from "@/modules/mcp-registry/index.ts";

const BASE = "https://catalog.example/mcp-catalog";
const OFFICIAL = "io.modelcontextprotocol.registry/official";
const RANKING = "tech.nouverse/catalog";

const item = (server: Record<string, unknown>, ranking: Record<string, unknown> = { pinned: null }) => ({
  server: { version: "1.0.0", description: "", ...server },
  _meta: { [OFFICIAL]: { status: "active", isLatest: true }, [RANKING]: ranking },
});

const NOTION = item(
  { name: "com.notion/mcp", title: "Notion", description: "Official Notion MCP server", websiteUrl: "https://notion.com", remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] },
  { pinned: 1, score: 110 },
);
const WEATHER = item({
  name: "io.github.acme/weather",
  version: "2.0.0",
  description: "Weather.",
  packages: [{ registryType: "npm", identifier: "@acme/weather", version: "2.0.0", environmentVariables: [{ name: "ACME_TOKEN", isSecret: true, isRequired: true }] }],
});
const PYTHON = item({ name: "io.github.acme/py", packages: [{ registryType: "pypi", identifier: "acme-py", version: "1.0.0" }] });

/** A catalog answering from a script; every address asked is kept. */
function catalogServer(options: { list?: unknown[]; total?: number; entries?: Record<string, unknown>; answer?: (url: URL) => Response | undefined } = {}) {
  const asked: URL[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    const custom = options.answer?.(url);
    if (custom) return custom;
    if (url.pathname.endsWith("/mcp-catalog")) {
      const servers = options.list ?? [];
      return Response.json({ success: true, message: "", error: null, payload: { servers, metadata: { count: servers.length, total: options.total ?? servers.length, limit: 20, offset: 0, nextOffset: null, source: "https://registry.modelcontextprotocol.io", syncedAt: "2026-10-19T02:01:02.666Z" } } });
    }
    const name = decodeURIComponent(url.pathname.slice("/mcp-catalog/servers/".length));
    const entry = options.entries?.[name];
    return entry
      ? Response.json({ success: true, message: "", error: null, payload: entry })
      : Response.json({ success: false, message: `No "${name}" in the MCP catalog`, payload: null, error: null }, { status: 404 });
  }) as unknown as typeof fetch;
  return { asked, fetch: { fetchImpl, checkUrlImpl: async () => ({ allowed: true as const }) } };
}

describe("a search", () => {
  test("asks the catalog with the words, and reads each entry as Nouride does: publisher, how it runs here, what it needs", async () => {
    const server = catalogServer({ list: [NOTION, WEATHER, PYTHON], total: 312 });
    const catalog = createMcpCatalog({ url: BASE, fetch: server.fetch, can: (command) => command === "npx" });
    const page = await catalog.search("  notion  ", 6);

    expect(server.asked[0]?.toString()).toBe(`${BASE}?limit=6&search=notion`);
    expect(page.total).toBe(312);
    expect(page.syncedAt).toBe("2026-10-19T02:01:02.666Z");
    expect(page.cards).toEqual([
      { name: "com.notion/mcp", version: "1.0.0", title: "Notion", description: "Official Notion MCP server", link: "https://notion.com", publisher: "notion.com", needs: [], runsVia: "remote", pinned: 1 },
      { name: "io.github.acme/weather", version: "2.0.0", description: "Weather.", publisher: "github.com/acme", needs: ["ACME_TOKEN"], runsVia: "npm" },
      {
        name: "io.github.acme/py",
        version: "1.0.0",
        description: "",
        publisher: "github.com/acme",
        needs: [],
        unsupported: "It needs uv, which this machine does not have. uv: `nouride pkg install pipx`, then `pipx install uv` as the service user.",
        blocked: { needs: ["uvx"], label: "needs uv" },
      },
    ]);
  });

  test("the same search again within five minutes is answered from what the last one said — differently cased or spaced too", async () => {
    let clock = 0;
    const server = catalogServer({ list: [NOTION] });
    const catalog = createMcpCatalog({ url: BASE, fetch: server.fetch, can: () => true, now: () => clock });
    await catalog.search("Notion  Pages");
    expect((await catalog.search(" notion pages ")).cards.map((card) => card.name)).toEqual(["com.notion/mcp"]);
    expect(server.asked).toHaveLength(1);
    await catalog.search("notion pages", 5);
    expect(server.asked).toHaveLength(2);
    clock = 5 * 60 * 1000;
    await catalog.search("notion pages");
    expect(server.asked).toHaveLength(3);
  });

  test("a kept search still asks the machine afresh: a runner installed meanwhile shows at once", async () => {
    let programs: string[] = [];
    const catalog = createMcpCatalog({ url: BASE, fetch: catalogServer({ list: [PYTHON] }).fetch, can: (command) => programs.includes(command) });
    expect((await catalog.search("py")).cards[0]?.blocked?.label).toBe("needs uv");
    programs = ["uvx"];
    expect((await catalog.search("py")).cards[0]).toMatchObject({ runsVia: "pypi" });
  });

  test("a search that failed is not kept: the next one asks again", async () => {
    let down = true;
    const server = catalogServer({ list: [NOTION], answer: () => (down ? new Response("{}", { status: 503 }) : undefined) });
    const catalog = createMcpCatalog({ url: BASE, fetch: server.fetch, can: () => true });
    await expect(catalog.search("notion")).rejects.toThrow("HTTP 503");
    down = false;
    expect((await catalog.search("notion")).cards).toHaveLength(1);
  });

  test("without words it asks for the catalog's own list; a limit stays within what the catalog serves", async () => {
    const server = catalogServer({ list: [NOTION] });
    const catalog = createMcpCatalog({ url: `${BASE}/`, fetch: server.fetch, can: () => true });
    await catalog.search("", 500);
    expect(server.asked[0]?.toString()).toBe(`${BASE}?limit=50`);
  });

  test("an entry Nouride cannot read is left out, not shown broken — a link that is not http(s) is not kept as one", async () => {
    const odd = item({ name: "io.github.x/evil", websiteUrl: "javascript:alert(1)", remotes: [{ type: "streamable-http", url: "https://x.example/mcp" }] });
    const catalog = createMcpCatalog({ url: BASE, fetch: catalogServer({ list: [{ server: "nope" }, item({ name: "no-slash" }), odd] }).fetch, can: () => true });
    const page = await catalog.search("x");
    expect(page.cards.map((card) => card.name)).toEqual(["io.github.x/evil"]);
    expect(page.cards[0]?.link).toBeUndefined();
  });

  test("a catalog that refuses or answers something else is an error that says so", async () => {
    // `success` decides, not whether a payload came along.
    const refusing = catalogServer({ answer: () => Response.json({ success: false, message: "Too many requests. Please retry in 30s.", payload: { servers: [] } }, { status: 200 }) });
    await expect(createMcpCatalog({ url: BASE, fetch: refusing.fetch }).search("x")).rejects.toThrow("the MCP catalog refused: Too many requests. Please retry in 30s.");
    const html = catalogServer({ answer: () => new Response("<html>") });
    await expect(createMcpCatalog({ url: BASE, fetch: html.fetch }).search("x")).rejects.toThrow("did not answer with JSON");
    const limited = catalogServer({ answer: () => new Response("{}", { status: 429 }) });
    await expect(createMcpCatalog({ url: BASE, fetch: limited.fetch }).search("x")).rejects.toThrow("HTTP 429");
  });
});

describe("an entry opened to be added", () => {
  test("is asked of the catalog by its name, comes with the form, and is kept for the next look", async () => {
    let clock = 0;
    const server = catalogServer({ entries: { "io.github.acme/weather": WEATHER } });
    const catalog = createMcpCatalog({ url: BASE, fetch: server.fetch, can: () => true, now: () => clock });

    const opened = await catalog.open("io.github.acme/weather");
    expect(server.asked.map(String)).toEqual([`${BASE}/servers/io.github.acme%2Fweather`]);
    expect(opened?.card).toMatchObject({ name: "io.github.acme/weather", publisher: "github.com/acme", runsVia: "npm", needs: ["ACME_TOKEN"] });
    expect(opened?.result).toMatchObject({ draft: { command: "npx", args: ["-y", "@acme/weather@2.0.0"], secretEnv: [{ name: "ACME_TOKEN" }] } });

    await catalog.open("io.github.acme/weather");
    expect(server.asked).toHaveLength(1);
    clock = 2 * 60 * 60 * 1000;
    await catalog.open("io.github.acme/weather");
    expect(server.asked).toHaveLength(2);
  });

  test("one a search just showed opens without asking again", async () => {
    const server = catalogServer({ list: [NOTION] });
    const catalog = createMcpCatalog({ url: BASE, fetch: server.fetch, can: () => true });
    await catalog.search("notion");
    const opened = await catalog.open("com.notion/mcp");
    expect(opened?.result).toMatchObject({ draft: { url: "https://mcp.notion.com/mcp", runsVia: "remote" } });
    expect(server.asked).toHaveLength(1);
  });

  test("a name the catalog does not hold is nothing; a catalog that does not answer is an error, not an empty form", async () => {
    const catalog = createMcpCatalog({ url: BASE, fetch: catalogServer().fetch, can: () => true });
    expect(await catalog.open("com.nope/x")).toBeUndefined();
    const down = catalogServer({ answer: () => new Response("{}", { status: 503 }) });
    await expect(createMcpCatalog({ url: BASE, fetch: down.fetch }).open("com.notion/mcp")).rejects.toThrow("HTTP 503");
  });

  test("an answer that names another entry is refused", async () => {
    const catalog = createMcpCatalog({ url: BASE, fetch: catalogServer({ entries: { "com.notion/mcp": WEATHER } }).fetch, can: () => true });
    await expect(catalog.open("com.notion/mcp")).rejects.toThrow("not an entry Nouride can read");
  });
});

describe("where the catalog is", () => {
  test("Nouverse's by default; another an operator names — which may be on their own network; none when set empty", () => {
    expect(catalogAddress({})).toEqual({ url: CATALOG_URL, chosen: false });
    expect(catalogAddress({ NOURIDE_MCP_CATALOG_URL: " http://10.0.0.5:9000/mcp-catalog " })).toEqual({ url: "http://10.0.0.5:9000/mcp-catalog", chosen: true });
    expect(catalogAddress({ NOURIDE_MCP_CATALOG_URL: "" })).toBeNull();
  });

  test("a private address is refused for Nouverse's catalog, and allowed for one the operator chose", async () => {
    const lan = "http://10.0.0.5:9000/mcp-catalog";
    const fetchImpl = (async () => Response.json({ success: true, payload: { servers: [], metadata: {} } })) as unknown as typeof fetch;
    // The real guard: 10.0.0.5 is private.
    await expect(createMcpCatalog({ url: lan, fetch: { fetchImpl } }).search("x")).rejects.toThrow("refused 10.0.0.5:9000");
    expect((await createMcpCatalog({ url: lan, fetch: { fetchImpl, allowPrivate: true } }).search("x")).cards).toEqual([]);
  });
});
