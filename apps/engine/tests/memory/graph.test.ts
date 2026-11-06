/**
 * The dashboard's graph: what it links, what it leaves out so it stays readable, and that it is
 * built once per change to the vault rather than once per request.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerMemoryDocumentRoutes } from "@/modules/web/control/routes/memory-documents.ts";
import type { Person } from "@nouride/shared";
import { buildGraph, createGraphView } from "@/modules/memory/graph-view.ts";
import type { IndexedEpisode, MemoryIndexPort } from "@/modules/memory/memory-index.store.ts";
import { GADING_DM, SAM_DM, at, household, scripted, type Household } from "./fixture.ts";

const PEOPLE: Person[] = [{ key: "gading", ids: ["telegram:814"], name: "Gading" }];

function episode(id: string, over: Partial<IndexedEpisode> = {}): IndexedEpisode {
  return {
    id, status: "summarized", kind: "dm", chat: "telegram:nouva:814", day: "2026-09-25", week: "2026-W39", month: "2026-09",
    startedAt: 0, endedAt: 0, agents: ["nouva"], participants: ["gading"], mentions: [], tags: [], related: [], ...over,
  };
}

describe("buildGraph", () => {
  test("links a conversation to its agent, people and shared tags, by name where there is one", () => {
    const graph = buildGraph(
      [
        episode("a", { summary: "Gading pakai M3.", tags: ["hardware", "once"], mentions: ["gading", "sam"], related: ["b"] }),
        episode("b", { tags: ["hardware"], related: ["a", "gone"] }),
      ],
      2,
      PEOPLE,
    );
    const ids = graph.nodes.map((node) => node.id).sort();
    expect(ids).toEqual(["a:nouva", "e:a", "e:b", "p:gading", "p:sam", "t:hardware"]);
    expect(graph.nodes.find((node) => node.id === "p:gading")?.label).toBe("Gading");
    expect(graph.nodes.find((node) => node.id === "e:a")?.label).toBe("Gading pakai M3.");
    // Taking part and being talked about is one link, the participant one.
    expect(graph.links.filter((link) => link.source === "e:a" && link.target === "p:gading").map((link) => link.kind)).toEqual(["participant"]);
    // Related both ways is one link; one to a conversation not shown is none.
    expect(graph.links.filter((link) => link.kind === "related")).toEqual([{ source: "e:a", target: "e:b", kind: "related" }]);
    expect(graph.nodes.find((node) => node.id === "t:hardware")?.degree).toBe(2);
  });

  test("keeps a one-off tag when it is the one filtered by", () => {
    const graph = buildGraph([episode("a", { tags: ["once"] })], 1, PEOPLE, new Set(["once"]));
    expect(graph.nodes.some((node) => node.id === "t:once")).toBe(true);
  });

  test("cuts a long label to a line", () => {
    const graph = buildGraph([episode("a", { summary: `${"panjang ".repeat(40)}\n\nlagi` })], 1, PEOPLE);
    const label = graph.nodes.find((node) => node.id === "e:a")!.label;
    expect(label.length).toBeLessThanOrEqual(110);
    expect(label.endsWith("…")).toBe(true);
    expect(label).not.toContain("\n");
  });
});

describe("createGraphView", () => {
  test("reads the index once per revision and filter", () => {
    let revision = "1";
    let reads = 0;
    const index = {
      revision: () => revision,
      allEpisodes: () => {
        reads += 1;
        return [episode("a")];
      },
      countEpisodes: () => 1,
    } as unknown as MemoryIndexPort;
    const view = createGraphView({ index, people: () => PEOPLE }).graph;
    view({}, 300);
    view({}, 300);
    expect(reads).toBe(1);
    view({ tags: ["x"] }, 300);
    expect(reads).toBe(2);
    revision = "2";
    view({}, 300);
    expect(reads).toBe(3);
  });

  test("says how many matched when it shows fewer", () => {
    const index = {
      revision: () => "1",
      allEpisodes: (_filter: unknown, limit: number) => [episode("a"), episode("b")].slice(0, limit),
      countEpisodes: () => 2,
    } as unknown as MemoryIndexPort;
    const graph = createGraphView({ index, people: () => PEOPLE }).graph({}, 1);
    expect(graph).toMatchObject({ episodes: 1, total: 2 });
  });
});

describe("the memory graph, end to end", () => {
  let h: Household;
  afterEach(() => h.close());

  test("a filed vault answers with its conversations, and a new one shows without a restart", async () => {
    h = await household();
    h.dm(GADING_DM, "nouva", "Aku pakai MacBook M3", "Oke.", at(9));
    h.dm(SAM_DM, "nix", "Resep rendang", "Ini.", at(10));
    await h.memory.pass(
      scripted([
        { when: "MacBook", answer: { summary: "Gading pakai M3.", tags: ["hardware"] } },
        { when: "rendang", answer: { summary: "Sam minta resep.", tags: ["masak"] } },
      ]).ask,
    );
    const first = h.memory.graph({}, 300);
    expect(first.episodes).toBe(2);
    expect(first.nodes.filter((node) => node.kind === "agent").map((node) => node.id).sort()).toEqual(["a:nix", "a:nouva"]);
    expect(h.memory.graph({ agents: ["nix"] }, 300).episodes).toBe(1);

    h.dm(GADING_DM, "nouva", "Ganti ke M4", "Siap.", at(11, 0, 26));
    h.clock.now = at(23, 0, 26);
    await h.memory.pass(scripted([{ when: "M4", answer: { summary: "Gading ganti M4.", tags: ["hardware"] } }]).ask);
    const second = h.memory.graph({}, 300);
    expect(second.episodes).toBe(3);
    expect(second.nodes.find((node) => node.id === "t:hardware")?.degree).toBe(2);
  });
});

describe("filtering by several of a kind", () => {
  let h: Household;
  afterEach(() => h.close());

  async function filed() {
    h = await household();
    h.dm(GADING_DM, "nouva", "Aku pakai MacBook M3", "Oke.", at(9));
    h.dm(SAM_DM, "nix", "Resep rendang", "Ini.", at(10));
    // Another day, so it is its own conversation rather than the end of the first.
    h.dm(GADING_DM, "nouva", "NAS aku penuh", "Cek.", at(11, 0, 26));
    h.clock.now = at(23, 0, 26);
    await h.memory.pass(
      scripted([
        { when: "MacBook", answer: { summary: "Gading pakai M3.", tags: ["hardware"] } },
        { when: "rendang", answer: { summary: "Sam minta resep.", tags: ["masak"] } },
        { when: "NAS", answer: { summary: "NAS Gading penuh.", tags: ["hardware", "homelab"] } },
      ]).ask,
    );
  }

  test("several of one kind match any of them; different kinds must all match", async () => {
    await filed();
    expect(h.memory.graph({ agents: ["nouva", "nix"] }, 300).episodes).toBe(3);
    expect(h.memory.graph({ tags: ["masak", "homelab"] }, 300).episodes).toBe(2);
    expect(h.memory.graph({ agents: ["nix"], tags: ["hardware"] }, 300).episodes).toBe(0);
    expect(h.memory.graph({ agents: ["nouva"], tags: ["hardware", "masak"] }, 300).episodes).toBe(2);
  });

  test("the facets are the whole vault's, counted, with people by name", async () => {
    await filed();
    const facets = h.memory.graphFacets();
    expect(facets.agents).toEqual([{ value: "nouva", count: 2 }, { value: "nix", count: 1 }]);
    expect(facets.tags[0]).toEqual({ value: "hardware", count: 2 });
    expect(facets.people.find((person) => person.value === "gading")).toEqual({ value: "gading", count: 2, label: "Gading" });
  });

  test("the route reads a repeated parameter as several values, in any order", async () => {
    await filed();
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role: "operator" });
      await next();
    });
    registerMemoryDocumentRoutes(hono as never, { memory: h.memory } as never);
    const body = async (query: string) => (await (await hono.request(`/memory/graph?${query}`)).json()) as { episodes: number };
    expect((await body("agent=nouva&agent=nix")).episodes).toBe(3);
    expect((await body("tag=masak&tag=homelab")).episodes).toBe(2);
    const facets = (await (await hono.request("/memory/facets")).json()) as { agents: unknown[] };
    expect(facets.agents).toHaveLength(2);
  });
});
