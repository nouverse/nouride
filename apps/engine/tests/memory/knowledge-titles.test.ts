/**
 * A document's title as the pointer search finds it by, in any language (0.8.23): kept beside the file's name in the
 * collection's `knowledge.toml`, first in each section's trail, so search by words and by meaning both carry it. An agent
 * gives an English one when it keeps a document; a person sets one on the dashboard or with `nouride knowledge title`.
 *
 * Needed because English words found nothing in Indonesian documents on a box searching by words
 * alone, the default of a new install, and documents keep the language they were written in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { join } from "node:path";
import { parseSettings, renderSettings } from "@/modules/memory/knowledge/collections.ts";
import { createMemoryWriteTool } from "@/modules/tools/builtins/memory.ts";
import { registerKnowledgeRoutes } from "@/modules/web/control/routes/knowledge.ts";
import { GADING_DM, household, speaker, type Household } from "./fixture.ts";

const open: Household[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});

async function home() {
  const h = await household();
  open.push(h);
  const put = (path: string, text: string) => {
    mkdirSync(join(h.knowledgeRoot, path, ".."), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, path), text);
  };
  const found = async (query: string) => (await h.memory.search(speaker(GADING_DM), { query, kind: "knowledge" })).map((hit) => (hit.kind === "section" ? hit.section.item : ""));
  const workspace = join(h.dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const ctx = { agentId: "nouva", agentDir: join(h.dir, "agents", "nouva"), sessionId: "s", signal: new AbortController().signal, ...GADING_DM, workspaceDir: workspace, workspaceRoots: [workspace], readOnlyRoots: [] } as never;
  const write = createMemoryWriteTool(h.memory);
  const keep = (args: Record<string, unknown>) => write.execute({ about: "knowledge", ...args }, ctx);
  return { h, put, found, workspace, keep };
}

/** An Indonesian document, as a person's legal papers are: no English word in it. */
const NIB = "PEMERINTAH REPUBLIK INDONESIA\n\nNomor Induk Berusaha 1234567890123 diterbitkan kepada PT Contoh Teknologi Indonesia, bentuk usaha Perseroan Perorangan.\n";
const TITLE = "NIB, business registration certificate (Nomor Induk Berusaha)";

describe("a document's title, what search finds it by", () => {
  test("English words find a document written in Indonesian through its title, by words alone", async () => {
    const { h, put, found } = await home();
    put("legal/knowledge.toml", 'name = "Legal"\nreaders = ["gading"]\n');
    put("legal/nib.txt", NIB);
    await h.memory.knowledge.sync();
    expect(await found("business registration")).toEqual([]);

    expect(await h.memory.knowledge.retitle("legal", "nib.txt", TITLE)).toMatchObject({ document: { title: TITLE, status: "indexed" } });
    expect(await found("business registration")).toEqual(["knowledge:legal/nib.txt#0"]);
    // Its own words still find it, and its trail keeps what the file says of itself after the title.
    expect(await found("diterbitkan perseroan")).toEqual(["knowledge:legal/nib.txt#0"]);
    expect(h.memory.knowledge.sectionsOf("legal", "nib.txt")[0]!.trail).toBe(`${TITLE} › nib`);
    // The file keeps its name; the title is beside it.
    expect(existsSync(join(h.knowledgeRoot, "legal", "nib.txt"))).toBe(true);
    expect(readFileSync(join(h.knowledgeRoot, "legal", "knowledge.toml"), "utf8")).toContain(`[titles]\n"nib.txt" = ${JSON.stringify(TITLE)}`);
  });

  test("a title survives a sync, a change to the collection's settings, and is read from a hand-written knowledge.toml", async () => {
    const { h, put, found } = await home();
    put("legal/knowledge.toml", 'name = "Legal"\nreaders = ["gading"]\n');
    put("legal/nib.txt", NIB);
    await h.memory.knowledge.sync();
    await h.memory.knowledge.retitle("legal", "nib.txt", TITLE);
    const collection = h.memory.knowledge.collection("legal")!;
    await h.memory.knowledge.configure("legal", { ...collection.settings, description: "The company's papers" });
    await h.memory.knowledge.sync();
    expect(h.memory.knowledge.document("legal", "nib.txt")?.title).toBe(TITLE);
    expect(h.memory.knowledge.collection("legal")!.settings.titles).toEqual({ "nib.txt": TITLE });

    // Written by hand, with the file unchanged: read again at the next sync with its title.
    put("legal/npwp.txt", "Nomor Pokok Wajib Pajak 01.234.567.8-901.000\n");
    await h.memory.knowledge.sync();
    expect(await found("tax card")).toEqual([]);
    put("legal/knowledge.toml", `name = "Legal"\nreaders = ["gading"]\n\n[titles]\n"nib.txt" = ${JSON.stringify(TITLE)}\n"npwp.txt" = "NPWP, company tax ID card"\n`);
    await h.memory.knowledge.sync();
    expect(await found("tax card")).toEqual(["knowledge:legal/npwp.txt#0"]);
  });

  test("taken off, the document's own title comes back; removed, its title goes with it", async () => {
    const { h, put, found } = await home();
    put("legal/knowledge.toml", 'name = "Legal"\nreaders = ["gading"]\n');
    put("legal/nib.txt", NIB);
    await h.memory.knowledge.sync();
    await h.memory.knowledge.retitle("legal", "nib.txt", TITLE);
    expect(await h.memory.knowledge.retitle("legal", "nib.txt", null)).toMatchObject({ document: { title: "nib" } });
    expect(await found("business registration")).toEqual([]);
    expect(h.memory.knowledge.collection("legal")!.settings.titles).toEqual({});

    await h.memory.knowledge.retitle("legal", "nib.txt", TITLE);
    expect(await h.memory.knowledge.remove("legal", "nib.txt")).toBe(true);
    expect(h.memory.knowledge.collection("legal")!.settings.titles).toEqual({});
    expect(await h.memory.knowledge.retitle("legal", "nib.txt", TITLE)).toMatchObject({ why: "missing" });
  });

  test("knowledge.toml's [titles]: written last and in order, read back the same; a value that is not a table is said, a bad entry dropped", () => {
    const { settings } = parseSettings("legal", 'name = "Legal"\nreaders = ["gading"]\n\n[titles]\n"z.pdf" = "Zed"\n"a b/c.pdf" = "A, with \\"quotes\\""\n"empty.pdf" = ""\n');
    expect(settings.titles).toEqual({ "z.pdf": "Zed", "a b/c.pdf": 'A, with "quotes"' });
    const written = renderSettings(settings);
    expect(written).toBe('name = "Legal"\nreaders = ["gading"]\n\n[titles]\n"a b/c.pdf" = "A, with \\"quotes\\""\n"z.pdf" = "Zed"\n');
    expect(parseSettings("legal", written).settings).toEqual(settings);
    expect(parseSettings("legal", 'name = "Legal"\ntitles = "nib"\n')).toMatchObject({ settings: { titles: {} }, problem: "titles is not a table of file names and their titles" });
  });
});

describe("an agent keeping a document gives it an English title", () => {
  test("a file is kept under its own name, its title beside it, and found by the title's words", async () => {
    const { h, workspace, keep, found } = await home();
    writeFileSync(join(workspace, "NIB.txt"), NIB);
    expect(await keep({ collection: "Legal", title: TITLE, file: "NIB.txt" })).toMatchObject({ isError: false });
    expect(existsSync(join(h.knowledgeRoot, "legal", "NIB.txt"))).toBe(true);
    expect(h.memory.knowledge.document("legal", "NIB.txt")?.title).toBe(TITLE);
    expect(await found("business registration")).toEqual(["knowledge:legal/NIB.txt#0"]);
  });

  test("a page whose text has a heading of its own keeps the English title too", async () => {
    const { h, keep, found } = await home();
    expect(await keep({ collection: "Legal", title: "Company founding statement", content: "# Surat Pernyataan Pendirian\n\nPendiri menyatakan mendirikan perseroan perorangan.\n" })).toMatchObject({ isError: false });
    const [document] = h.memory.knowledge.documents("legal");
    expect(document?.title).toBe("Company founding statement");
    expect(await found("founding statement")).toEqual([`knowledge:legal/${document!.path}#0`]);
  });

  test("without a title, or with one that is not English, nothing is kept and the agent is told how", async () => {
    const { h, workspace, keep } = await home();
    writeFileSync(join(workspace, "NIB.txt"), NIB);
    const told =
      'Give the document a `title` in English: what it is, with its own terms as they are, e.g. "NIB, business registration certificate (Nomor Induk Berusaha)". Search finds it by those words in any language.';
    expect(await keep({ collection: "Legal", file: "NIB.txt" })).toEqual({ content: told, isError: true });
    expect(await keep({ collection: "Legal", title: "Surat izin usaha dari pemerintah untuk perusahaan", file: "NIB.txt" })).toEqual({ content: `${told} This one is not in English.`, isError: true });
    expect(await keep({ collection: "Legal", title: "x".repeat(201), file: "NIB.txt" })).toMatchObject({ isError: true });
    expect(existsSync(join(h.knowledgeRoot, "legal"))).toBe(false);
  });

  test("approved from waiting, a file's title goes with it", async () => {
    const { h, workspace, keep, found } = await home();
    mkdirSync(join(h.knowledgeRoot, "house"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "house", "knowledge.toml"), 'name = "House"\nreaders = "everyone"\n');
    writeFileSync(join(workspace, "wifi.txt"), "Jaringan tamu bernama Tamu, sandinya di laci.\n");
    expect(await keep({ collection: "House", title: "Guest wifi network", file: "wifi.txt" })).toMatchObject({ isError: false, metadata: { waiting: true } });
    expect(await h.memory.knowledge.approve("house", "wifi.txt")).toMatchObject({ path: "wifi.txt", document: { title: "Guest wifi network" } });
    expect(await found("guest wifi")).toEqual(["knowledge:house/wifi.txt#0"]);
  });

  test("the agent's words: an English title for every document, found by in any language", async () => {
    const { h } = await home();
    const tool = createMemoryWriteTool(h.memory);
    expect(tool.definition.description).toContain("an English `title`, and the text as `content` or a `file`");
    expect(JSON.stringify(tool.definition.parameters)).toContain(
      'For about=knowledge: what the document is, in English with its own terms, e.g. \\"NIB, business registration certificate (Nomor Induk Berusaha)\\". Search finds it by these words in any language.',
    );
  });
});

describe("a document's title from the dashboard", () => {
  test("PATCH sets it, an empty one takes it off, a long one and a missing document are refused", async () => {
    const { h, put, found } = await home();
    put("legal/knowledge.toml", 'name = "Legal"\nreaders = ["gading"]\n');
    put("legal/nib.txt", NIB);
    await h.memory.knowledge.sync();
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    const audited: unknown[] = [];
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role: "operator" });
      await next();
    });
    registerKnowledgeRoutes(hono as never, { ctx: { config: h.config }, memory: h.memory, registry: { get: () => undefined }, audit: { record: (row: unknown) => audited.push(row) } } as never);
    const patch = (path: string, body: unknown) => hono.request(`/knowledge/legal/documents?path=${encodeURIComponent(path)}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

    const set = await patch("nib.txt", { title: `  ${TITLE}  ` });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ document: { title: TITLE } });
    expect(await found("business registration")).toEqual(["knowledge:legal/nib.txt#0"]);
    expect(audited).toEqual([{ action: "knowledge_document_titled", actor: "tester", details: { collection: "legal", document: "nib.txt", titled: true } }]);

    expect(await (await patch("nib.txt", { title: "" })).json()).toMatchObject({ document: { title: "nib" } });
    expect((await patch("nib.txt", { title: "x".repeat(201) })).status).toBe(400);
    expect((await patch("nib.txt", { title: 7 })).status).toBe(400);
    expect((await patch("gone.txt", { title: TITLE })).status).toBe(404);
  });
});
