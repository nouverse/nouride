/**
 * The memory graph's knowledge layer (0.8.20, KNOWLEDGE_BASE §12): off unless asked for, and then each collection and
 * its documents, a line for each link one document's words make to another (a Markdown link or a wikilink), a line from
 * each person a collection is about, and a dashed line from each document to its nearest by meaning while search by
 * meaning is on. Bounded as the conversations are: the most linked first, then the newest.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Person } from "@nouride/shared";
import { buildKnowledgeLayer, withKnowledge, type KnowledgeGraphInput, type MemoryGraph } from "@/modules/memory/graph-view.ts";
import { KnowledgeStore } from "@/modules/memory/knowledge/knowledge.store.ts";
import { documentIndex, linksIn, resolveLink } from "@/modules/memory/knowledge/links.ts";
import { registerMemoryDocumentRoutes } from "@/modules/web/control/routes/memory-documents.ts";
import { eventually } from "../helpers.ts";
import { household, type Household } from "./fixture.ts";

const PEOPLE: Person[] = [{ key: "mum", ids: [], name: "Mum" }, { key: "gading", ids: ["telegram:814"], name: "Gading" }];

describe("links in a document's words", () => {
  test("Markdown links and wikilinks, each once; a web address, a mail address and a place in the page are none", () => {
    const text = [
      "See [the runbook](runbook.md#backups), [again](runbook.md) and [the diagram](<../net/diagram.md> \"Network\").",
      "From the top: [index](/index.md). Not these: [site](https://example.com/a.md), [mail](mailto:a@b.c), [up](#top).",
      "And [[Proxmox runbook]], [[Proxmox runbook|the runbook]], [[Router#Admin page]] and [[sub/notes]].",
    ].join("\n");
    expect(linksIn(text)).toEqual([
      { kind: "relative", target: "runbook.md" },
      { kind: "relative", target: "../net/diagram.md" },
      { kind: "rooted", target: "index.md" },
      { kind: "name", target: "Proxmox runbook" },
      { kind: "name", target: "Router" },
      { kind: "rooted", target: "sub/notes" },
    ]);
  });

  test("resolved as an editor does: from the document's folder, up into another collection, by name in its own collection first", () => {
    const index = documentIndex([
      { collection: "homelab", path: "proxmox/runbook.md", title: "Proxmox runbook" },
      { collection: "homelab", path: "index.md", title: "Homelab" },
      { collection: "homelab", path: "router.md", title: "Router" },
      { collection: "net", path: "diagram.md", title: "Network diagram" },
      { collection: "net", path: "router.md", title: "Router" },
      { collection: "notes", path: "router.md", title: "Router" },
    ]);
    const from = { collection: "homelab", path: "proxmox/backups.md" };
    expect(resolveLink(from, { kind: "relative", target: "runbook.md" }, index)).toBe("homelab/proxmox/runbook.md");
    expect(resolveLink(from, { kind: "relative", target: "runbook" }, index)).toBe("homelab/proxmox/runbook.md");
    expect(resolveLink(from, { kind: "relative", target: "../../net/diagram.md" }, index)).toBe("net/diagram.md");
    expect(resolveLink(from, { kind: "rooted", target: "index.md" }, index)).toBe("homelab/index.md");
    expect(resolveLink(from, { kind: "name", target: "proxmox RUNBOOK" }, index)).toBe("homelab/proxmox/runbook.md");
    // Two other collections have a Router: its own collection's is the one.
    expect(resolveLink(from, { kind: "name", target: "Router" }, index)).toBe("homelab/router.md");
    // From a collection without one, two candidates elsewhere name none; one names it.
    expect(resolveLink({ collection: "other", path: "a.md" }, { kind: "name", target: "Router" }, index)).toBeNull();
    expect(resolveLink({ collection: "other", path: "a.md" }, { kind: "name", target: "Network diagram" }, index)).toBe("net/diagram.md");
    // Out of the knowledge folder, and a file that is not kept, name nothing.
    expect(resolveLink(from, { kind: "relative", target: "../../../etc/passwd" }, index)).toBeNull();
    // Above the folder and down again lands on a document kept, and is still out of it.
    expect(resolveLink({ collection: "homelab", path: "a.md" }, { kind: "relative", target: "../../net/diagram.md" }, index)).toBeNull();
    expect(resolveLink(from, { kind: "relative", target: "missing.md" }, index)).toBeNull();
  });
});

const doc = (collection: string, path: string, mtime = 0) => ({ collection, path, title: path.replace(/\.md$/, ""), mtime });
const unit = (...values: number[]) => {
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  return Int8Array.from(values, (x) => Math.round((x / norm) * 127));
};

describe("the knowledge layer", () => {
  const input: KnowledgeGraphInput = {
    collections: [
      { id: "homelab", name: "Homelab", about: [] },
      { id: "mum", name: "Mum's health", about: ["mum"] },
    ],
    documents: [doc("homelab", "runbook.md", 1), doc("homelab", "diagram.md", 2), doc("homelab", "wifi.md", 3), doc("mum", "lab.md", 4), doc("gone", "x.md", 5)],
    links: [
      ["homelab/runbook.md", "homelab/diagram.md"],
      ["homelab/diagram.md", "homelab/runbook.md"],
      ["homelab/runbook.md", "homelab/runbook.md"],
      ["homelab/runbook.md", "gone/x.md"],
    ],
  };

  test("a collection to each document, a link once per pair, a person to what is about them; another collection's rows left out", () => {
    const layer = buildKnowledgeLayer(input, 300, PEOPLE);
    const kinds = (kind: string) => layer.links.filter((link) => link.kind === kind).map((link) => `${link.source} ${link.target}`).sort();
    expect(kinds("collection")).toEqual(["c:homelab d:homelab/diagram.md", "c:homelab d:homelab/runbook.md", "c:homelab d:homelab/wifi.md", "c:mum d:mum/lab.md"]);
    expect(kinds("link")).toEqual(["d:homelab/runbook.md d:homelab/diagram.md"]);
    expect(kinds("about")).toEqual(["p:mum d:mum/lab.md"]);
    expect(kinds("similar")).toEqual([]);
    expect(layer.nodes.find((node) => node.id === "p:mum")).toMatchObject({ kind: "person", label: "Mum", degree: 1 });
    expect(layer.nodes.find((node) => node.id === "c:homelab")).toMatchObject({ kind: "collection", label: "Homelab", degree: 3 });
    expect(layer).toMatchObject({ documents: 4, total: 4, byMeaning: false });
    expect(layer.nodes.some((node) => node.id.includes("gone"))).toBe(false);
  });

  test("bounded: the most linked documents first, then the newest", () => {
    const layer = buildKnowledgeLayer(input, 3, PEOPLE);
    // The linked two, then the newest of the rest (lab, 4) before wifi (3).
    expect(layer.nodes.filter((node) => node.kind === "document").map((node) => node.id).sort()).toEqual(["d:homelab/diagram.md", "d:homelab/runbook.md", "d:mum/lab.md"]);
    expect(layer).toMatchObject({ documents: 3, total: 4 });
  });

  test("with search by meaning on, a dashed line to each one's nearest above the floor, a pair already linked not twice", () => {
    const vectors = new Map([
      ["homelab/runbook.md", unit(1, 0)],
      ["homelab/diagram.md", unit(1, 0.1)],
      ["homelab/wifi.md", unit(0.9, 0.3)],
      ["mum/lab.md", unit(0, 1)],
    ]);
    const layer = buildKnowledgeLayer({ ...input, vectors }, 300, PEOPLE);
    const similar = layer.links.filter((link) => link.kind === "similar").map((link) => [link.source, link.target].sort().join(" ")).sort();
    expect(similar).toEqual(["d:homelab/diagram.md d:homelab/wifi.md", "d:homelab/runbook.md d:homelab/wifi.md"]);
    expect(layer.byMeaning).toBe(true);
  });

  test("laid over the conversations: a person both draw is one dot, its reach the sum; the conversations' graph is left as it was", () => {
    const graph: MemoryGraph = {
      nodes: [{ id: "e:1", kind: "episode", label: "Lab results talk", degree: 1 }, { id: "p:mum", kind: "person", label: "Mum", degree: 1 }],
      links: [{ source: "e:1", target: "p:mum", kind: "participant" }],
      episodes: 1,
      total: 1,
    };
    const before = structuredClone(graph);
    const both = withKnowledge(graph, buildKnowledgeLayer(input, 300, PEOPLE));
    expect(both.nodes.filter((node) => node.id === "p:mum")).toEqual([{ id: "p:mum", kind: "person", label: "Mum", degree: 2 }]);
    expect(both.knowledge).toEqual({ documents: 4, total: 4, byMeaning: false });
    expect(graph).toEqual(before);
  });
});

describe("the layer from the knowledge folder, and over HTTP", () => {
  let h: Household;
  afterEach(() => h.close());

  const put = (path: string, text: string, mtime?: number) => {
    mkdirSync(join(h.knowledgeRoot, path, ".."), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, path), text);
    if (mtime) utimesSync(join(h.knowledgeRoot, path), mtime, mtime);
  };

  function app() {
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role: "operator" });
      await next();
    });
    registerMemoryDocumentRoutes(hono as never, { memory: h.memory } as never);
    return hono;
  }
  const graphOf = async (query: string) => (await (await app().request(`/memory/graph?${query}`)).json()) as MemoryGraph;

  async function kept(embed?: (texts: string[]) => number[][]) {
    h = await household(embed ? { embed } : {});
    h.config.people.push({ key: "mum", ids: [], name: "Mum" });
    put("homelab/knowledge.toml", 'name = "Homelab"\nreaders = "everyone"\n');
    put("homelab/runbook.md", "# Proxmox runbook\nBackups first: see [[Network diagram]].\n");
    put("homelab/net/diagram.md", "# Network diagram\nThe router, then [the runbook](../runbook.md).\n");
    put("homelab/photo.jpg", "not read");
    put("mum/knowledge.toml", 'name = "Mum\'s health"\nabout = ["mum"]\n');
    put("mum/lab.md", "# Lab results\nBlood test in October.\n");
    put("old/knowledge.toml", 'name = "Old"\narchived = true\n');
    put("old/notes.md", "# Old notes\nSee [[Proxmox runbook]].\n");
    await h.memory.knowledge.sync();
  }

  test("off unless asked for; asked, the folder's links resolved, whom a collection is about, nothing archived or unread", async () => {
    await kept();
    const plain = await graphOf("limit=300");
    expect(plain.nodes.filter((node) => node.kind === "document")).toEqual([]);
    expect(plain.knowledge).toBeUndefined();

    const graph = await graphOf("limit=300&knowledge=1");
    expect(graph.nodes.filter((node) => node.kind === "document").map((node) => node.id).sort()).toEqual(["d:homelab/net/diagram.md", "d:homelab/runbook.md", "d:mum/lab.md"]);
    expect(graph.nodes.find((node) => node.id === "d:homelab/runbook.md")?.label).toBe("Proxmox runbook");
    expect(graph.links.filter((link) => link.kind === "link")).toHaveLength(1);
    expect(graph.links.filter((link) => link.kind === "about")).toEqual([{ source: "p:mum", target: "d:mum/lab.md", kind: "about" }]);
    expect(graph.knowledge).toEqual({ documents: 3, total: 3, byMeaning: false });
  });

  test("its links read once per change to the folder, not once per look", async () => {
    await kept();
    const read = KnowledgeStore.prototype.linkingTexts;
    let reads = 0;
    KnowledgeStore.prototype.linkingTexts = function (this: KnowledgeStore) {
      reads += 1;
      return read.call(this);
    };
    try {
      h.memory.graph({}, 300, { knowledge: true });
      h.memory.graph({}, 300, { knowledge: true });
      expect(reads).toBe(1);
      put("homelab/wifi.md", "# Wifi\nSee [[Proxmox runbook]].\n");
      await h.memory.knowledge.sync();
      expect(h.memory.graph({}, 300, { knowledge: true }).links.filter((link) => link.kind === "link")).toHaveLength(2);
      expect(reads).toBe(2);
    } finally {
      KnowledgeStore.prototype.linkingTexts = read;
    }
  });

  test("with search by meaning on, documents close in meaning are joined by a dashed line", async () => {
    await kept((texts) => texts.map((text) => (/runbook|diagram|router/i.test(text) ? [1, 0.2, 0, 0] : [0, 0, 1, 0])));
    put("homelab/backups.md", "# Backups\nThe runbook's schedule, by router.\n");
    await h.memory.knowledge.sync();
    await h.memory.embedCatchUp();
    await eventually(() => h.vectors.count("fake/vec@4") >= 5, 2_000, "the sections embedded");
    const graph = await graphOf("knowledge=1");
    const similar = graph.links.filter((link) => link.kind === "similar").map((link) => [link.source, link.target].sort().join(" ")).sort();
    // The runbook and the diagram are linked already: their line is the link. The backups page is near both.
    expect(similar).toEqual(["d:homelab/backups.md d:homelab/net/diagram.md", "d:homelab/backups.md d:homelab/runbook.md"]);
    expect(graph.knowledge?.byMeaning).toBe(true);
  });
});
