/**
 * A picture too large on a side, through a whole turn: what the provider is sent.
 *
 * A long screenshot in a room that already held many pictures was refused by the provider, and the conversation kept
 * it: every turn after ended the same way, whatever was asked (seen on a live install). The resolver's own cases are in
 * `tests/llm/images.test.ts` and the converter's in `shrink-image.test.ts`; this is that the turn a person starts is
 * built with both, and follows `[media] max_image_side`.
 *
 * Whatever this machine has: with an ffmpeg that runs the provider gets a smaller copy, without one the line that says
 * why not. Either way nothing past the bound goes out, which is the whole point.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { runCommand, whichBinary } from "@nouride/runtime";
import { imageSize, type Gateway } from "@nouride/shared";
import { ChatAttachmentIndex } from "@/modules/attachments/chat-attachments.store.ts";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

/** Whether the ffmpeg a daemon would find here runs: what decides which of the two the provider is sent. */
const found = whichBinary("ffmpeg");
const works = found !== null && (await runCommand([found, "-version"], { cwd: tmpdir(), timeoutMs: 5000, maxOutputBytes: 4096, env: {} })).exitCode === 0;

/** A real PNG of bands of colour, `width` by `height`: one a decoder reads, small because it repeats. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.alloc(1 + width * 3, Math.floor(y / 40) % 2 === 0 ? 0x30 : 0xd0);
    line[0] = 0;
    rows.push(line);
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]));
}

const SCREENSHOT = png(1280, 6000);

/** A daemon whose one bot is sent the screenshot, and what its provider was asked. */
async function sentTheScreenshot(media: Record<string, unknown> = {}) {
  const bot = new FakeGateway("telegram:nouva", "telegram");
  (bot as Gateway).fetchAttachment = async () => SCREENSHOT;
  bench = await pipelineBench({
    turns: [{ text: "A long chat." }],
    gateway: bot,
    config: Object.keys(media).length > 0 ? { media } : {},
    deps: ({ db, dataDir }) => ({
      attachmentIndex: new ChatAttachmentIndex(db),
      attachments: new AttachmentStore({ rootDir: join(dataDir, "attachments"), maxBytes: 8_000_000 }),
    }),
  });
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  bot.receive(
    envelope({
      gatewayId: bot.id,
      chatId: "814",
      senderId: "814",
      timestamp: Date.now(),
      text: "what does this say?",
      attachments: [{ type: "image", mimeType: "image/png", filename: "chat.png", url: "https://files.test/chat.png" }],
    }),
  );
  await bench.pipeline.idle();
  expect(bench.requests).toHaveLength(1);
  const asked = JSON.stringify(bench.requests[0]);
  /** Every picture in the request, as its size in pixels. */
  const pictures = [...asked.matchAll(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/g)].map((found) => imageSize(new Uint8Array(Buffer.from(found[1]!, "base64"))));
  return { asked, pictures, reply: bot.lastText() };
}

describe("a screenshot 1280 by 6000 sent to an agent", () => {
  test("reaches the provider no larger than the bound on a side, or as the line that says why not, and the turn answers", async () => {
    const { asked, pictures, reply } = await sentTheScreenshot();

    expect(reply).toBe("A long chat.");
    for (const size of pictures) expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBeLessThanOrEqual(2576);
    if (works) {
      // This machine has an ffmpeg that runs: a copy was made, the same shape, as tall as the bound.
      expect(pictures).toHaveLength(1);
      expect(pictures[0]!.height).toBe(2576);
      expect(asked).not.toContain("pixels, more than");
    } else {
      expect(pictures).toHaveLength(0);
      expect(asked).toContain("chat.png: 1280x6000 pixels, more than the 2576 a side a model is sent");
    }
  });

  test("goes as it is where `[media] max_image_side` allows it: the setting is the bound", async () => {
    const { asked, pictures } = await sentTheScreenshot({ max_image_side: 6000 });
    expect(pictures).toEqual([{ width: 1280, height: 6000 }]);
    expect(asked).not.toContain("pixels, more than");
  });
});

describe("every turn the daemon runs", () => {
  const SRC = join(import.meta.dir, "../../src");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));

  test("is built with the fit: a job, a helper, a peer and a side question resolve the same pictures a chat turn does", () => {
    // Where an executor is built. `brain.ts` hands on the deps it was given, so it is not one of them.
    const builders = sources(SRC)
      .filter((file) => !file.endsWith("pipeline/brain.ts"))
      .filter((file) => /\bbrainFor\(|new TurnExecutor\(/.test(readFileSync(file, "utf8")));
    const names = builders.map((file) => file.slice(SRC.length + 1)).sort();
    // The walk found the ones this was written for, or an empty list would pass for the wrong reason.
    expect(names).toEqual(
      expect.arrayContaining(["modules/pipeline/job-turns.ts", "modules/pipeline/peer-turn.ts", "modules/pipeline/side-question.ts", "modules/pipeline/subagent.ts", "modules/pipeline/turn-brain.ts"]),
    );
    const without = builders.filter((file) => !/\bfitImages: /.test(readFileSync(file, "utf8"))).map((file) => file.slice(SRC.length + 1));
    expect(without).toEqual([]);
  });
});
