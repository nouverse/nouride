/**
 * Documents close in meaning (0.8.20, KNOWLEDGE_BASE §11): a document's Related documents on the dashboard. A document
 * is the mean of its sections' vectors, the ones memory holds for search, and its nearest are the three whose means
 * are closest, above a floor, never itself, never from an archived collection, and none while search by meaning is off.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { centroid, similarity } from "@/modules/memory/semantic.ts";
import { documentVectors, nearest, nearestEach } from "@/modules/memory/knowledge/related.ts";
import { registerKnowledgeRoutes } from "@/modules/web/control/routes/knowledge.ts";
import { eventually } from "../helpers.ts";
import { household, type Household } from "./fixture.ts";

const unit = (...values: number[]) => {
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  return Int8Array.from(values, (x) => Math.round((x / norm) * 127));
};

describe("a document's meaning", () => {
  test("is the mean of its sections' vectors, kept as one is; another size is left out, and none is nothing", () => {
    const mean = centroid([unit(1, 0), unit(0, 1), unit(1, 0, 0)])!;
    expect(similarity(mean, unit(1, 1))).toBeGreaterThan(0.999);
    expect(Math.max(...mean.map(Math.abs))).toBeLessThanOrEqual(127);
    expect(centroid([])).toBeNull();
  });

  test("is read from the sections' vectors, by document; a section with no vector yet counts for nothing", () => {
    const vectors = new Map([
      ["knowledge:ops/a.md#0", unit(1, 0)],
      ["knowledge:ops/a.md#1", unit(0, 1)],
      ["knowledge:ops/b.md#0", unit(1, 0)],
    ]);
    const means = documentVectors(["knowledge:ops/a.md#0", "knowledge:ops/a.md#1", "knowledge:ops/b.md#0", "knowledge:ops/c.md#0"], vectors);
    expect([...means.keys()].sort()).toEqual(["ops/a.md", "ops/b.md"]);
    expect(similarity(means.get("ops/a.md")!, unit(1, 1))).toBeGreaterThan(0.999);
  });
});

describe("the nearest documents", () => {
  const documents = new Map([
    ["home/router.md", unit(1, 0)],
    ["home/wifi.md", unit(1, 0.05)],
    ["home/modem.md", unit(0.9, 0.436)],
    ["home/switch.md", unit(0.8, 0.6)],
    ["home/cables.md", unit(0.7, 0.714)],
    ["home/garden.md", unit(0.5, 0.866)],
    // On a subject of its own: every other document under the floor.
    ["health/lab.md", unit(0.1, -1)],
    // Made by a model of another size: compared with none.
    ["other/odd.md", unit(1, 0, 0)],
  ]);

  test("three at most, closest first, never itself", () => {
    expect(nearest("home/router.md", documents).map((near) => near.key)).toEqual(["home/wifi.md", "home/modem.md", "home/switch.md"]);
  });

  test("none under the floor, so a document on another subject has none", () => {
    expect(nearest("health/lab.md", documents)).toEqual([]);
    // Cosine 0.5 with the router: on the list of a document it is near, never of one it is not.
    expect(nearest("home/router.md", documents, 10).map((near) => near.key)).not.toContain("home/garden.md");
  });

  test("worked out for every document at once, each the same as asked alone", () => {
    const each = nearestEach(documents);
    for (const key of documents.keys()) {
      expect(each.get(key)!.map((near) => near.key)).toEqual(nearest(key, documents).map((near) => near.key));
      for (const [i, near] of each.get(key)!.entries()) expect(near.score).toBeCloseTo(nearest(key, documents)[i]!.score, 9);
    }
  });
});

describe("Related documents, over HTTP", () => {
  let h: Household;
  afterEach(() => h.close());

  /** A vector per document, by a word in its text: a two-word space, and a third for a subject of its own. */
  const MEANING: [RegExp, number[]][] = [
    [/router/i, [1, 0, 0, 0]],
    [/wifi/i, [1, 0.05, 0, 0]],
    [/modem/i, [0.9, 0.436, 0, 0]],
    [/switch/i, [0.8, 0.6, 0, 0]],
    [/cables/i, [0.7, 0.714, 0, 0]],
    [/garden/i, [0.5, 0.866, 0, 0]],
    [/lab result/i, [0, 0, 1, 0]],
  ];
  const embed = (texts: string[]) => texts.map((text) => MEANING.find(([word]) => word.test(text))?.[1] ?? [0, 0, 0, 1]);

  const put = (path: string, text: string) => {
    mkdirSync(join(h.knowledgeRoot, path, ".."), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, path), text);
  };

  function app() {
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role: "operator", user: { id: "acc" } });
      await next();
    });
    registerKnowledgeRoutes(hono as never, { ctx: { config: h.config }, memory: h.memory, registry: { get: () => undefined }, audit: { record: () => {} } } as never);
    return hono;
  }
  const related = async (collection: string, path: string) => {
    const response = await app().request(`/knowledge/${collection}/related?path=${encodeURIComponent(path)}`);
    return { status: response.status, body: (await response.json()) as { byMeaning: boolean; related: { path: string; collection: string; collectionName: string; title: string }[] } };
  };

  async function kept(options: { embedded: boolean }) {
    h = await household(options.embedded ? { embed } : {});
    put("home/knowledge.toml", 'name = "Home network"\nreaders = "everyone"\n');
    for (const name of ["router", "wifi", "modem", "switch", "cables", "garden"]) put(`home/${name}.md`, `# ${name[0]!.toUpperCase()}${name.slice(1)}\nNotes about the ${name}.\n`);
    put("health/knowledge.toml", 'name = "Health"\n');
    put("health/lab.md", "# Lab result\nThe lab result from October.\n");
    // As close to the router as the wifi is, in a collection put away: never offered.
    put("old/knowledge.toml", 'name = "Old"\nreaders = "everyone"\narchived = true\n');
    put("old/router-2019.md", "# Old router\nThe router we had before.\n");
    await h.memory.knowledge.sync();
    if (options.embedded) {
      await h.memory.embedCatchUp();
      await eventually(() => h.vectors.count("fake/vec@4") === 8, 2_000, "every section embedded");
    }
  }

  test("a document's three nearest by meaning, with their titles and collections, closest first", async () => {
    await kept({ embedded: true });
    const { status, body } = await related("home", "router.md");
    expect(status).toBe(200);
    expect(body.byMeaning).toBe(true);
    expect(body.related.map((document) => document.path)).toEqual(["wifi.md", "modem.md", "switch.md"]);
    expect(body.related[0]).toMatchObject({ collection: "home", collectionName: "Home network", title: "Wifi" });
  });

  test("none for a document on a subject of its own, and none from a collection put away", async () => {
    await kept({ embedded: true });
    expect((await related("health", "lab.md")).body.related).toEqual([]);
    const all = (await related("home", "router.md")).body.related.map((document) => document.collection);
    expect(all).not.toContain("old");
  });

  test("none while search by meaning is off, and it says so; a document that is not there is a 404", async () => {
    await kept({ embedded: false });
    expect((await related("home", "router.md")).body).toEqual({ byMeaning: false, related: [] });
    expect((await related("home", "nothing.md")).status).toBe(404);
  });
});
