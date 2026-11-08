/**
 * Keeping a document from a chat (0.8.20, KNOWLEDGE_BASE §9): `memory_write` about knowledge. Into a new collection, for
 * the people in that chat; into one no wider than them, at once; into one wider, it waits for an admin's yes on the
 * dashboard, and the agent is told to say so. A page keeps its address; a file is one this turn may read.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { join } from "node:path";
import { AttachmentStore, isStored, sentName } from "@/modules/attachments/store.ts";
import { renderMemory } from "@/modules/llm/prompt/harness-memory.ts";
import { createMemoryWriteTool } from "@/modules/tools/builtins/memory.ts";
import { registerKnowledgeRoutes } from "@/modules/web/control/routes/knowledge.ts";
import { FAMILY, GADING_DM, household, SAM_DM, speaker, type Household } from "./fixture.ts";

const open: Household[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});

async function home() {
  const h = await household();
  open.push(h);
  const workspace = join(h.dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  // No sender name, as a turn in a one-to-one chat has none (a platform's display name is not verified): who is the
  // person People knows.
  const ctx = (where: typeof GADING_DM, senderName: string, agentId = "nouva") =>
    ({ agentId, agentDir: join(h.dir, "agents", agentId), sessionId: "s", signal: new AbortController().signal, ...where, ...(senderName ? { senderName } : {}), workspaceDir: workspace, workspaceRoots: [workspace], readOnlyRoots: [join(h.dir, "attachments")] }) as never;
  const write = createMemoryWriteTool(h.memory);
  const keep = (args: Record<string, unknown>, where = GADING_DM, name = "Gading") => write.execute({ about: "knowledge", ...args }, ctx(where, name));
  const found = async (where: typeof GADING_DM, query: string, agentId = "nouva") =>
    (await h.memory.search(speaker(where, agentId), { query, kind: "knowledge" })).map((hit) => (hit.kind === "section" ? hit.section.item : ""));
  return { h, workspace, ctx, keep, found };
}

describe("keeping a document from a chat", () => {
  test("a new collection is made for the person in the chat, and the document is searched at once, there only", async () => {
    const { h, keep, found } = await home();
    const kept = await keep({ collection: "Health", title: "Lab results", content: "Cholesterol 180 in October." });
    expect(kept).toMatchObject({ isError: false, content: 'Kept in "Health" as Lab results.md, a collection made now for the people in this chat. It can be searched now.' });
    expect(readFileSync(join(h.knowledgeRoot, "health", "knowledge.toml"), "utf8")).toContain('readers = ["gading"]');
    expect(await found(GADING_DM, "cholesterol")).toEqual(["knowledge:health/Lab results.md#0"]);
    expect(await found(SAM_DM, "cholesterol", "nix")).toEqual([]);
  });

  test("from a group, the collection is the group's", async () => {
    const { h, keep } = await home();
    await keep({ collection: "Family rules", title: "Rules", content: "Quiet after 22:00." }, FAMILY, "Gading");
    expect(readFileSync(join(h.knowledgeRoot, "family-rules", "knowledge.toml"), "utf8")).toContain('readers = "group:whatsapp:main:1203@g.us"');
  });

  test("a page keeps its address, and its title as a heading", async () => {
    const { h, keep } = await home();
    await keep({ collection: "Recipes", title: "Rendang", content: "Slow-cook the beef for four hours.", source: "https://example.com/rendang" });
    const text = readFileSync(join(h.knowledgeRoot, "recipes", "Rendang.md"), "utf8");
    expect(text.startsWith("---\nsource: https://example.com/rendang\nsaved: ")).toBe(true);
    expect(text).toContain("---\n# Rendang\n\nSlow-cook the beef for four hours.\n");
  });

  test("a file this turn may read is kept as it is; one outside is refused", async () => {
    const { h, workspace, keep, found } = await home();
    writeFileSync(join(workspace, "prices.csv"), "sku,price\nA,15000\n");
    expect((await keep({ collection: "Shop", title: "Shop price list", file: "prices.csv" })).isError).toBe(false);
    expect(readFileSync(join(h.knowledgeRoot, "shop", "prices.csv"), "utf8")).toBe("sku,price\nA,15000\n");
    expect(await found(GADING_DM, "15000")).toEqual(["knowledge:shop/prices.csv#0"]);
    const outside = await keep({ collection: "Shop", title: "Hosts", file: "/etc/hosts" });
    expect(outside).toMatchObject({ isError: true, content: 'No file "/etc/hosts" that you may read here: an attachment of this chat, or one in your workspace.' });
  });

  test("a file with no text in it is kept, and the agent is told it is not searched and why, never that it can be", async () => {
    const { h, workspace, keep } = await home();
    writeFileSync(join(workspace, "blank.txt"), "\n\n");
    expect(await keep({ collection: "Legal", title: "A blank page", file: "blank.txt" })).toMatchObject({
      isError: false,
      content: 'Kept in "Legal" as blank.txt, a collection made now for the people in this chat. It is kept but not searched: It has no text to search, as a scanned page has none, so it is kept here but not searched.',
    });
    expect(existsSync(join(h.knowledgeRoot, "legal", "blank.txt"))).toBe(true);
  });

  // Nestor, asked to put the owner's legal PDFs in the knowledge base, said it did not know whether a PDF's text could be
  // read, and planned to take the text out first (2026-11-07): the words said "a file to keep as it is", and no more.
  test("agents are told a PDF or an Office file is read for its text, to give the file itself, and when one is not searched", async () => {
    const { h } = await home();
    const tool = createMemoryWriteTool(h.memory);
    expect(tool.definition.description).toContain(
      "A PDF, Word, Excel or PowerPoint file is read for its text, so give the file itself, not text taken out of it; a scan, with no text, is kept but not searched.",
    );
    expect(JSON.stringify(tool.definition.parameters)).not.toContain("as it is");
  });

  test("a file sent in the chat is kept under the name it was sent with, not the one it is stored by", async () => {
    const { h, keep, found } = await home();
    const store = new AttachmentStore({ rootDir: join(h.dir, "attachments"), maxBytes: 1024 * 1024 });
    const scope = { agentId: "nouva", gatewayId: GADING_DM.gatewayId, chatId: GADING_DM.chatId };
    const sent = await store.store(scope, { type: "file", filename: "Gate.md", mimeType: "text/markdown" } as never, async () => new TextEncoder().encode("# Gate\nThe side gate sticks in the rain.\n"), 0);
    if (!isStored(sent)) throw new Error("the attachment was not stored");
    // Stored by another name, so that two files of one name never meet: the agent is handed this path.
    expect(sent.localPath.endsWith("/Gate.md")).toBe(false);
    expect((await keep({ collection: "Notes", title: "The side gate", file: sent.localPath })).isError).toBe(false);
    expect(readFileSync(join(h.knowledgeRoot, "notes", "Gate.md"), "utf8")).toContain("The side gate sticks");
    expect(await found(GADING_DM, "side gate")).toEqual(["knowledge:notes/Gate.md#0"]);
    // A file carried into a group chat is copied under one more prefix.
    expect(sentName(store.copyFor({ ...scope, chatId: "1203@g.us" }, "ref", sent.localPath).split("/").pop()!)).toBe("Gate.md");
    expect(sentName("room-notes.md")).toBe("room-notes.md");
  });

  // A file sent on Telegram with a space in its name was kept with an underscore for it (0.8.20's check on the box,
  // 2026-11-06): storing makes a name safe for a path, and the name it was sent under is the conversation's list's.
  test("a file whose name storing changed is kept under the name the conversation's files have for it", async () => {
    const { h, ctx, found } = await home();
    const store = new AttachmentStore({ rootDir: join(h.dir, "attachments"), maxBytes: 1024 * 1024 });
    const scope = { agentId: "nouva", gatewayId: GADING_DM.gatewayId, chatId: GADING_DM.chatId };
    const sent = await store.store(scope, { type: "file", filename: "Back gate (rules).md", mimeType: "text/markdown" } as never, async () => new TextEncoder().encode("# Back gate\nLocked at 22:00, the key on the blue hook.\n"), 0);
    if (!isStored(sent)) throw new Error("the attachment was not stored");
    expect(sent.localPath.endsWith("-Back_gate__rules_.md")).toBe(true);
    const files = [
      { ref: "r0", name: "Other.md", localPath: join(h.dir, "attachments", "nouva", "x", "120000-aaaa-01-Other.md") },
      { ref: "r1", name: "Back gate (rules).md", localPath: sent.localPath },
    ];
    const write = createMemoryWriteTool(h.memory, { list: () => files as never });
    const keep = (file: string) => write.execute({ about: "knowledge", collection: "Notes", title: "Back gate rules", file }, ctx(GADING_DM, "Gading"));
    expect((await keep(sent.localPath)).isError).toBe(false);
    expect(readFileSync(join(h.knowledgeRoot, "notes", "Back gate (rules).md"), "utf8")).toContain("blue hook");
    expect(await found(GADING_DM, "hook")).toEqual(["knowledge:notes/Back gate (rules).md#0"]);
    // Carried into a group it is copied under one more prefix, which is taken off before it is looked for.
    expect((await keep(store.copyFor({ ...scope, chatId: "1203@g.us" }, "ref", sent.localPath))).isError).toBe(false);
    expect(readFileSync(join(h.knowledgeRoot, "notes", "Back gate (rules) (2).md"), "utf8")).toContain("blue hook");
  });

  test("into a collection wider than the chat it waits for an admin's yes, unsearched; approved, it joins; declined, it is gone", async () => {
    const { h, keep, found } = await home();
    mkdirSync(join(h.knowledgeRoot, "house"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "house", "knowledge.toml"), 'name = "House"\nreaders = "everyone"\n');
    const waiting = await keep({ collection: "House", title: "Wifi", content: "The guest network is called Tamu." }, GADING_DM, "");
    expect(waiting).toMatchObject({ isError: false, content: '"House" is open to more people than this chat, so the document waits for an admin\'s yes on the dashboard before it joins it. Tell them so.' });
    // Not searched, however often the folder is synced: what waits is in the collection's hidden folder.
    await h.memory.knowledge.sync();
    expect(await found(GADING_DM, "tamu")).toEqual([]);

    const hono = new Hono<{ Variables: { principal: unknown } }>();
    const role = { current: "operator" };
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role: role.current });
      await next();
    });
    registerKnowledgeRoutes(hono as never, { ctx: { config: h.config }, memory: h.memory, registry: { get: () => undefined }, audit: { record: () => undefined } } as never);
    const pending = (await (await hono.request("/knowledge/house/pending")).json()) as { pending: { path: string; title: string; from: string; agent: string }[] };
    expect(pending.pending).toEqual([expect.objectContaining({ path: "Wifi.md", title: "Wifi", from: "Gading, in a one-to-one chat with nouva", agent: "nouva" })]);
    const post = (path: string) => ({ method: "POST", body: JSON.stringify({ path }), headers: { "content-type": "application/json" } });
    expect((await hono.request("/knowledge/house/pending/approve", post("Wifi.md"))).status).toBe(403);
    role.current = "admin";
    expect((await hono.request("/knowledge/house/pending/approve", post("Wifi.md"))).status).toBe(200);
    expect(await found(SAM_DM, "tamu", "nix")).toEqual(["knowledge:house/Wifi.md#0"]);

    await keep({ collection: "House", title: "Alarm", content: "The code is in the drawer." });
    expect((await hono.request("/knowledge/house/pending/decline", post("Alarm.md"))).status).toBe(200);
    expect(((await (await hono.request("/knowledge/house/pending")).json()) as { pending: unknown[] }).pending).toEqual([]);
  });

  test("a folder made by hand is the one admin's: saved from their chat at once; an archived collection says so", async () => {
    const { h, keep, found } = await home();
    mkdirSync(join(h.knowledgeRoot, "ops"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "ops", "runbook.md"), "# Runbook\nVzdump at 02:00.\n");
    // Gading is the household's one admin (the fixture's), so the admins' folder reaches nobody beyond this chat.
    const kept = await keep({ collection: "ops", title: "Backups", content: "PBS at 03:00." });
    expect(kept.content).toBe('Kept in "ops" as Backups.md. It can be searched now.');
    expect(await found(GADING_DM, "pbs")).toEqual(["knowledge:ops/Backups.md#0"]);
    writeFileSync(join(h.knowledgeRoot, "ops", "knowledge.toml"), 'readers = "admins"\narchived = true\n');
    const archived = await keep({ collection: "ops", title: "Restore", content: "Restore from PBS." });
    expect(archived.content).toBe('Kept in "ops" as Restore.md. The collection is archived, so it is kept but not searched until someone brings it back.');
  });

  test("without a knowledge base, a document is refused, never written into MEMORY.md", async () => {
    const h = await household();
    open.push(h);
    const agentDir = join(h.dir, "agents", "nouva");
    mkdirSync(agentDir, { recursive: true });
    const result = await createMemoryWriteTool().execute({ about: "knowledge", collection: "House", title: "Wifi", content: "Tamu." }, { agentId: "nouva", agentDir, sessionId: "s", signal: new AbortController().signal, ...GADING_DM } as never);
    expect(result).toMatchObject({ isError: true, content: "Documents cannot be kept here: this Nouride has no knowledge base." });
    expect(existsSync(join(agentDir, "MEMORY.md"))).toBe(false);
  });

  test("agents are told where things go, and to ask once when it is not clear", () => {
    const lines = renderMemory({ ctx: { harness: {}, tools: [{ name: "memory_search" }] }, toolNames: [], gated: [], free: [] } as never);
    expect(lines).toContain(
      '- Where things go: what a person says about themselves or their life is memory, filed each night or kept with `about: "person"`; a document, a file or a link someone hands you to keep for reference goes in the knowledge base with `about: "knowledge"`; how you work is your MEMORY.md. Never turn one into another. When it is not clear that something is to be kept as a document, ask once.',
    );
  });
});
