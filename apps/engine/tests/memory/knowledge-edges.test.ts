/**
 * The memory graph's conversation→document and document→tag edges (0.8.23), left out of 0.8.20:
 * the documents a conversation opened with `memory_read`, read from the audit log and kept on its episode when it is
 * filed; a text document's frontmatter `tags:`, kept when it is read. Both drawn in the knowledge layer, a tag both a
 * conversation and a document have being one dot.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { parseEpisode, renderEpisode, type Episode } from "@/modules/memory/episode.ts";
import { buildKnowledgeLayer, withKnowledge, type MemoryGraph } from "@/modules/memory/graph-view.ts";
import { tagsOf } from "@/modules/memory/knowledge/sections.ts";
import { registerMemoryDocumentRoutes } from "@/modules/web/control/routes/memory-documents.ts";
import { GADING_DM, household, type Household } from "./fixture.ts";

const open: Household[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});

describe("a document's tags", () => {
  test("read from its frontmatter, on one line, one per line or split by commas; none without", () => {
    expect(tagsOf("---\ntitle: Runbook\ntags: [homelab, 'Back ups']\n---\n# Runbook\n")).toEqual(["homelab", "Back ups"]);
    expect(tagsOf("---\ntags:\n  - homelab\n  - proxmox\nsource: x\n---\nBody\n")).toEqual(["homelab", "proxmox"]);
    expect(tagsOf("---\ntags: homelab, proxmox\n---\nBody\n")).toEqual(["homelab", "proxmox"]);
    expect(tagsOf("# Runbook\ntags: not frontmatter\n")).toEqual([]);
    expect(tagsOf("---\ntitle: Runbook\n---\n")).toEqual([]);
  });

  test("kept when the document is read, folded as memory folds a conversation's", async () => {
    const h = await household();
    open.push(h);
    mkdirSync(join(h.knowledgeRoot, "homelab"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "homelab", "knowledge.toml"), 'name = "Homelab"\nreaders = "everyone"\n');
    writeFileSync(join(h.knowledgeRoot, "homelab", "runbook.md"), "---\ntags: [Home Lab, '#proxmox', chat]\n---\n# Runbook\nBackups at 02:00.\n");
    writeFileSync(join(h.knowledgeRoot, "homelab", "plain.md"), "# Plain\nNo tags.\n");
    await h.memory.knowledge.sync();
    expect(h.memory.knowledge.document("homelab", "runbook.md")?.tags).toEqual(["home-lab", "proxmox"]);
    expect(h.memory.knowledge.document("homelab", "plain.md")?.tags).toBeUndefined();
  });
});

describe("the documents a conversation opened", () => {
  test("from the audit log: each memory_read of a document that answered, in this chat and window, oldest first", async () => {
    const db = openDatabase(":memory:");
    await migrate(db);
    const audit = new AuditLog(db, () => 1);
    const read = (timestamp: number, args: Record<string, unknown>, options: { error?: boolean; chatId?: string; tool?: string } = {}) =>
      db
        .prepare("INSERT INTO audit_log (id, timestamp, agent_id, actor, action, details, gateway, chat_id) VALUES (?, ?, 'nouva', 'u', 'tool_exec', ?, 'telegram:main', ?)")
        .run(`a${timestamp}`, timestamp, JSON.stringify({ tool: options.tool ?? "memory_read", args, error: options.error ?? false, ms: 5 }), options.chatId ?? "814");
    read(100, { document: "knowledge:legal/NIB.pdf#0" });
    read(110, { document: "knowledge:homelab/runbook.md#all" });
    read(120, { document: "knowledge:legal/gone.pdf#0" }, { error: true });
    read(130, { id: "2026-11-08-0001-x" });
    read(140, { document: "knowledge:legal/NIB.pdf#2" }, { tool: "memory_search" });
    read(150, { document: "knowledge:legal/SKT.pdf#0" }, { chatId: "999" });
    read(300, { document: "knowledge:legal/late.pdf#0" });
    expect(audit.documentsOpened("telegram:main", "814", 50, 200)).toEqual([
      { at: 100, document: "legal/NIB.pdf" },
      { at: 110, document: "homelab/runbook.md" },
    ]);
    db.close();
  });

  test("kept on the episode it falls in when the chat is cut, on its file and in the index; an episode that opened none has none", async () => {
    const h = await household({
      source: (logs) => ({ ...logs, documentsOpenedBetween: (_gateway, _chat, after, until) => opened.filter((one) => one.at > after && one.at <= until) }),
    });
    open.push(h);
    const morning = h.clock.now - 10 * 3_600_000;
    const evening = h.clock.now - 3_600_000;
    var opened = [
      { at: evening + 10_000, document: "legal/NIB.pdf" },
      { at: evening + 12_000, document: "legal/NIB.pdf" },
      { at: evening + 20_000, document: "homelab/runbook.md" },
    ];
    h.dm(GADING_DM, "nouva", "jam berapa backup?", "Jam 2 pagi.", morning);
    const first = await h.memory.cut(GADING_DM.gatewayId, GADING_DM.chatId);
    h.dm(GADING_DM, "nouva", "NIB kita berapa?", "Ini NIB-nya.", evening);
    const second = await h.memory.cut(GADING_DM.gatewayId, GADING_DM.chatId);
    expect([first, second]).toEqual([1, 1]);

    const episodes = h.memory.episodes({}, 10);
    const evenings = episodes.find((episode) => episode.startedAt === evening);
    const mornings = episodes.find((episode) => episode.startedAt === morning);
    // The index lists them by key; the file keeps the order they were first opened in.
    expect(evenings?.documents).toEqual(["homelab/runbook.md", "legal/NIB.pdf"]);
    expect(mornings?.documents).toBeUndefined();
    expect(readFileSync(h.vault.episode(evenings!.id), "utf8")).toContain('documents: ["legal/NIB.pdf", "homelab/runbook.md"]\n');
  });

  test("written on the episode's file and read back; a value that is no document's key is dropped", () => {
    const episode: Episode = {
      id: "2026-11-08-1200-nib",
      status: "raw",
      kind: "dm",
      chat: "telegram:main:814",
      started: "2026-11-08T12:00:00+07:00",
      ended: "2026-11-08T12:05:00+07:00",
      day: "2026-11-08",
      agents: ["nouva"],
      people: ["gading"],
      mentions: [],
      tags: [],
      related: [],
      documents: ["legal/NIB.pdf"],
      transcript: "**Gading:** NIB?\n",
    };
    const text = renderEpisode(episode);
    expect(parseEpisode(text, episode.id)).toMatchObject({ documents: ["legal/NIB.pdf"] });
    expect(parseEpisode(text.replace('"legal/NIB.pdf"', '"nothing"'), episode.id)).not.toHaveProperty("documents");
    expect(renderEpisode({ ...episode, documents: [] })).not.toContain("documents:");
  });
});

describe("drawn in the graph", () => {
  const input = {
    collections: [{ id: "homelab", name: "Homelab", about: [] }],
    documents: [
      { collection: "homelab", path: "runbook.md", title: "Runbook", mtime: 2, tags: ["proxmox"] },
      { collection: "homelab", path: "wifi.md", title: "Wifi", mtime: 1 },
    ],
    links: [],
  };

  test("a document to each of its tags; laid over the conversations, a tag both have is one dot", () => {
    const layer = buildKnowledgeLayer(input, 300, []);
    expect(layer.links.filter((link) => link.kind === "tag")).toEqual([{ source: "d:homelab/runbook.md", target: "t:proxmox", kind: "tag" }]);
    const graph: MemoryGraph = {
      nodes: [{ id: "e:1", kind: "episode", label: "Backups", degree: 1 }, { id: "t:proxmox", kind: "tag", label: "proxmox", degree: 1 }],
      links: [{ source: "e:1", target: "t:proxmox", kind: "tag" }],
      episodes: 1,
      total: 1,
    };
    const both = withKnowledge(graph, layer);
    expect(both.nodes.filter((node) => node.id === "t:proxmox")).toEqual([{ id: "t:proxmox", kind: "tag", label: "proxmox", degree: 2 }]);
  });

  test("a conversation to each document it opened that the layer shows; one not shown, on either end, draws nothing", () => {
    const graph: MemoryGraph = { nodes: [{ id: "e:1", kind: "episode", label: "Backups", degree: 0 }], links: [], episodes: 1, total: 1 };
    const before = structuredClone(graph);
    const both = withKnowledge(graph, buildKnowledgeLayer(input, 300, []), [
      ["1", "homelab/runbook.md"],
      ["1", "homelab/gone.md"],
      ["2", "homelab/wifi.md"],
    ]);
    expect(both.links.filter((link) => link.kind === "opened")).toEqual([{ source: "e:1", target: "d:homelab/runbook.md", kind: "opened" }]);
    expect(both.nodes.find((node) => node.id === "e:1")?.degree).toBe(1);
    expect(graph).toEqual(before);
  });

  test("end to end: a conversation cut after it opened a kept document is joined to it when the knowledge layer is asked for", async () => {
    const h = await household({
      source: (logs) => ({ ...logs, documentsOpenedBetween: (_gateway, _chat, after, until) => [{ at: talked + 5_000, document: "homelab/runbook.md" }].filter((one) => one.at > after && one.at <= until) }),
    });
    open.push(h);
    var talked = h.clock.now - 3_600_000;
    mkdirSync(join(h.knowledgeRoot, "homelab"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "homelab", "knowledge.toml"), 'name = "Homelab"\nreaders = "everyone"\n');
    writeFileSync(join(h.knowledgeRoot, "homelab", "runbook.md"), "---\ntags: [proxmox]\n---\n# Runbook\nBackups at 02:00.\n");
    await h.memory.knowledge.sync();
    h.dm(GADING_DM, "nouva", "jam berapa backup?", "Jam 2 pagi.", talked);
    await h.memory.cut(GADING_DM.gatewayId, GADING_DM.chatId);
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role: "operator" });
      await next();
    });
    registerMemoryDocumentRoutes(hono as never, { memory: h.memory } as never);
    const graph = (await (await hono.request("/memory/graph?limit=300&knowledge=1")).json()) as MemoryGraph;
    const episode = graph.nodes.find((node) => node.kind === "episode")!;
    expect(graph.links.filter((link) => link.kind === "opened")).toEqual([{ source: episode.id, target: "d:homelab/runbook.md", kind: "opened" }]);
    expect(graph.links.filter((link) => link.kind === "tag" && link.source.startsWith("d:"))).toEqual([{ source: "d:homelab/runbook.md", target: "t:proxmox", kind: "tag" }]);
  });
});

describe("a database of 0.8.22", () => {
  test("takes the table and the column, and its text documents are read once more for their tags", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 78));
    const row = db.prepare("INSERT INTO knowledge_documents (collection, path, size, mtime, title, status, sections, indexed_at) VALUES (?, ?, 10, 5000, 't', 'indexed', 1, 5000)");
    for (const path of ["notes.md", "Guide.MARKDOWN", "todo.txt", "NIB.pdf", "md"]) row.run("legal", path);
    await migrate(db);
    const rows = db.prepare<{ path: string; mtime: number; tags: string | null }>("SELECT path, mtime, tags FROM knowledge_documents ORDER BY path").all();
    expect(rows).toEqual([
      { path: "Guide.MARKDOWN", mtime: 0, tags: null },
      { path: "NIB.pdf", mtime: 5000, tags: null },
      { path: "md", mtime: 5000, tags: null },
      { path: "notes.md", mtime: 0, tags: null },
      { path: "todo.txt", mtime: 0, tags: null },
    ]);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM memory_episode_documents").get()?.n).toBe(0);
    db.close();
  });
});
