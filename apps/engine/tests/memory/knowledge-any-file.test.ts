/**
 * The knowledge base keeps a file of any kind and hands it back. A file whose own words are not read (a picture, a
 * video, a scan) was listed with nothing to search, and the knowledge folder is none of an agent's directories: kept
 * there, a photo of a car's fuel code could not be found by the agent asked for it later, nor sent if it had been.
 *
 * It is found now by its title and by a line saying what it is, written by the agent that was shown it, and sent as it
 * is by the id search gives it, from a collection the chat it is asked from may be answered from and from no other.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "@nouride/shared";
import { foundBy } from "@/modules/memory/knowledge/sync.ts";
import { createSendFileTool } from "@/modules/tools/builtins/attach.ts";
import { createMemoryReadTool, createMemoryWriteTool, speakerOf } from "@/modules/tools/builtins/memory.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { FAMILY, GADING_DM, household, SAM_DM, speaker, type Household } from "./fixture.ts";

const open: Household[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});

/** A JPEG's first bytes and a body: what a chat app hands over as a photo, with no word in it. */
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(64).fill(7)]);
const TITLE = "Pertamina fuel subsidy QR code, Honda BR-V";
const LINE = "The QR code a pump attendant scans for subsidised Pertalite: car BG 1891 ZD, made on 5 October.";
const ITEM = "knowledge:car/brv-qr.jpg#0";

async function home() {
  const h = await household();
  open.push(h);
  const workspace = join(h.dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "brv-qr.jpg"), PHOTO);
  const ctx = (where: typeof GADING_DM, agentId = "nouva") =>
    ({ agentId, agentDir: join(h.dir, "agents", agentId), sessionId: "s", signal: new AbortController().signal, ...where, workspaceDir: workspace, workspaceRoots: [workspace], readOnlyRoots: [] }) as never;
  const write = createMemoryWriteTool(h.memory);
  const keep = (args: Record<string, unknown>, where = GADING_DM) => write.execute({ about: "knowledge", ...args }, ctx(where));
  const found = async (where: typeof GADING_DM, query: string, agentId = "nouva") =>
    (await h.memory.search(speaker(where, agentId), { query, kind: "knowledge" })).map((hit) => (hit.kind === "section" ? hit.section.item : ""));
  const sent: Attachment[] = [];
  const send = createSendFileTool({
    send: async (_ctx, attachment) => (sent.push(attachment), { ids: ["m1"], delivered: true }),
    maxBytes: 1024 * 1024,
    documentFile: (toolCtx, item) => h.memory.knowledge.fileOf(speakerOf(toolCtx), item),
  });
  return { h, workspace, ctx, keep, found, send, sent };
}

describe("a picture kept from a chat", () => {
  test("is found by a word of its title and by a word of the line about it, by its person and nobody else", async () => {
    const { h, keep, found } = await home();
    const kept = await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    expect(kept).toMatchObject({
      isError: false,
      content:
        'Kept in "Car" as brv-qr.jpg, a collection made now for the people in this chat. Nouride does not read the words of this kind of file. It is kept as it is, and found by its title and what is written about it. ' +
        `\`send_file\` with document="${ITEM}" sends the file itself, here or in any chat that may read this collection. This collection is its people's: used in a direct chat with one of them, and in a group on the turns one of them is the one speaking.`,
    });
    // The file is the file: not a word of the line is written into it.
    expect(new Uint8Array(readFileSync(join(h.knowledgeRoot, "car", "brv-qr.jpg")))).toEqual(PHOTO);
    expect(readFileSync(join(h.knowledgeRoot, "car", "knowledge.toml"), "utf8")).toContain(`[notes]\n"brv-qr.jpg" = ${JSON.stringify(LINE)}`);

    expect(await found(GADING_DM, "pertamina")).toEqual([ITEM]);
    expect(await found(GADING_DM, "attendant")).toEqual([ITEM]);
    expect(await found(SAM_DM, "pertamina", "nix")).toEqual([]);
    expect(h.memory.knowledge.document("car", "brv-qr.jpg")).toMatchObject({ status: "listed", sections: 1, title: TITLE });
  });

  test("with no line about it, it is found by its title, and the agent is told what to give to be found by more", async () => {
    const { keep, found } = await home();
    const kept = await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg" });
    expect(String(kept.content)).toContain("It is kept as it is, and found by its title. Say what it shows in `content`, kept with the same `file`, and it is found by that too.");
    expect(await found(GADING_DM, "pertamina")).toEqual([ITEM]);
    expect(await found(GADING_DM, "attendant")).toEqual([]);
  });

  test("opened by its id, it reads as its title and its line, never as words it does not have", async () => {
    const { h, keep, ctx } = await home();
    await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    const read = await createMemoryReadTool(h.memory).execute({ document: ITEM }, ctx(GADING_DM));
    expect(read.isError).toBe(false);
    expect(String(read.content)).toContain(`${TITLE}\n\n${LINE}`);
    const hits = await createMemorySearchTool(h.memory).execute({ query: "fuel code" }, ctx(GADING_DM));
    expect(String(hits.content)).toContain(`⟨${ITEM}⟩`);
  });
});

describe("what a file with no words of its own is found by", () => {
  test("its title, and what is written about it under the title", () => {
    expect(foundBy("A title", undefined)).toEqual([{ n: 0, trail: "A title", text: "A title" }]);
    expect(foundBy("A title", "What it shows.")).toEqual([{ n: 0, trail: "A title", text: "A title\n\nWhat it shows." }]);
  });

  test("a file put in a collection's folder by hand is found by its name, and by a note written in the settings later", async () => {
    const { h, found } = await home();
    mkdirSync(join(h.knowledgeRoot, "house"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "house", "knowledge.toml"), 'name = "House"\nreaders = ["gading"]\n');
    writeFileSync(join(h.knowledgeRoot, "house", "floorplan.png"), PHOTO);
    expect(await h.memory.knowledge.sync()).toMatchObject({ indexed: 0, notSearched: 1 });
    expect(await found(GADING_DM, "floorplan")).toEqual(["knowledge:house/floorplan.png#0"]);
    expect(await found(GADING_DM, "bedrooms")).toEqual([]);
    // Nothing changed: the file is not read again.
    expect(await h.memory.knowledge.sync()).toMatchObject({ unchanged: 1, notSearched: 0 });

    writeFileSync(join(h.knowledgeRoot, "house", "knowledge.toml"), 'name = "House"\nreaders = ["gading"]\n\n[notes]\n"floorplan.png" = "The upstairs plan, with three bedrooms."\n');
    expect(await h.memory.knowledge.sync()).toMatchObject({ unchanged: 0, notSearched: 1 });
    expect(await found(GADING_DM, "bedrooms")).toEqual(["knowledge:house/floorplan.png#0"]);
    expect(h.memory.knowledge.document("house", "floorplan.png")!.reason).toBe("Nouride does not read the words of this kind of file. It is kept as it is, and found by its title and what is written about it.");
  });

  test("a picture an install listed before, with nothing to find it by, is found by its name after the next sync", async () => {
    const { h, found } = await home();
    mkdirSync(join(h.knowledgeRoot, "house"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "house", "knowledge.toml"), 'name = "House"\nreaders = ["gading"]\n');
    writeFileSync(join(h.knowledgeRoot, "house", "floorplan.png"), PHOTO);
    await h.memory.knowledge.sync();
    // As the release before left it: the document's row, and no section of it in the index.
    h.db.prepare("DELETE FROM knowledge_sections WHERE collection = 'house'").run();
    h.db.prepare("UPDATE knowledge_documents SET sections = 0, reason = 'Nouride does not read this kind of file, so it is kept here but not searched.' WHERE collection = 'house'").run();
    expect(h.memory.knowledge.sectionsOf("house", "floorplan.png")).toEqual([]);

    expect(await h.memory.knowledge.sync()).toMatchObject({ unchanged: 0, notSearched: 1 });
    expect(await found(GADING_DM, "floorplan")).toEqual(["knowledge:house/floorplan.png#0"]);
    expect(h.memory.knowledge.document("house", "floorplan.png")!.reason).toBe("Nouride does not read the words of this kind of file. It is kept as it is, and found by its title.");
  });

  test("a file removed takes its note with it", async () => {
    const { h, keep } = await home();
    await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    expect(await h.memory.knowledge.remove("car", "brv-qr.jpg")).toBe(true);
    expect(readFileSync(join(h.knowledgeRoot, "car", "knowledge.toml"), "utf8")).not.toContain("brv-qr.jpg");
  });
});

describe("a link", () => {
  test("is kept as what it is and its address, found by the words, and read back with the address", async () => {
    const { h, keep, found, ctx } = await home();
    const kept = await keep({ collection: "Car", title: "MyPertamina sign-up page", content: "Where the fuel subsidy QR code is registered and renewed.", source: "https://subsiditepat.mypertamina.id/" });
    expect(kept).toMatchObject({ isError: false, content: expect.stringContaining("It can be searched now.") });
    const [item] = await found(GADING_DM, "renewed");
    expect(item).toBe("knowledge:car/MyPertamina sign-up page.md#0");
    expect(readFileSync(join(h.knowledgeRoot, "car", "MyPertamina sign-up page.md"), "utf8")).toContain("source: https://subsiditepat.mypertamina.id/");
    expect((await createMemoryReadTool(h.memory).execute({ document: item }, ctx(GADING_DM))).isError).toBe(false);
  });
});

describe("sent back as it is", () => {
  test("by the id search gave it: the original file, with its name, to the chat it is asked from", async () => {
    const { workspace, keep, send, sent, ctx } = await home();
    await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    // The copy it was kept from is gone, as a chat's attachment is in time: what is sent is the file kept.
    rmSync(join(workspace, "brv-qr.jpg"));
    const result = await send.execute({ document: ITEM, caption: "Your fuel code." }, ctx(GADING_DM));
    expect(result).toMatchObject({ isError: false, content: `Sent \`brv-qr.jpg\` (76B), the file kept as "${TITLE}", to this conversation.` });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ filename: "brv-qr.jpg", type: "image", mimeType: "image/jpeg", caption: "Your fuel code.", size: PHOTO.length });
    expect(new Uint8Array(sent[0]!.buffer!)).toEqual(PHOTO);
  });

  test("with any agent of the install, in a direct chat with its person", async () => {
    const { keep, send, sent, ctx } = await home();
    await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    expect((await send.execute({ document: ITEM }, ctx({ ...GADING_DM, gatewayId: "telegram:nix" }, "nix"))).isError).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("refused where the chat may not be answered from the collection, and nothing is put on the wire", async () => {
    const { keep, send, sent, ctx } = await home();
    await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    for (const where of [SAM_DM, { ...FAMILY, senderId: "62877" }]) {
      expect(await send.execute({ document: ITEM }, ctx(where))).toMatchObject({ isError: true, content: `no document "${ITEM}" that this chat may read` });
    }
    expect(sent).toEqual([]);
  });

  test("an id that names no document, a path dressed as one, and a file since deleted are each said", async () => {
    const { h, keep, send, sent, ctx } = await home();
    await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    expect(await send.execute({ document: "knowledge:car/other.jpg#0" }, ctx(GADING_DM))).toMatchObject({ isError: true, content: 'no document "knowledge:car/other.jpg#0" that this chat may read' });
    // The settings file is in the folder and is no document: an id is looked up in the index, never joined to a path.
    expect((await send.execute({ document: "knowledge:car/knowledge.toml#0" }, ctx(GADING_DM))).isError).toBe(true);
    expect((await send.execute({ document: "knowledge:car/../../config.toml#0" }, ctx(GADING_DM))).isError).toBe(true);
    expect((await send.execute({ document: "/etc/hosts" }, ctx(GADING_DM))).isError).toBe(true);

    rmSync(join(h.knowledgeRoot, "car", "brv-qr.jpg"));
    expect(await send.execute({ document: ITEM }, ctx(GADING_DM))).toMatchObject({ isError: true, content: `"${TITLE}" is no longer in "Car": its file is gone.` });
    expect(sent).toEqual([]);
  });

  test("one of `path`, `paths`, `document` or `url`, and `document` only where there is a knowledge base", async () => {
    const { send, ctx } = await home();
    expect(await send.execute({ document: ITEM, path: "brv-qr.jpg" }, ctx(GADING_DM))).toMatchObject({ isError: true, content: "Give one of `path`, `paths`, `document` or `url`, not more." });
    expect(JSON.stringify(send.definition.parameters)).toContain('"document"');

    const without = createSendFileTool({ send: async () => ({ ids: [], delivered: true }), maxBytes: 1024 });
    expect(JSON.stringify(without.definition)).not.toContain("document");
    expect(await without.execute({ document: ITEM }, ctx(GADING_DM))).toMatchObject({ isError: true, content: "Documents cannot be sent here: this Nouride keeps no knowledge base." });
  });

  test("the tools an agent is given send a kept file where memory has a knowledge base", async () => {
    const { h, keep, ctx, sent } = await home();
    await keep({ collection: "Car", title: TITLE, file: "brv-qr.jpg", content: LINE });
    const tools = createBuiltinTools({
      security: DEFAULT_CONFIG.security,
      memory: h.memory,
      sendFile: { send: async (_ctx, attachment) => (sent.push(attachment), { ids: ["m1"], delivered: true }), maxBytes: 1024 * 1024 },
    });
    expect((await tools.get("send_file")!.execute({ document: ITEM }, ctx(GADING_DM))).isError).toBe(false);
    expect(sent.map((attachment) => attachment.filename)).toEqual(["brv-qr.jpg"]);
    expect(existsSync(join(h.knowledgeRoot, "car", "brv-qr.jpg"))).toBe(true);
  });
});

describe("what the agent is told", () => {
  test("a file handed over to keep goes in the knowledge base, never a folder of its own, and comes back with `send_file`", async () => {
    const { h } = await home();
    const description = createMemoryWriteTool(h.memory).definition.description;
    expect(description).toContain("A picture, a video, a scan or any file whose words are not read is kept as it is: give `content` with it, saying what it shows, which search finds it by.");
    expect(description).toContain("A link is kept as `content` saying what it is and `source`.");
  });
});
