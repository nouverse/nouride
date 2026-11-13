/**
 * `send_file` with several files: one set, in order, whole or not at all.
 *
 * A call sent one file. The eight slides of a carousel were eight calls and eight messages, each a step of the turn,
 * arriving one by one in whatever order the uploads were taken. `paths` sends them together: handed to the gateway as
 * one message whose files are one set, which a platform with albums shows as one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Attachment, ToolContext } from "@nouride/shared";
import { createSendFileTool } from "@/modules/tools/builtins/attach.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-sendseveral-"));
/** The smallest file that is a PNG to anything that looks at its first bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

let together: Attachment[][];
let alone: Attachment[];
let delivered: boolean;
let refused: string | undefined;

function tool(o: { albums?: boolean; childEnv?: Record<string, string> } = {}) {
  return createSendFileTool({
    send: async (_ctx, attachment) => {
      alone.push(attachment);
      return { ids: [`m${alone.length}`], delivered, ...(refused ? { refused } : {}) };
    },
    ...(o.albums === false ? {} : { sendTogether: async (_ctx: ToolContext, attachments: readonly Attachment[]) => (together.push([...attachments]), { ids: ["a1"], delivered, ...(refused ? { refused } : {}) }) }),
    maxBytes: 1024,
    ...(o.childEnv ? { childEnv: () => o.childEnv! } : {}),
  });
}

const ctx = { agentId: "nouva", sessionId: "ses_1", chatId: "12345", gateway: "telegram", gatewayId: "telegram:main", senderId: "u", workspaceDir: DIR, agentDir: DIR, workspaceRoots: [DIR], signal: new AbortController().signal } as unknown as ToolContext;
const slides = ["slide-01.png", "slide-02.png", "slide-03.png"];

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "carousel"), { recursive: true });
  for (const name of slides) writeFileSync(join(DIR, "carousel", name), PNG);
  together = [];
  alone = [];
  delivered = true;
  refused = undefined;
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

const paths = slides.map((name) => `carousel/${name}`);

describe("several files in one call", () => {
  test("go out as one set, in the order given, the caption once on the first", async () => {
    const result = await tool().execute({ paths, caption: "Tiga langkah menyeduh kopi" }, ctx);
    expect(result.isError).toBe(false);
    expect(together).toHaveLength(1);
    expect(together[0]!.map((file) => file.filename)).toEqual(slides);
    expect(together[0]!.map((file) => file.caption)).toEqual(["Tiga langkah menyeduh kopi", undefined, undefined]);
    expect(together[0]!.every((file) => file.type === "image" && file.buffer?.byteLength === PNG.byteLength)).toBe(true);
    // Nothing went through the port for one file.
    expect(alone).toEqual([]);
    expect(result.content).toBe(`Sent 3 files (${PNG.byteLength * 3}B) to this conversation, together and in this order: \`slide-01.png\`, \`slide-02.png\`, \`slide-03.png\`.`);
  });

  test("every file is checked before any is sent: one that does not pass, and nothing goes", async () => {
    writeFileSync(join(DIR, "carousel", "empty.png"), "");
    writeFileSync(join(DIR, "carousel", "notes.txt"), "deploy with DEPLOY-VALUE-123456");
    for (const [bad, why] of [
      ["carousel/missing.png", "Nothing was sent: `carousel/missing.png` does not exist."],
      ["carousel/empty.png", "Nothing was sent: `carousel/empty.png` is empty, so there is nothing to send."],
      ["../outside.png", "Nothing was sent: `../outside.png` is outside the directories you may use (1 configured)."],
      ["carousel", "Nothing was sent: `carousel` is a directory."],
    ] as const) {
      const result = await tool().execute({ paths: [paths[0], bad, paths[2]] }, ctx);
      expect(result).toEqual({ content: why, isError: true });
    }
    // The same refusal of a text holding one of the agent's credentials as for one file.
    const leaking = await tool({ childEnv: { DEPLOY_TOKEN: "DEPLOY-VALUE-123456" } }).execute({ paths: [paths[0], "carousel/notes.txt"] }, ctx);
    expect(leaking.content).toStartWith("Nothing was sent: `carousel/notes.txt` contains the value of one of your credentials");
    expect(together).toEqual([]);
    expect(alone).toEqual([]);
  });

  test("a set the platform refused, or that did not get out, is said as that", async () => {
    delivered = false;
    expect((await tool().execute({ paths }, ctx)).content).toBe("The 3 files could not be delivered: the gateway did not accept them. They may arrive when the connection recovers.");
    refused = "Bad Request: chat not found";
    const result = await tool().execute({ paths }, ctx);
    expect(result).toEqual({ content: "The 3 files could not be delivered, because the platform refused them: Bad Request: chat not found. Sending them again here will not help.", isError: true });
  });

  test("where nothing sends a set as one, they go one after another in order, and stop at the first that does not arrive", async () => {
    const result = await tool({ albums: false }).execute({ paths, caption: "Urut" }, ctx);
    expect(result.isError).toBe(false);
    expect(alone.map((file) => [file.filename, file.caption])).toEqual([["slide-01.png", "Urut"], ["slide-02.png", undefined], ["slide-03.png", undefined]]);
    alone = [];
    delivered = false;
    expect((await tool({ albums: false }).execute({ paths }, ctx)).isError).toBe(true);
    expect(alone.map((file) => file.filename)).toEqual(["slide-01.png"]);
  });

  test("one path in the list is one file, sent as one always was", async () => {
    const result = await tool().execute({ paths: [paths[1]], caption: "Satu" }, ctx);
    expect(result.content).toBe(`Sent \`slide-02.png\` (${PNG.byteLength}B) to this conversation.`);
    expect(alone.map((file) => [file.filename, file.caption])).toEqual([["slide-02.png", "Satu"]]);
    expect(together).toEqual([]);
  });

  test("more than twenty in one call, or a list beside a path or a url, is refused before anything is read", async () => {
    const many = Array.from({ length: 21 }, (_, index) => `carousel/s${index}.png`);
    expect((await tool().execute({ paths: many }, ctx)).content).toBe("`paths` holds 21 files, and one call sends 20 at most. Send them in two calls, or as one archive.");
    for (const args of [{ paths, path: paths[0] }, { paths, url: "https://example.com/a.png" }]) {
      expect(await tool().execute(args, ctx)).toEqual({ content: "Give one of `path`, `paths` or `url`, not more.", isError: true });
    }
    expect(together).toEqual([]);
  });

  test("the tool says it, in the words a model reads: several that belong together go in ONE call", () => {
    const { definition } = tool();
    expect(definition.description).toContain("`paths` for several that belong together (the slides of a carousel, the pages of a scan) in ONE call");
    const fields = (definition.parameters as { properties: Record<string, { description: string; type: string }> }).properties;
    expect(fields.paths).toMatchObject({ type: "array", description: "Several files of your workspace, sent together in this order: one album where the chat has albums. Instead of `path`." });
  });
});
