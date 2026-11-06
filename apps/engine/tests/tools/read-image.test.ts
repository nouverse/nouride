/**
 * Pictures an agent did not receive in a message (`tools/builtins/read-image.ts`): a screenshot it took,
 * and an image a tool handed back.
 *
 * `read` refused every image as binary, so the skills that told an agent to look at its screenshot told it
 * to do something that failed. Each case is a way the picture must reach the model — or a way it must
 * say plainly that it did not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileBytes, realPath, removePath, writeFileAtomic, writeTextFile } from "@nouride/runtime";
import type { ImageRefPart, ToolContext } from "@nouride/shared";
import { createReadTool } from "@/modules/tools/builtins/files.ts";
import { lookAtReturned, type ReadImages } from "@/modules/tools/builtins/read-image.ts";
import { tempDir } from "../helpers.ts";

const readTool = createReadTool();

/** A 1×1 PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

let dir: string;
const ctx = (): ToolContext =>
  ({
    agentId: "nouva",
    sessionId: "s1",
    chatId: "c1",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u1",
    chatType: "dm",
    workspaceDir: dir,
    agentDir: dir,
    workspaceRoots: [dir],
    scratchpadDir: join(dir, "scratch"),
    signal: new AbortController().signal,
  }) as ToolContext;

const described: string[] = [];
const images = (mode: "native" | "described" | "off", maxBytes = 8 * 1024 * 1024): ReadImages => ({
  mode: () => mode,
  describe: async (_ctx, input) => {
    described.push(input.mimeType);
    return { description: "a single grey pixel" };
  },
  maxBytes: () => maxBytes,
});

beforeEach(async () => {
  dir = tempDir("read-image");
  described.length = 0;
  await writeFileAtomic(join(dir, "shot.png"), PNG);
  await writeTextFile(join(dir, "notes.md"), "the button is top right\n");
});
afterEach(() => removePath(dir));

describe("read, on a picture", () => {
  test("puts it in front of the model, by its path — and says to read it again when a request leaves it out", async () => {
    const result = await createReadTool(images("native")).execute({ path: "shot.png" }, ctx());

    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("the picture follows these results");
    const [picture] = (result.media ?? []) as ImageRefPart[];
    // Resolved, as every path `read` opens is — on macOS the temp dir is a symlink into /private.
    const path = realPath(join(dir, "shot.png"));
    expect(picture).toEqual({ type: "image_ref", ref: `file:${path}`, localPath: path, mimeType: "image/png", filename: "shot.png" });
  });

  test("asks the image model when the conversation model cannot look", async () => {
    const result = await createReadTool(images("described")).execute({ path: "shot.png" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.media).toBeUndefined();
    expect(String(result.content)).toContain("a single grey pixel");
    expect(described).toEqual(["image/png"]);
  });

  test("says it was not read when the daemon reads no images", async () => {
    const result = await createReadTool(images("off")).execute({ path: "shot.png" }, ctx());

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("`[media] read_images` switched off");
  });

  test("a picture too heavy to send is refused with how to make a smaller one, not sent and dropped", async () => {
    const result = await createReadTool(images("native", 10)).execute({ path: "shot.png" }, ctx());

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("smaller copy");
    expect(result.media).toBeUndefined();
  });

  test("a format no model takes is refused with the conversion, as before", async () => {
    await writeFileAtomic(join(dir, "scan.tiff"), PNG);
    const result = await createReadTool(images("native")).execute({ path: "scan.tiff" }, ctx());

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("convert this one first");
  });

  test("several paths at once: the text and the picture, both", async () => {
    const result = await createReadTool(images("native")).execute({ paths: ["notes.md", "shot.png"] }, ctx());

    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("the button is top right");
    expect((result.media ?? []).map((part) => (part as ImageRefPart).filename)).toEqual(["shot.png"]);
  });

  test("one call opens every picture it is given — there is no count (0.8.12)", async () => {
    // It opened four and named the rest; the owner: no limit on pictures.
    const names = Array.from({ length: 8 }, (_, i) => `still-${i}.png`);
    for (const name of names) await writeFileAtomic(join(dir, name), PNG);
    const result = await createReadTool(images("native")).execute({ paths: ["notes.md", ...names] }, ctx());

    expect(result.isError).toBe(false);
    expect((result.media ?? []).map((part) => (part as ImageRefPart).filename)).toEqual(names);
    expect(String(result.content)).toContain("the button is top right");
    expect(String(result.content)).not.toContain("Not opened");
  });

  test("outside the workspace is still outside — a picture is no way around the roots", async () => {
    await expect(createReadTool(images("native")).execute({ path: "/etc/hosts.png" }, ctx())).rejects.toThrow(/escapes workspace|outside/);
  });

  test("a reader built without the daemon's answers refuses it, as it always did", async () => {
    const result = await readTool.execute({ path: "shot.png" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.media).toBeUndefined();
  });
});

describe("a picture a tool returned", () => {
  test("is saved in the scratchpad and shown, so it can be read again later", async () => {
    const shown = await lookAtReturned(images("native"), ctx(), "browser__screenshot", [
      { data: PNG_BASE64, mimeType: "image/png" },
      { data: "AAAA", mimeType: "image/svg+xml" },
    ]);

    expect(shown.media).toHaveLength(1);
    const [picture] = shown.media;
    expect(picture!.localPath.startsWith(join(dir, "scratch", "tool-images", "browser__screenshot-"))).toBe(true);
    expect(await readFileBytes(picture!.localPath)).toEqual(PNG);
    expect(shown.lines[0]).toContain("the picture follows these results");
    // A format no model takes is said, not silently dropped.
    expect(shown.lines[1]).toContain("image/svg+xml");
  });
});
