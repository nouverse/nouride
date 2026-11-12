/**
 * Turning the pointers a conversation stores into the pixels a model is sent.
 *
 * Every case here is a budget or a failure, because the happy path is one line and the rest is
 * what stops a daemon that runs in a few hundred megabytes from reading a folder of screenshots
 * into memory to answer a question about the newest one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ContentPart, ImageRefPart } from "@nouride/shared";
import { createProvider } from "@nouride/llm";
import { resolveImages } from "@/modules/llm/images.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-images-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** PNG's signature: what makes a file one the model may be sent. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `size` bytes of a PNG — its signature, then 0x07 — as the file on disk the ref points at. */
const pngBytes = (size: number) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, size - PNG.length), 7)]).subarray(0, Math.max(size, PNG.length));

/** A file of `size` bytes on disk, and the ref that points at it. */
function image(name: string, size = 16): ImageRefPart {
  const path = join(dir, name);
  writeFileSync(path, pngBytes(size));
  return { type: "image_ref", ref: `ref-${name}`, localPath: path, mimeType: "image/png", filename: name };
}

function userWith(...parts: ContentPart[]): ChatMessage {
  return { role: "user", content: [{ type: "text", text: "look at this" }, ...parts], timestamp: 0 };
}

const partsOf = (message: ChatMessage): ContentPart[] =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;

describe("resolving", () => {
  test("a ref becomes base64 the provider can be sent", async () => {
    const [message] = await resolveImages([userWith(image("a.png"))]);
    const parts = partsOf(message!);

    expect(parts[2]?.type).toBe("image");
    if (parts[2]?.type !== "image") throw new Error("unreachable");
    expect(parts[2].mimeType).toBe("image/png");
    // The 16 bytes asserted as the value, so a broken encoder cannot pass by producing *something* base64-shaped.
    expect(parts[2].data).toBe(pngBytes(16).toString("base64"));
  });

  test("messages with no images are returned untouched", async () => {
    /**
     * Identity, not a copy. Most turns carry no pictures and this runs on every one of them; a
     * fresh array per message per turn is allocation for nothing.
     */
    const messages: ChatMessage[] = [{ role: "user", content: "no pictures here", timestamp: 0 }];
    expect(await resolveImages(messages)).toBe(messages);
  });

  test("the caller's messages are never mutated", async () => {
    /**
     * The storage design depends on this. These are the session's own messages, and turning a
     * stored ref into a megabyte of base64 *in place* puts the base64 back in the database —
     * which is the thing the ref exists to keep out of it.
     */
    const original = userWith(image("a.png"));
    const before = JSON.stringify(original);
    await resolveImages([original]);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("the budget", () => {
  /** Room in a request for exactly `n` of the 16-byte test pictures: each travels as 24 bytes of base64. */
  const roomFor = (n: number) => ({ maxBytes: n * 24 });
  const opened = (name: string): ImageRefPart => {
    const part = image(name);
    return { ...part, ref: `file:${part.localPath}` };
  };

  test("there is no count: every picture goes while they fit (0.8.12)", async () => {
    // Four was the most a request carried. Live, an agent reviewing a video lost each set of stills as it opened the next
    // and re-read them, or decided they had never reached it. So there is no limit on pictures.
    const twelve = Array.from({ length: 12 }, (_, i) => opened(`still-${i}.png`));
    const out = await resolveImages([userWith(...twelve)]);
    expect(partsOf(out[0]!).filter((part) => part.type === "image")).toHaveLength(12);
  });

  test("past the bytes a request may carry, the newest win and the rest become a line of text", async () => {
    // Backwards on purpose: a person who sends five screenshots is describing a sequence, and the
    // question is about the end of it.
    const messages = Array.from({ length: 6 }, (_, i) => userWith(image(`img-${i}.png`)));
    const out = await resolveImages(messages, roomFor(4));

    const kinds = out.map((m) => partsOf(m).at(-1)?.type);
    expect(kinds.slice(-4)).toEqual(Array(4).fill("image"));
    expect(kinds.slice(0, 2)).toEqual(["text", "text"]);
  });

  test("what falls outside says how to get it back", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => userWith(image(`img-${i}.png`)));
    const out = await resolveImages(messages, roomFor(4));
    const dropped = partsOf(out[0]!)[1];

    expect(dropped?.type).toBe("text");
    if (dropped?.type !== "text") throw new Error("unreachable");
    // The ref, because the next thing a model wants is a way to look at it.
    expect(dropped.text).toContain("ref-img-0.png");
    expect(dropped.text).toContain("attachment_read");
  });

  test("a picture the agent opened says why it was left out — this step's too heavy, or older and seen (0.8.12)", async () => {
    // Live: told only "not in this request; `read` it to look at it again", a helper read the same stills until its turn
    // was ended, and an agent took back what it had written about stills it had seen. The pictures a step opened arrive
    // in one message after the model's last reply.
    const earlier = opened("old.png");
    const now = Array.from({ length: 5 }, (_, i) => opened(`new-${i}.png`));
    const reply: ChatMessage = { role: "assistant", content: "the next ones" };
    const out = await resolveImages([userWith(earlier), reply, userWith(...now)], roomFor(4));

    const step = partsOf(out[2]!);
    expect(step.filter((part) => part.type === "image")).toHaveLength(4);
    const notShown = step.at(-1);
    if (notShown?.type !== "text") throw new Error("expected the fifth to be left out");
    expect(notShown.text).toContain(now.at(-1)!.localPath);
    expect(notShown.text).toContain("not shown: the pictures opened in this step weigh more than");
    expect(notShown.text).toContain("Read it again with fewer at once, or make a smaller copy");
    expect(notShown.text).not.toContain("attachment_read");

    const older = partsOf(out[0]!)[1];
    if (older?.type !== "text") throw new Error("expected the older one to be left out");
    expect(older.text).toContain(earlier.localPath);
    expect(older.text).toContain("You saw it when it was opened: what you wrote about it then stands");
  });

  test("a picture opened again later points there, rather than saying to read it again", async () => {
    const shot = opened("shot.png");
    const reply: ChatMessage = { role: "assistant", content: "once more" };
    const out = await resolveImages([userWith(shot), reply, userWith(shot)]);
    const older = partsOf(out[0]!)[1];
    expect(older?.type === "text" ? older.text : "").toContain("opened again further down, and shown there");
    expect(partsOf(out[2]!).some((part) => part.type === "image")).toBe(true);
  });

  test("a file over the per-image ceiling is left out rather than sent", async () => {
    const out = await resolveImages([userWith(image("big.png", 4096))], { maxBytesEach: 1024 });
    expect(partsOf(out[0]!)[1]?.type).toBe("text");
  });

  test("the total ceiling counts the encoded size, not the file size", async () => {
    /**
     * Base64 is four bytes out for every three in, and it is the encoded form that travels. A
     * budget measured against the raw size lets a request through at a third over.
     */
    const out = await resolveImages([userWith(image("a.png", 900))], { maxBytes: 1000 });
    expect(partsOf(out[0]!)[1]?.type).toBe("text"); // 900 raw → 1200 encoded → over
  });

  test("the default byte budget is applied when no limit is passed", async () => {
    // This asserted the constants against themselves — more than zero, under 32 MB — and passed with
    // the default never applied. A picture whose base64 is past 16 MB is left out with no options
    // given; one just under it is sent. Sparse files: the size is read before any byte is.
    const sized = (name: string, base64Bytes: number) => {
      const part = image(name);
      truncateSync(part.localPath, Math.floor((base64Bytes / 4) * 3));
      return part;
    };
    // Spelled out rather than read off the constant, so raising the constant is caught here too.
    const over = await resolveImages([userWith(sized("over.png", 16 * 1024 * 1024 + 4))]);
    expect(partsOf(over[0]!).at(-1)?.type).toBe("text");
    const under = await resolveImages([userWith(sized("under.png", 64 * 1024))]);
    expect(partsOf(under[0]!).at(-1)?.type).toBe("image");
  });
});

/**
 * What a provider is sent is decided by the bytes: a label is somebody's claim. A ref stored before the store read its
 * bytes, or a picture the agent opened with `read`, can say PNG and be a JPEG — or be a HEIC, which a provider refuses
 * along with the whole request.
 */
describe("a picture too large on a side", () => {
  /** A PNG's header saying `width` by `height`, padded to `bytes`: the size is read from the header, nothing is decoded. */
  function sized(name: string, width: number, height: number, bytes = 64): ImageRefPart {
    const header = Buffer.alloc(25);
    header.writeUInt32BE(13, 0);
    header.write("IHDR", 4, "latin1");
    header.writeUInt32BE(width, 8);
    header.writeUInt32BE(height, 12);
    header.set([8, 2, 0, 0, 0], 16);
    const path = join(dir, name);
    writeFileSync(path, Buffer.concat([PNG, header, Buffer.alloc(Math.max(0, bytes - PNG.length - header.length), 7)]));
    return { type: "image_ref", ref: `ref-${name}`, localPath: path, mimeType: "image/png", filename: name };
  }
  /** What a converter hands back: a JPEG's first bytes, so the copy is told from the original by its type too. */
  const COPY = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const shrinking = (answer: { bytes: Uint8Array; mimeType: string } | null = { bytes: COPY, mimeType: "image/jpeg" }) => {
    const asked: [string, number][] = [];
    return { asked, shrink: async (path: string, maxSide: number) => (asked.push([path, maxSide]), answer) };
  };
  const imagesOf = (message: ChatMessage) => partsOf(message).filter((part) => part.type === "image");
  const textOf = (message: ChatMessage) => partsOf(message).map((part) => (part.type === "text" ? part.text : "")).join("\n");

  test("goes as a smaller copy: the long screenshot that ended every turn of its conversation", async () => {
    const { asked, shrink } = shrinking();
    const tall = sized("chat.png", 1280, 6000);
    const [message] = await resolveImages([userWith(tall)], { fit: { maxSide: 2576, shrink } });

    expect(asked).toEqual([[tall.localPath, 2576]]);
    const [sent] = imagesOf(message!);
    if (sent?.type !== "image") throw new Error("the picture was not sent");
    // The copy and its own type, never the original's bytes under the copy's name.
    expect(sent.data).toBe(COPY.toString("base64"));
    expect(sent.mimeType).toBe("image/jpeg");
    expect(textOf(message!)).not.toContain("pixels");
  });

  test("wide counts as tall does, and the bound itself is not past it", async () => {
    const { asked, shrink } = shrinking();
    const out = await resolveImages([userWith(sized("wide.png", 2577, 10), sized("edge.png", 2576, 2576), sized("small.png", 800, 600))], { fit: { maxSide: 2576, shrink } });
    expect(asked.map(([path]) => path)).toEqual([join(dir, "wide.png")]);
    expect(imagesOf(out[0]!)).toHaveLength(3);
  });

  test("with nothing to make a copy, it is left out with a line that says its size and the bound, and the others still go", async () => {
    const [message] = await resolveImages([userWith(sized("chat.png", 1280, 6000), image("ok.png"))], { fit: { maxSide: 2576 } });
    expect(imagesOf(message!)).toHaveLength(1);
    expect(textOf(message!)).toContain("[image: chat.png: 1280x6000 pixels, more than the 2576 a side a model is sent, and no smaller copy could be made here. Make one with your tools and read that, or ask for a smaller picture]");
  });

  test("a converter that could not make one leaves the same line, and so does a copy in a format no model takes", async () => {
    for (const answer of [null, { bytes: COPY, mimeType: "image/bmp" }]) {
      const [message] = await resolveImages([userWith(sized("chat.png", 1280, 6000))], { fit: { maxSide: 2576, shrink: shrinking(answer).shrink } });
      expect(imagesOf(message!)).toHaveLength(0);
      expect(textOf(message!)).toContain("1280x6000 pixels, more than the 2576 a side");
    }
  });

  test("a file the agent opened is named by its path, which is what it would read again", async () => {
    const opened: ImageRefPart = { ...sized("shot.png", 9000, 400), ref: "file:/work/shot.png" };
    const [message] = await resolveImages([userWith(opened)], { fit: { maxSide: 2576 } });
    expect(textOf(message!)).toContain("[image: /work/shot.png: 9000x400 pixels");
  });

  test("a picture whose size nobody can read goes as it is: unknown is not too large", async () => {
    const { asked, shrink } = shrinking();
    const [message] = await resolveImages([userWith(image("plain.png", 64))], { fit: { maxSide: 2576, shrink } });
    expect(asked).toEqual([]);
    expect(imagesOf(message!)).toHaveLength(1);
  });

  test("with no bound given, a picture goes whatever its size", async () => {
    const [message] = await resolveImages([userWith(sized("chat.png", 1280, 6000))]);
    expect(imagesOf(message!)).toHaveLength(1);
  });

  test("the copy's weight is what the request's budget counts, so a heavy original that fits once smaller is sent", async () => {
    // 600 bytes on disk against a budget of 400: by its own weight it would be crowded out; its copy is 8 bytes.
    const { shrink } = shrinking();
    const out = await resolveImages([userWith(sized("heavy.png", 4000, 3000, 600), image("after.png", 240))], { maxBytes: 400, fit: { maxSide: 2576, shrink } });
    expect(imagesOf(out[0]!)).toHaveLength(2);
  });

  test("and a copy that is still too heavy is left out as any picture over the budget is", async () => {
    const heavy = { bytes: Buffer.concat([COPY, Buffer.alloc(600, 7)]), mimeType: "image/jpeg" };
    const [message] = await resolveImages([userWith(sized("heavy.png", 4000, 3000, 600))], { maxBytes: 400, fit: { maxSide: 2576, shrink: shrinking(heavy).shrink } });
    expect(imagesOf(message!)).toHaveLength(0);
    expect(textOf(message!)).toContain("not in this request");
  });

  test("without a converter a file over the budget is not read at all, as before", async () => {
    const [message] = await resolveImages([userWith(sized("heavy.png", 4000, 3000, 600))], { maxBytes: 400, fit: { maxSide: 2576 } });
    expect(textOf(message!)).toContain("not in this request");
    expect(textOf(message!)).not.toContain("pixels");
  });
});

describe("the bytes decide", () => {
  test("a JPEG labelled PNG is sent as a JPEG", async () => {
    const path = join(dir, "photo.png");
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    const [message] = await resolveImages([userWith({ type: "image_ref", ref: "ref-photo", localPath: path, mimeType: "image/png", filename: "photo.png" })]);
    expect(partsOf(message!).find((part) => part.type === "image")).toMatchObject({ mimeType: "image/jpeg" });
  });

  test("bytes that are no picture a provider takes become a line, not an image block", async () => {
    const path = join(dir, "sticker.webp");
    // An animated Telegram sticker: gzip, labelled WebP.
    writeFileSync(path, Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]));
    const [message] = await resolveImages([userWith({ type: "image_ref", ref: "ref-sticker", localPath: path, mimeType: "image/webp", filename: "sticker.webp" })]);
    const parts = partsOf(message!);
    expect(parts.some((part) => part.type === "image")).toBe(false);
    expect(parts).toContainEqual({
      type: "text",
      text: "[image: sticker.webp: this file (labelled image/webp) is not a format the model can be sent; ask for a PNG or JPEG, or convert it with your tools]",
    });
  });
});

describe("failures", () => {
  test("a file that is gone becomes text, not a thrown turn", async () => {
    /**
     * An attachment directory is swept, a disk fills, somebody deletes a folder. An answer about
     * the other two pictures beats a turn that died on the third.
     */
    const missing: ImageRefPart = {
      type: "image_ref",
      ref: "ref-gone",
      localPath: join(dir, "not-here.png"),
      mimeType: "image/png",
      filename: "not-here.png",
    };
    const out = await resolveImages([userWith(missing)]);
    expect(partsOf(out[0]!)[1]?.type).toBe("text");
  });

  test("text parts alongside an image are kept in place", async () => {
    // Order is what makes the request read correctly: the question, then the thing it is about.
    const out = await resolveImages([userWith(image("a.png"))]);
    const parts = partsOf(out[0]!);
    expect(parts[0]).toEqual({ type: "text", text: "look at this" });
    // Then the line that says which picture this is, then the picture.
    expect(parts.map((part) => part.type)).toEqual(["text", "text", "image"]);
  });
});


describe("the whole path, ref to wire", () => {
  /**
   * Through the provider's public API rather than its serializer.
   *
   * The serializer is internal and importing it past the barrel would couple this test to the
   * package's file layout (invariant 11). Capturing the request body tests the same thing and tests
   * it the way the daemon actually reaches it.
   */
  async function wireBody(messages: ChatMessage[]): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    const provider = createProvider({
      kind: "anthropic",
      baseUrl: "https://example.invalid",
      apiKey: "k",
      http: {
        fetchImpl: (async (_url: string, init?: { body?: string }) => {
          captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
          return new Response(
            JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      },
    });
    await provider.chat({ model: "m", system: [], messages });
    return captured;
  }

  test("a stored pointer becomes an image block a provider understands", async () => {
    /**
     * The seam the incident of 2026-09-11 was on the wrong side of. Everything before this test
     * could pass while the model still received prose: the transcript holds a pointer, the turn
     * resolves it, the client serializes it — and only all three together mean the picture arrives.
     */
    const stored: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: "where do these overlap?" }, image("shot.png", 9)],
      timestamp: 0,
    };

    const body = await wireBody(await resolveImages([stored]));
    const content = (body.messages as { content: unknown }[])[0]!.content;

    /**
     * Field by field rather than a whole-object match: the last block also carries the prompt-cache
     * breakpoint, which is a separate concern with its own tests, and pinning it here would make
     * this fail on a caching change that has nothing to do with images.
     */
    const blocks = content as { type: string; text?: string; source?: Record<string, string> }[];
    expect(blocks.map((block) => block.type)).toEqual(["text", "text", "image"]);
    expect(blocks[0]?.text).toBe("where do these overlap?");
    expect(blocks[1]?.text).toBe("[New picture, sent at 00:00 with the message you are answering:]");
    expect(blocks[2]?.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: pngBytes(9).toString("base64"),
    });
  });

  test("and an unresolved one never reaches a provider", async () => {
    /**
     * Belt and braces across the boundary: the engine resolves and the client refuses. Either alone
     * would let a filesystem path be described by a model as though it were a picture — an answer,
     * not an error, and nothing in it shows the picture was never seen.
     */
    await expect(wireBody([{ role: "user", content: [image("shot.png")] }])).rejects.toThrow(
      /unresolved image_ref/,
    );
  });
});

/**
 * One file, sent once.
 *
 * A picture can be in the transcript twice now: it arrived with a message, and then the agent opened
 * it again with `attachment_read`, which hands the picture back rather than a description of it.
 * Sending the same megabyte twice spends the budget on a duplicate and pushes a *different* picture
 * out of the request — so the second copy is the one that pays.
 */
describe("the same file twice in one request", () => {
  test("is resolved once and named once", async () => {
    const shot = image("shot.png");
    const out = await resolveImages([
      userWith(shot),
      { role: "assistant", content: "let me look again", timestamp: 1 },
      // What the executor pushes after `attachment_read` opens it: the same ref, same file.
      userWith({ ...shot }),
    ]);

    const kinds = out.flatMap((message) => partsOf(message).map((part) => part.type));
    expect(kinds.filter((kind) => kind === "image")).toHaveLength(1);

    // The newest copy wins — it is the one the model just asked for — and the older one collapses to
    // the line that says where it went.
    const newest = partsOf(out.at(-1)!);
    expect(newest.some((part) => part.type === "image")).toBe(true);
    const oldest = partsOf(out[0]!);
    expect(oldest.some((part) => part.type === "image")).toBe(false);
    expect(oldest.map((part) => (part.type === "text" ? part.text : "")).join(" ")).toContain("ref-shot.png");
  });

  test("two different files are both sent", async () => {
    // The guard is on the ref, not on "have we sent anything" — an over-eager version of this would
    // send the newest picture and collapse every other one.
    const out = await resolveImages([userWith(image("a.png"), image("b.png"))]);

    const kinds = partsOf(out[0]!).map((part) => part.type);
    expect(kinds.filter((kind) => kind === "image")).toHaveLength(2);
  });
});

/**
 * Which picture is the new one.
 *
 * A request carries up to four pictures from the conversation, and without a word in front of each they look alike —
 * the one sent with the message being answered told apart only by where it sits. On 2026-10-24 a quiz was sent one
 * photo at a time, and the agent could not tell the photo it was asked about from the ones before.
 */
describe("the line in front of each picture", () => {
  const at = (clock: string) => Date.parse(`2026-10-24T${clock}:00Z`);
  const said = (timestamp: number, ...parts: ContentPart[]): ChatMessage => ({ role: "user", content: [{ type: "text", text: "?" }, ...parts], timestamp });
  const lines = (messages: ChatMessage[]) =>
    messages.flatMap((message) => partsOf(message).filter((part) => part.type === "text" && part.text.startsWith("[")).map((part) => (part as { text: string }).text));

  test("says when each was sent, in the daemon's zone, and which came with the message being answered", async () => {
    const out = await resolveImages(
      [said(at("06:08"), image("q2.png")), { role: "assistant", content: "A", timestamp: at("06:09") }, said(at("06:13"), image("q3.png"))],
      { timeZone: "Asia/Jakarta" },
    );
    expect(lines(out)).toEqual([
      "[Earlier picture, sent at 13:08, not part of the message you are answering:]",
      "[New picture, sent at 13:13 with the message you are answering:]",
    ]);
  });

  test("a message with no picture of its own makes every picture an earlier one", async () => {
    const out = await resolveImages([said(at("06:08"), image("q2.png")), said(at("06:09"))], { timeZone: "UTC" });
    expect(lines(out)).toEqual(["[Earlier picture, sent at 06:08, not part of the message you are answering:]"]);
  });

  test("a picture a reply carries into the message is an earlier one, with the time it was posted", async () => {
    const carried: ImageRefPart = { ...image("posted.png"), sentAt: at("05:30") };
    const out = await resolveImages([said(at("06:13"), image("own.png", 16), carried)], { timeZone: "UTC" });
    expect(lines(out)).toEqual([
      "[New picture, sent at 06:13 with the message you are answering:]",
      "[Earlier picture, sent at 05:30, not part of the message you are answering:]",
    ]);
  });

  test("one from another day names the day, and a wrap-up instruction after the message is not what is answered", async () => {
    const yesterday = Date.parse("2026-10-23T22:00:00Z");
    const out = await resolveImages(
      [said(yesterday, image("old.png")), said(at("06:13"), image("new.png")), { role: "user", content: "Wrap up now." }],
      { timeZone: "UTC" },
    );
    expect(lines(out)).toEqual([
      "[Earlier picture, sent on 2026-10-23 at 22:00, not part of the message you are answering:]",
      "[New picture, sent at 06:13 with the message you are answering:]",
    ]);
  });
});
