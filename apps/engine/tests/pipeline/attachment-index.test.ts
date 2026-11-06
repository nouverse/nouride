/**
 * The conversation's list of files: who can find one, and who cannot.
 *
 * Two properties carry the whole feature and neither is visible from reading the code.
 *
 * The first is that the same file arriving on six connections is *one* file. A platform hands every
 * bot in a channel its own copy of every message, so in the room this was built for, registration
 * runs six times within milliseconds — and a random id would have offered the model six refs for one
 * photo.
 *
 * The second is that the chat is a boundary. A ref is a short string that turns up in a transcript,
 * and an agent holding one from another room must find nothing at all — not a refusal it could
 * reason about, nothing. That is checked here rather than at the tool, because the tool is where a
 * future convenience would put the shortcut.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { ChatAttachmentIndex, messageAttachmentRefs } from "@/modules/attachments/chat-attachments.store.ts";
import { readImage } from "@/modules/attachments/vision.ts";
import { tempDir } from "../helpers.ts";

let cleanup: (() => void)[] = [];

beforeEach(() => {
  cleanup = [];
});

afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
});

async function openIndex() {
  const dataDir = tempDir("attachment-index");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  return new ChatAttachmentIndex(db);
}

/** The room most of these are about: a Discord channel, as the connection a turn runs on sees it. */
const ROOM = { gateway: "discord", gatewayId: "discord:nouva", chatId: "room-1", chatType: "channel" } as const;

const photo = (over: Record<string, unknown> = {}) => ({
  gateway: "discord",
  chatId: "room-1",
  gatewayId: "discord:nouva",
  name: "dog.jpg",
  mimeType: "image/jpeg",
  kind: "image",
  size: 240_000,
  at: 1_000,
  ...over,
});

describe("registering the same file twice", () => {
  test("six connections seeing one message produce one row", async () => {
    const index = await openIndex();

    // What actually happens in a Discord channel with six of our bots on it: one message, six
    // deliveries, all with the same platform message id.
    for (const gatewayId of ["discord:nouva", "discord:nero", "discord:nox", "discord:nix"]) {
      index.register(photo({ key: "msg-7#0", gatewayId }));
    }

    const files = index.recent(ROOM, 10);
    expect(files).toHaveLength(1);
    // The first arrival's connection is the one kept, because that is the one whose handle resolves —
    // a Telegram file_id is scoped to the bot it was issued to.
    expect(files[0]?.gatewayId).toBe("discord:nouva");
  });

  test("the ref is a pure function of the message, its room and the position", () => {
    // Which is what makes the row collapse above possible, and what lets the intake find the row a
    // different module wrote without passing anything between them: every connection in a room
    // computes the same refs for one message.
    const [first, second] = messageAttachmentRefs(ROOM, "msg-7", 2);
    expect(messageAttachmentRefs({ ...ROOM, gatewayId: "discord:nero" }, "msg-7", 2)).toEqual([first!, second!]);
    expect(first).not.toBe(second);
  });

  test("the same message id in another chat is another file", () => {
    // Telegram numbers a supergroup's messages per chat, so message 57 is in every group there is. A bare id was one
    // ref for all of them, and the second registration was dropped.
    const group = { gateway: "telegram", gatewayId: "telegram:nouva", chatType: "group" } as const;
    expect(messageAttachmentRefs({ ...group, chatId: "-1001" }, "57", 1)).not.toEqual(
      messageAttachmentRefs({ ...group, chatId: "-1002" }, "57", 1),
    );
  });

  test("two files on one message are two rows", async () => {
    const index = await openIndex();

    index.register(photo({ key: "msg-8#0", name: "one.png" }));
    index.register(photo({ key: "msg-8#1", name: "two.png" }));

    expect(index.recent(ROOM, 10)).toHaveLength(2);
  });
});

describe("the chat is the permission", () => {
  test("a ref from another room finds nothing", async () => {
    const index = await openIndex();
    const ref = index.register(photo({ key: "msg-9#0", chatId: "room-1" }));

    expect(ref).not.toBeNull();
    expect(index.find(ref!, ROOM)).not.toBeNull();
    // The interesting half. Somebody quoting a ref into another channel gets nothing back.
    expect(index.find(ref!, { ...ROOM, chatId: "room-2" })).toBeNull();
  });

  test("the same chat id on another platform is another room", async () => {
    const index = await openIndex();
    const ref = index.register(photo({ key: "msg-10#0", gateway: "discord", chatId: "general" }));

    // A chat id is only unique within a platform, and `web:dashboard` has no namespace at all.
    expect(index.find(ref!, { ...ROOM, gateway: "telegram", chatId: "general" })).toBeNull();
  });

  test("the lookup is scoped whether or not the caller remembers to check", async () => {
    // Stated as a test because the alternative implementation — find by ref, then compare the chat —
    // passes every case above and fails the day a caller forgets the second half.
    const index = await openIndex();
    index.register(photo({ key: "msg-11#0", chatId: "room-a", name: "a.png" }));
    index.register(photo({ key: "msg-12#0", chatId: "room-b", name: "b.png" }));

    const inA = index.recent({ ...ROOM, chatId: "room-a" }, 10);
    expect(inA.map((file) => file.name)).toEqual(["a.png"]);
  });
});

/**
 * #12: two of our bots, each its own connection, in a DM with the same person.
 *
 * On Telegram a DM's chat id is the person's own id, so `telegram:agent-a` and `telegram:agent-b` see one chat id for two
 * conversations — and each bot numbers its DMs itself, so the person's fifth message to each is message 5 to both.
 * Matched on the platform and the chat, agent B listed, was handed and opened what the person had sent agent A.
 */
describe("a one-to-one chat is its connection's, not the platform's", () => {
  const dmOn = (gatewayId: string) => ({ gateway: "telegram", gatewayId, chatId: "5550001111", chatType: "dm" }) as const;
  const A = dmOn("telegram:agent-a");
  const B = dmOn("telegram:agent-b");

  test("a file sent to one bot is not listed, found or offered to another in its DM with the same person", async () => {
    const index = await openIndex();
    const [ref] = messageAttachmentRefs(A, "5", 1);
    index.register(photo({ ...A, ref, name: "for-agent-a.png", at: 100 }));

    // Agent A has it, every way.
    expect(index.recent(A, 10).map((file) => file.name)).toEqual(["for-agent-a.png"]);
    expect(index.find(ref!, A)?.name).toBe("for-agent-a.png");
    // Agent B has none of it: not in its listing, not by the ref, not in the window a prompt carries in, not by the
    // ref its own message 5 computes.
    expect(index.recent(B, 10)).toEqual([]);
    expect(index.find(ref!, B)).toBeNull();
    expect(index.since({ ...B, after: 0, before: 1_000, limit: 10 })).toEqual([]);
    expect(index.find(messageAttachmentRefs(B, "5", 1)[0]!, B)).toBeNull();
  });

  test("each bot's message 5 is its own file, and one bot's copy never repoints the other's", async () => {
    const index = await openIndex();
    const [forA] = messageAttachmentRefs(A, "5", 1);
    const [forB] = messageAttachmentRefs(B, "5", 1);
    expect(forA).not.toBe(forB);

    index.register(photo({ ...A, ref: forA, name: "for-agent-a.png" }));
    index.register(photo({ ...B, ref: forB, name: "for-agent-b.png" }));
    // What agent B's intake does once it has the bytes of its own message 5.
    index.markStored(forB!, "/data/attachments/agent-b/for-agent-b.png");

    expect(index.find(forA!, A)).toMatchObject({ name: "for-agent-a.png", gatewayId: "telegram:agent-a" });
    expect(index.find(forA!, A)?.localPath).toBeUndefined();
    expect(index.find(forB!, B)).toMatchObject({ name: "for-agent-b.png", localPath: "/data/attachments/agent-b/for-agent-b.png" });
  });

  test("deleting one bot's DM leaves the other's", async () => {
    const index = await openIndex();
    index.register(photo({ ...A, ref: messageAttachmentRefs(A, "5", 1)[0] }));
    index.register(photo({ ...B, ref: messageAttachmentRefs(B, "5", 1)[0] }));

    expect(index.deleteForChat(A)).toBe(1);
    expect(index.recent(B, 10)).toHaveLength(1);
  });

  test("a group with the same bots in it is still one conversation", async () => {
    // The other half, so the fix cannot become "key everything on the connection": in a room, the file one of our
    // bots saw is the room's, and the bot a turn runs on is not the one that registered it.
    const index = await openIndex();
    const group = { gateway: "telegram", gatewayId: "telegram:agent-a", chatId: "-100200", chatType: "group" } as const;
    const [ref] = messageAttachmentRefs(group, "77", 1);
    index.register(photo({ ...group, ref }));

    const fromB = { ...group, gatewayId: "telegram:agent-b" };
    expect(index.find(ref!, fromB)).not.toBeNull();
    expect(index.recent(fromB, 10)).toHaveLength(1);
  });
});

describe("the window a prompt is given", () => {
  test("only what arrived since this agent was last spoken to, and before this message", async () => {
    const index = await openIndex();
    for (const at of [5, 15, 25, 35]) {
      index.register(photo({ key: `m${at}#0`, name: `at-${at}.png`, at }));
    }

    const window = index.since({
      ...ROOM,
      after: 10,
      before: 30,
      limit: 10,
    });

    expect(window.map((file) => file.name)).toEqual(["at-15.png", "at-25.png"]);
  });

  test("the triggering message's own files are excluded", async () => {
    /**
     * A file that came *with* this message is already in the attachment notice, described rather
     * than listed. Announcing it in both blocks under two labels is how a model reports one photo
     * as two.
     */
    const index = await openIndex();
    index.register(photo({ key: "earlier#0", name: "earlier.png", at: 100 }));
    const mine = index.register(photo({ key: "now#0", name: "with-this-message.png", at: 200 }));

    const window = index.since({
      ...ROOM,
      after: 0,
      before: 200,
      exclude: [mine!],
      limit: 10,
    });

    expect(window.map((file) => file.name)).toEqual(["earlier.png"]);
  });

  test("a file that arrived in the same millisecond as the message is still shown", async () => {
    /**
     * The regression this replaced a strict `<` to fix, caught by the room's own end-to-end test.
     *
     * The dashboard registers a file and dispatches the message in one call, so the two share a
     * millisecond; a platform that stamps whole seconds makes the window a whole second wide. Under
     * an exclusive upper bound that file was dropped from *every* window afterwards, not just this
     * one — announced to nobody, ever. Excluding by ref says exactly what was meant.
     */
    const index = await openIndex();
    index.register(photo({ key: "somebody-elses#0", name: "theirs.png", at: 500 }));
    const mine = index.register(photo({ key: "mine#0", name: "mine.png", at: 500 }));

    const window = index.since({
      ...ROOM,
      after: 0,
      before: 500,
      exclude: [mine!],
      limit: 10,
    });

    expect(window.map((file) => file.name)).toEqual(["theirs.png"]);
  });

  test("oldest first, capped at the newest when there are too many", async () => {
    const index = await openIndex();
    for (let i = 0; i < 8; i += 1) index.register(photo({ key: `k${i}#0`, name: `f${i}.png`, at: 100 + i }));

    const window = index.since({
      ...ROOM,
      after: 0,
      before: 1_000,
      limit: 3,
    });

    // The newest survive — the current message is most likely about the most recent file — and the
    // list still reads forwards.
    expect(window.map((file) => file.name)).toEqual(["f5.png", "f6.png", "f7.png"]);
  });
});

describe("a durable copy", () => {
  test("is recorded when one is made, and found by the next reader", async () => {
    const index = await openIndex();
    const ref = index.register(photo({ key: "msg-13#0" }));

    expect(index.find(ref!, ROOM)?.localPath).toBeUndefined();

    index.markStored(ref!, "/srv/data/attachments/nero/abc/2026-09-07/01-dog.jpg");

    expect(index.find(ref!, ROOM)?.localPath).toBe(
      "/srv/data/attachments/nero/abc/2026-09-07/01-dog.jpg",
    );
  });

  test("raw bytes are never written into the row", async () => {
    /**
     * `Attachment.buffer` is a `Uint8Array`, and `JSON.stringify` turns one into an object with a
     * numbered key per byte. A 2MB voice note would become several megabytes of JSON in a row whose
     * entire job is to hold metadata — and WhatsApp hands attachments over exactly that way.
     */
    const index = await openIndex();
    const ref = index.register(
      photo({
        key: "msg-15#0",
        size: undefined,
        handle: {
          type: "audio",
          mimeType: "audio/ogg",
          buffer: new Uint8Array(4096).fill(7),
        },
      }),
    );

    const found = index.find(ref!, ROOM);
    expect(found?.handle?.buffer).toBeUndefined();
    // The size is kept, though: the listing is more useful with one than without.
    expect(found?.size).toBe(4096);
  });

  test("the platform handle survives a round trip, so bytes can be fetched later", async () => {
    const index = await openIndex();
    const ref = index.register(
      photo({ key: "msg-14#0", handle: { type: "image", mimeType: "image/jpeg", url: "https://cdn/x.jpg" } }),
    );

    const found = index.find(ref!, ROOM);
    expect(found?.handle?.url).toBe("https://cdn/x.jpg");
  });
});

describe("retention", () => {
  test("swept on the conversation window, and zero disables it", async () => {
    const index = await openIndex();
    const now = Date.now();
    index.register(photo({ key: "old#0", at: now - 40 * 86_400_000 }));
    index.register(photo({ key: "new#0", at: now }));

    expect(index.sweep(0)).toBe(0);
    expect(index.sweep(30)).toBe(1);
    expect(index.recent(ROOM, 10)).toHaveLength(1);
  });

  test("a deleted conversation leaves no file list behind", async () => {
    // Called by `DELETE /rooms/:chatId`, beside the room's events and messages. Without it a deleted
    // room leaves refs that still resolve to files on disk.
    const index = await openIndex();
    index.register(photo({ key: "a#0", chatId: "room-a" }));
    index.register(photo({ key: "b#0", chatId: "room-b" }));

    expect(index.deleteForChat({ ...ROOM, chatId: "room-a" })).toBe(1);
    expect(index.recent({ ...ROOM, chatId: "room-a" }, 10)).toHaveLength(0);
    expect(index.recent({ ...ROOM, chatId: "room-b" }, 10)).toHaveLength(1);
  });
});

describe("what the vision helper does before spending a call", () => {
  /**
   * The bug the byte sniff exists for, asserted against the helper both readers share.
   *
   * A Cloudflare interstitial saved as `shiba-inu.jpg` reached the provider as `image/jpeg` and came
   * back `400 Unable to process input image`. The agent then told the operator its vision model
   * could not see the picture — the one explanation that was not true, and the one that sent
   * everybody looking at the model instead of the file.
   */
  const visionDeps = (readImages = true, maxImageBytes = 10_000_000) =>
    ({
      config: { media: { readImages, imageModel: "", maxImageBytes } },
      registry: { get: () => ({ config: { llm: { model: "m", provider: "p" } } }) },
      providers: { endpointFor: () => ({ kind: "openai", baseUrl: "x", apiKey: "k" }) },
    }) as never;
  const deps = visionDeps();

  test("an HTML page claiming to be a JPEG is named as a page, and costs nothing", async () => {
    const page = new TextEncoder().encode('<!DOCTYPE html><title>Just a moment...</title>');

    const result = await readImage(deps, {
      agentId: "nouva",
      bytes: page,
      mimeType: "image/jpeg",
    });

    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("not an image");
    expect(error).toContain("HTML page");
    // The sentence has to point at the fix, which is a different source — not at the model.
    expect(error).toContain("rather than blaming the vision model");
  });

  test("an image whose extension lies is not refused for it", async () => {
    /**
     * The other direction. A PNG called `.jpg` is a working image, and `isSupportedImageType` reads
     * the *claim* — so before the sniff a correct claim was required for a correct file. Here the
     * refusal must not be about the type at all; the endpoint is a stub, so the call fails on the
     * request instead, which is what proves it got that far.
     */
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

    const result = await readImage(deps, {
      agentId: "nouva",
      bytes: png,
      mimeType: "application/octet-stream",
    });

    expect((result as { error?: string }).error ?? "").not.toContain("not a readable image type");
  });

  test("reading switched off is still reported as the operator's choice", async () => {
    // Ahead of everything else, because "your operator turned this off" is a different fact from
    // "this file is broken" and the agent should not conflate them.
    const result = await readImage(visionDeps(false), {
      agentId: "nouva",
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      mimeType: "image/jpeg",
    });

    expect((result as { error: string }).error).toContain("switched off");
  });

  test("an image over the size cap is refused before a call is spent on it", async () => {
    // Nothing tested this: with the cap deleted every other test here still passed, and the file went
    // to the provider whatever its size.
    const jpeg = new Uint8Array(2_048).fill(0);
    jpeg.set([0xff, 0xd8, 0xff]);

    const result = await readImage(visionDeps(true, 1_024), { agentId: "nouva", bytes: jpeg, mimeType: "image/jpeg" });

    expect((result as { error: string }).error).toContain("too large to send to a vision model");
  });
});
