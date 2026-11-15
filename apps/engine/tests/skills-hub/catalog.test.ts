/**
 * Nouverse's skills catalog as the daemon asks it: Nouverse keeps the copy of the hubs' listings and their order
 * (`GET /skills-catalog`); a search with no hub named asks it, and the hubs are asked themselves when one is named,
 * when the catalog is turned off and when it does not answer. Driven against a catalog that answers from a script, in
 * the shape Nouverse's does: its own entries in Nouverse's response envelope. Then where it is offered: the control
 * API Explore reads, an agent's `skill_search`, and `nouride skills search`.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@nouride/cli-kit";
import type { ToolContext } from "@nouride/shared";
import { createSkillsCatalog, SKILLS_CATALOG_URL, skillsCatalogAddress, type SkillsCatalog } from "@/modules/skills-hub/catalog.ts";
import { SkillHub } from "@/modules/skills-hub/index.ts";
import { createSkillHubTools } from "@/modules/tools/builtins/skill-hub.ts";
import { registerSkillHubRoutes } from "@/modules/web/control/routes/skills-hub.ts";
import { skills } from "../../../cli/src/commands/skills.ts";
import { plain } from "../cli-harness.ts";

const BASE = "https://catalog.example/skills-catalog";
const RANKING = "tech.nouverse/catalog";
const SYNCED = "2026-11-15T02:01:02.666Z";

const item = (fields: Record<string, unknown>, ranking: Record<string, unknown> = { pinned: null }) => ({
  source: "clawhub",
  title: null,
  description: "",
  version: null,
  license: null,
  installs: 0,
  stars: 0,
  updatedAt: null,
  ...fields,
  _meta: { [RANKING]: ranking },
});

const PDF = item(
  { ref: "github:anthropics/skills/skills/pdf", source: "github", name: "pdf", description: "Read, fill and make   PDF files.", owner: "anthropics", url: "https://github.com/anthropics/skills/tree/main/skills/pdf", stars: 51234, license: "Apache-2.0" },
  { pinned: 1, score: 100 },
);
const LEARNER = item({
  ref: "clawhub:pskoett/self-improving-agent",
  name: "self-improving-agent",
  title: "self improving agent",
  description: "Keeps learnings.",
  owner: "pskoett",
  url: "https://clawhub.ai/pskoett/self-improving-agent",
  version: "4.0.5",
  installs: 492992,
  stars: 4020,
  updatedAt: "2026-10-20T12:00:00.000Z",
});

/** A catalog answering from a script; every address asked is kept. */
function catalogServer(options: { list?: unknown[]; total?: number; syncedAt?: string | null; answer?: (url: URL) => Response | undefined } = {}) {
  const asked: URL[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    const custom = options.answer?.(url);
    if (custom) return custom;
    const list = options.list ?? [];
    const metadata = { count: list.length, total: options.total ?? list.length, limit: 20, offset: 0, nextOffset: null, syncedAt: options.syncedAt === undefined ? SYNCED : options.syncedAt };
    return Response.json({ success: true, message: "", error: null, payload: { skills: list, metadata } });
  }) as unknown as typeof fetch;
  return { asked, fetch: { fetchImpl, checkUrlImpl: async () => ({ allowed: true as const }) } };
}

describe("a search of the catalog", () => {
  test("asks with the words, and reads each entry as a hit: its reference, where it is from, who made it, how much it is used, a pick", async () => {
    const server = catalogServer({ list: [PDF, LEARNER], total: 312 });
    const catalog = createSkillsCatalog({ url: `${BASE}/`, fetch: server.fetch });
    const page = await catalog.search("  PDF  Forms ", 24);

    expect(server.asked[0]?.toString()).toBe(`${BASE}?limit=24&search=pdf+forms`);
    expect(page.total).toBe(312);
    expect(page.syncedAt).toBe(SYNCED);
    expect(page.hits).toEqual([
      { ref: "github:anthropics/skills/skills/pdf", source: "github", name: "pdf", description: "Read, fill and make PDF files.", url: "https://github.com/anthropics/skills/tree/main/skills/pdf", stars: 51234, owner: "anthropics", pick: true },
      {
        ref: "clawhub:pskoett/self-improving-agent",
        source: "clawhub",
        name: "self-improving-agent",
        description: "Keeps learnings.",
        url: "https://clawhub.ai/pskoett/self-improving-agent",
        installs: 492992,
        stars: 4020,
        title: "self improving agent",
        owner: "pskoett",
      },
    ]);
  });

  test("without words it asks for Nouverse's own list, and a limit is held to what the catalog serves", async () => {
    const server = catalogServer({ list: [PDF] });
    const catalog = createSkillsCatalog({ url: BASE, fetch: server.fetch });
    await catalog.search("", 500);
    await catalog.search("   ", 0);
    expect(server.asked.map((url) => url.search)).toEqual(["?limit=50", "?limit=1"]);
  });

  test("where an entry is from is what its reference says, and one Nouride cannot install from or show is left out", async () => {
    const list = [
      // Says ClawHub beside a GitHub reference: the reference is what an install follows.
      item({ ref: "github:o/r/skills/x", source: "clawhub", name: "x", url: "https://github.com/o/r" }),
      // A title that only repeats the name is not said twice.
      item({ ref: "clawhub:a/same", name: "same", title: "same", url: "https://clawhub.ai/a/same" }),
      item({ ref: "skills.sh:o/r/x", name: "from a hub the catalog does not copy", url: "https://skills.sh/o/r/x" }),
      item({ ref: "well-known:https://site.example/x", name: "another", url: "https://site.example" }),
      item({ ref: "not a reference", name: "nothing", url: "https://example.com" }),
      item({ ref: `clawhub:a/${"s".repeat(300)}`, name: "long", url: "https://clawhub.ai/a/long" }),
      item({ ref: "clawhub:a/script", name: "script", url: "javascript:alert(1)" }),
      item({ ref: "clawhub:a/nameless", name: "  ", url: "https://clawhub.ai/a/nameless" }),
      item({ ref: "clawhub:a/counts", name: "counts", url: "https://clawhub.ai/a/counts", installs: -4, stars: "many" }),
      "a string",
      null,
    ];
    const catalog = createSkillsCatalog({ url: BASE, fetch: catalogServer({ list, total: 9 }).fetch });
    const { hits } = await catalog.search("x");
    expect(hits.map((hit) => [hit.ref, hit.source])).toEqual([["github:o/r/skills/x", "github"], ["clawhub:a/same", "clawhub"], ["clawhub:a/counts", "clawhub"]]);
    expect(hits[1]).not.toHaveProperty("title");
    // A count that is not one is not shown as one, and nor is a zero: a repository's skill has no installs to count.
    expect(hits[2]).not.toHaveProperty("installs");
    expect(hits[2]).not.toHaveProperty("stars");
    expect(hits[0]).not.toHaveProperty("installs");
    expect(hits.some((hit) => hit.pick)).toBe(false);
  });

  test("an answer is kept five minutes; a failure is not kept", async () => {
    let at = 1_000_000;
    let down = true;
    const server = catalogServer({ list: [PDF], answer: () => (down ? new Response("busy", { status: 503 }) : undefined) });
    const catalog = createSkillsCatalog({ url: BASE, fetch: server.fetch, now: () => at });
    await expect(catalog.search("pdf")).rejects.toThrow("HTTP 503");
    down = false;
    expect((await catalog.search("pdf")).hits).toHaveLength(1);
    at += 4 * 60_000;
    await catalog.search("PDF");
    expect(server.asked).toHaveLength(2);
    at += 61_000;
    await catalog.search("pdf");
    expect(server.asked).toHaveLength(3);
    // Other words are another question.
    await catalog.search("docx");
    expect(server.asked).toHaveLength(4);
  });

  test("a refusal is said in the catalog's words, and an answer that is not the catalog's is not read", async () => {
    const refused = createSkillsCatalog({ url: BASE, fetch: catalogServer({ answer: () => Response.json({ success: false, message: "Too many searches", payload: null, error: null }) }).fetch });
    await expect(refused.search("pdf")).rejects.toThrow("the skills catalog refused: Too many searches");
    const page = createSkillsCatalog({ url: BASE, fetch: catalogServer({ answer: () => new Response("<html>a login page</html>") }).fetch });
    await expect(page.search("pdf")).rejects.toThrow(`the skills catalog at ${BASE} did not answer with JSON`);
    // No list and no count in an answer: nothing found, not a crash.
    const bare = createSkillsCatalog({ url: BASE, fetch: catalogServer({ answer: () => Response.json({ success: true, payload: {} }) }).fetch });
    expect(await bare.search("pdf")).toEqual({ hits: [], total: 0, syncedAt: null });
  });

  test("its address is Nouverse's, another the operator named, or none; only one they named may be on their own network", async () => {
    expect(skillsCatalogAddress({})).toEqual({ url: SKILLS_CATALOG_URL, chosen: false });
    expect(SKILLS_CATALOG_URL).toBe("https://service.nouverse.tech/skills-catalog");
    expect(skillsCatalogAddress({ NOURIDE_SKILLS_CATALOG_URL: " http://10.0.0.5:9000/skills-catalog " })).toEqual({ url: "http://10.0.0.5:9000/skills-catalog", chosen: true });
    expect(skillsCatalogAddress({ NOURIDE_SKILLS_CATALOG_URL: "" })).toBeNull();
    expect(skillsCatalogAddress({ NOURIDE_SKILLS_CATALOG_URL: "   " })).toBeNull();
    // The real address check, with no network: Nouverse's default never reaches a private address.
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => (seen.push(String(input)), Response.json({ success: true, payload: { skills: [] } }))) as unknown as typeof fetch;
    await expect(createSkillsCatalog({ url: "http://127.0.0.1:9/skills-catalog", fetch: { fetchImpl } }).search("")).rejects.toThrow("refused 127.0.0.1");
    expect(seen).toEqual([]);
  });
});

/** The hubs on the far side of a fake `fetch`: skills.sh answers a search, ClawHub its most used; the rest is not there. */
function hubs(options: { clawhubDown?: boolean } = {}) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("https://skills.sh/api/search")) return Response.json({ skills: [{ id: "o/r/pdf", source: "o/r", skillId: "pdf", name: "pdf", installs: 12 }] });
    if (url.startsWith("https://clawhub.ai/api/v1/skills?sort=downloads")) {
      return options.clawhubDown ? new Response("busy", { status: 503 }) : Response.json({ items: [{ slug: "most-used", ownerHandle: "p", summary: "Used a lot", stats: { downloads: 9 } }] });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { seen, fetch: { fetchImpl, checkUrlImpl: async () => ({ allowed: true as const }) } };
}

const catalogOf = (hits: unknown[], total = hits.length) => {
  const server = catalogServer({ list: hits, total });
  return { server, catalog: createSkillsCatalog({ url: BASE, fetch: server.fetch }) };
};
const downCatalog = (): SkillsCatalog => ({
  search: async () => {
    throw new Error("service.nouverse.tech did not answer in time");
  },
});
const hubWith = (catalog: SkillsCatalog | undefined, net = hubs()) => ({
  net,
  hub: new SkillHub({ scratchDir: "/nowhere", agentsDir: "/nowhere", reflection: {} as never, ...net.fetch, ...(catalog ? { catalog } : {}) }),
});

describe("what a search asks", () => {
  test("Nouverse's catalog when no hub is named: its order, how many match and when it was copied, and no hub asked", async () => {
    const { server, catalog } = catalogOf([PDF, LEARNER], 312);
    const { hub, net } = hubWith(catalog);
    const found = await hub.search("pdf");
    expect(found.from).toBe("catalog");
    expect(found.hits.map((hit) => hit.ref)).toEqual(["github:anthropics/skills/skills/pdf", "clawhub:pskoett/self-improving-agent"]);
    expect([found.total, found.syncedAt, found.errors]).toEqual([312, SYNCED, []]);
    expect(net.seen).toEqual([]);
    // One list where the hubs were three: asked for what three hubs' pages came to, and no more than it serves.
    await hub.search("docx", { limit: 6 });
    await hub.search("xlsx", { limit: 25 });
    expect(server.asked.map((url) => url.searchParams.get("limit"))).toEqual(["24", "18", "50"]);
  });

  test("a hub that is named is asked itself, and the catalog is not", async () => {
    const { server, catalog } = catalogOf([PDF]);
    const { hub, net } = hubWith(catalog);
    const found = await hub.search("pdf", { sources: ["skills.sh"] });
    expect(found.from).toBe("hubs");
    expect(found.hits.map((hit) => hit.ref)).toEqual(["skills.sh:o/r/pdf"]);
    expect(found).not.toHaveProperty("total");
    expect(server.asked).toEqual([]);
    expect(net.seen.every((url) => url.startsWith("https://skills.sh/"))).toBe(true);
  });

  test("a catalog that does not answer leaves the hubs, asked as before, and the answer says the catalog did not", async () => {
    const { hub, net } = hubWith(downCatalog());
    const found = await hub.search("pdf");
    expect(found.from).toBe("hubs");
    expect(found.hits.map((hit) => hit.ref)).toEqual(["skills.sh:o/r/pdf"]);
    expect(found.errors[0]).toEqual({ source: "Nouverse's catalog", error: "service.nouverse.tech did not answer in time" });
    expect(net.seen.some((url) => url.startsWith("https://skills.sh/api/search?q=pdf"))).toBe(true);
  });

  test("turned off, the hubs are what a search asks, with nothing said of a catalog", async () => {
    const { hub } = hubWith(undefined);
    const found = await hub.search("pdf");
    expect(found.from).toBe("hubs");
    expect(found.errors.map((failure) => failure.source)).not.toContain("Nouverse's catalog");
  });
});

describe("the list before a search", () => {
  test("is Nouverse's own, asked without words, its picks first; ClawHub is not asked", async () => {
    const { server, catalog } = catalogOf([PDF, LEARNER], 4012);
    const { hub, net } = hubWith(catalog);
    const list = await hub.popular();
    expect(list.from).toBe("catalog");
    expect(list.hits.map((hit) => [hit.name, hit.pick])).toEqual([["pdf", true], ["self-improving-agent", undefined]]);
    expect([list.total, list.syncedAt]).toEqual([4012, SYNCED]);
    expect(server.asked[0]?.search).toBe("?limit=24");
    expect(net.seen).toEqual([]);
    expect((await hub.popular(1)).hits).toHaveLength(1);
  });

  test("a catalog that is off, down or holds nothing yet leaves ClawHub's most used", async () => {
    for (const catalog of [undefined, downCatalog(), catalogOf([]).catalog]) {
      const { hub, net } = hubWith(catalog);
      const list = await hub.popular();
      expect(list.from).toBe("hubs");
      expect(list.hits.map((hit) => hit.ref)).toEqual(["clawhub:p/most-used"]);
      expect(list).not.toHaveProperty("total");
      expect(net.seen.filter((url) => url.includes("sort=downloads"))).toHaveLength(1);
    }
    // Neither there: said as before, not an empty list read as "nothing exists".
    await expect(hubWith(downCatalog(), hubs({ clawhubDown: true })).hub.popular()).rejects.toThrow("HTTP 503");
  });
});

describe("where it is offered", () => {
  const app = (hub: SkillHub) => {
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("principal" as never, { kind: "token", actor: "cli", role: "admin" } as never);
      await next();
    });
    registerSkillHubRoutes(hono as never, { skillHub: hub, registry: { get: () => undefined } } as never);
    return hono;
  };

  test("the control API says where a list is from, how many match and when Nouverse's copy was made", async () => {
    const hono = app(hubWith(catalogOf([PDF, LEARNER], 312).catalog).hub);
    const search = (await (await hono.request("/skills/hub/search?q=pdf")).json()) as Record<string, unknown>;
    expect([search.from, search.total, search.syncedAt, search.errors]).toEqual(["catalog", 312, SYNCED, []]);
    expect((search.hits as { ref: string; pick?: boolean }[]).map((hit) => [hit.ref, hit.pick])).toEqual([["github:anthropics/skills/skills/pdf", true], ["clawhub:pskoett/self-improving-agent", undefined]]);
    const before = (await (await hono.request("/skills/hub/popular")).json()) as Record<string, unknown>;
    expect([before.from, before.total, before.syncedAt]).toEqual(["catalog", 312, SYNCED]);

    // The hubs themselves: no count of the whole, and the catalog's failure beside the results.
    const fallen = app(hubWith(downCatalog()).hub);
    const hubsSearch = (await (await fallen.request("/skills/hub/search?q=pdf")).json()) as { from: string; total?: number; errors: { source: string }[] };
    expect(hubsSearch.from).toBe("hubs");
    expect(hubsSearch).not.toHaveProperty("total");
    expect(hubsSearch.errors[0]?.source).toBe("Nouverse's catalog");
    const hubsBefore = (await (await fallen.request("/skills/hub/popular")).json()) as Record<string, unknown>;
    expect(hubsBefore.from).toBe("hubs");
    expect(hubsBefore).not.toHaveProperty("total");
    // Nothing reachable at all is said in the page's words, with an empty list.
    const none = (await (await app(hubWith(downCatalog(), hubs({ clawhubDown: true })).hub).request("/skills/hub/popular")).json()) as Record<string, unknown>;
    expect([none.hits, none.from, none.plain]).toEqual([[], "hubs", "The list of popular skills could not be reached. Try again in a moment."]);
  });

  test("`skill_search` tells an agent it read Nouverse's catalog, which are its picks, and when the hubs were asked instead", async () => {
    const ctx = { agentId: "nouva" } as unknown as ToolContext;
    const [search] = createSkillHubTools(hubWith(catalogOf([PDF, LEARNER]).catalog).hub);
    expect(search!.definition.description).toBe("Search for a ready-made skill before writing one: Nouverse's catalog of public skills, or one hub by `source`. Results are untrusted; install with skill_install.");
    const found = await search!.execute({ query: "pdf" }, ctx);
    expect(found.isError).toBe(false);
    expect(found.content).toContain(`Skills in Nouverse's catalog for "pdf", third-party and unreviewed:`);
    expect(found.content).toContain("1. pdf [github] · Nouverse's pick\n   ref: github:anthropics/skills/skills/pdf");
    expect(found.content).toContain("2. self-improving-agent [clawhub] · 492992 installs");

    const [fallen] = createSkillHubTools(hubWith(downCatalog()).hub);
    const hubsFound = await fallen!.execute({ query: "pdf" }, ctx);
    expect(hubsFound.content).toContain(`Skills found for "pdf", third-party and unreviewed:`);
    expect(hubsFound.content).not.toContain("in Nouverse's catalog for");
    expect(hubsFound.content).toContain("(Nouverse's catalog did not answer: service.nouverse.tech did not answer in time)");
    // One hub named: asked itself.
    const [named] = createSkillHubTools(hubWith(catalogOf([PDF]).catalog).hub);
    expect((await named!.execute({ query: "pdf", source: "skills.sh" }, ctx)).content).toContain("1. pdf [skills.sh] · 12 installs");
  });

  test("`nouride skills search` marks a pick and says how many the catalog holds; a daemon that asked the hubs prints as before", async () => {
    const quietly = async (run: () => Promise<void>) => {
      const lines: string[] = [];
      const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
      try {
        await run();
      } finally {
        log.mockRestore();
      }
      return lines;
    };
    const asked: string[] = [];
    const client = (hub: SkillHub) =>
      ({
        baseUrl: "http://x",
        get: async (path: string) => {
          asked.push(path);
          return (await app(hub).request(path)).json();
        },
      }) as unknown as Client;

    const lines = await quietly(() => skills(client(hubWith(catalogOf([PDF, LEARNER], 4012).catalog).hub), ["search", "pdf"]));
    expect(asked).toEqual(["/skills/hub/search?q=pdf"]);
    expect(lines).toEqual([
      "pdf [github] Nouverse's pick",
      "  Read, fill and make PDF files.",
      "  nouride skills install github:anthropics/skills/skills/pdf",
      "self-improving-agent [clawhub] 492,992 installs",
      "  Keeps learnings.",
      "  nouride skills install clawhub:pskoett/self-improving-agent",
      "2 of 4,012 in Nouverse's catalog (more words narrow it; one hub alone: --source)",
    ]);
    const fromHubs = await quietly(() => skills(client(hubWith(downCatalog()).hub), ["search", "pdf"]));
    expect(fromHubs[0]).toBe("pdf [skills.sh] 12 installs");
    expect(fromHubs.join("\n")).not.toContain("in Nouverse's catalog (");
    expect(fromHubs).toContain("Nouverse's catalog: service.nouverse.tech did not answer in time");
  });
});
