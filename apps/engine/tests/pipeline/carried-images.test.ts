/**
 * Pictures a turn carries in from outside the message it is answering.
 *
 * Two shapes, both of which lost them. Replying: a reply carries `quotedText` and nothing else — both
 * gateways fetch the quoted message and take its `content` — so the image somebody was pointing at
 * never reached the agent. And posting: a screenshot dropped in the room, then a tag in the next
 * message, so the picture sat outside every message the agent was ever handed.
 *
 * In both cases the only thing the agent could do was ask for a written description, and for a
 * question about layout or colour prose is not an answer.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentCommandsThrough } from "@nouride/runtime";
import type { ChatMessage, MessageEnvelope } from "@nouride/shared";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { AttachmentIntake } from "@/modules/pipeline/attachments.ts";
import {
  messageAttachmentRefs,
  type ChatAttachment,
  type FileWindow,
} from "@/modules/attachments/chat-attachments.store.ts";
import { RoomMemory } from "@/modules/pipeline/room-memory.ts";
import { mergeEnvelopes } from "@/modules/pipeline/messages.ts";
import type { CarriedFile } from "@/modules/pipeline/attachments.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";

const QUOTED = "msg-with-pictures";

const envelope = (over: Partial<MessageEnvelope> = {}): MessageEnvelope =>
  ({
    id: "msg-now",
    gateway: "discord",
    gatewayId: "discord:nexa",
    chatId: "room-1",
    chatType: "channel",
    senderId: "u1",
    text: "ini",
    replyTo: QUOTED,
    timestamp: 1_800_000_000_000,
    ...over,
  }) as MessageEnvelope;

const indexed = (position: number, over: Partial<ChatAttachment> = {}): ChatAttachment =>
  ({
    ref: messageAttachmentRefs(envelope(), QUOTED, position + 1)[position]!,
    gateway: "discord",
    chatId: "room-1",
    gatewayId: "discord:nexa",
    name: `shot-${position}.png`,
    mimeType: "image/png",
    kind: "image",
    localPath: `/data/shot-${position}.png`,
    at: 1_799_999_000_000,
    ...over,
  }) as ChatAttachment;

/** The intake with only the pieces this path touches. */
function intake(options: {
  files?: ChatAttachment[];
  imageModel?: string;
  readImages?: boolean;
  fetched?: string[];
}) {
  const files = options.files ?? [];
  const deps = {
    config: {
      media: {
        imageModel: options.imageModel ?? "",
        readImages: options.readImages ?? true,
        maxImageBytes: 8_388_608,
      },
    },
    attachmentIndex: {
      find: (ref: string) => files.find((file) => file.ref === ref) ?? null,
      markStored: () => {},
    },
    attachments: {
      store: async () => {
        options.fetched?.push("fetched");
        return { localPath: "/data/refetched.png", mimeType: "image/png", type: "image" };
      },
    },
    gateways: { get: () => ({ fetchAttachment: async () => new Uint8Array([1]) }) },
  } as unknown as PipelineDeps;

  return { intake: new AttachmentIntake(deps) };
}

/**
 * A path that certainly exists.
 *
 * The disk is not mocked here on purpose: the path in the index is a hint and is *verified*, because
 * the index and the bytes have different retention windows and a row can outlive the file it points
 * at. A fake that always said yes would agree with the bug.
 */
const REAL = import.meta.path;

/** What a reply carries, as the turn assembles it: look the quoted files up, then build the parts. */
const quoted = (subject: AttachmentIntake, env: MessageEnvelope) =>
  subject.pictures("nexa", env, subject.quotedFiles(env));

describe("a reply to a message that carried pictures", () => {
  test("brings them in as pictures", async () => {
    const { intake: subject } = intake({
      files: [indexed(0, { localPath: REAL }), indexed(1, { localPath: REAL })],
    });

    const parts = await quoted(subject, envelope());

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: "image_ref",
      mimeType: "image/png",
      filename: "shot-0.png",
      localPath: REAL,
    });
  });

  test("an ordinary message brings in nothing", async () => {
    // The common turn, and it must pay nothing: no index lookups, no disk, no fetch.
    const { intake: subject } = intake({ files: [indexed(0, { localPath: REAL })] });

    expect(await quoted(subject, envelope({ replyTo: undefined }))).toEqual([]);
  });

  test("a quoted message with no files brings in nothing", async () => {
    const { intake: subject } = intake({ files: [] });

    expect(await quoted(subject, envelope())).toEqual([]);
  });

  test("files that are not images are left alone", async () => {
    // A log or a PDF is not something to put in front of a model as pixels — the agent opens those
    // with its own file tools, and always could.
    const { intake: subject } = intake({
      files: [indexed(0, { kind: "document", mimeType: "application/pdf", localPath: REAL })],
    });

    expect(await quoted(subject, envelope())).toEqual([]);
  });
});

describe("when the bytes are not on disk any more", () => {
  test("it fetches once rather than handing back a path to nothing", async () => {
    // An `image_ref` is a path, and a ref with nowhere to read bytes from reaches the wire serializer
    // as a filesystem path — which is where a confident answer about a path comes from.
    const fetched: string[] = [];
    const { intake: subject } = intake({
      files: [indexed(0, { localPath: "/gone/shot-0.png", handle: { type: "image" } as never })],
      fetched,
    });

    const parts = await quoted(subject, envelope());

    expect(fetched).toHaveLength(1);
    expect(parts[0]?.localPath).toBe("/data/refetched.png");
  });

  test("a file with no copy and no handle is skipped, not faked", async () => {
    const { intake: subject } = intake({
      files: [indexed(0, { localPath: "/gone/shot-0.png" })],
    });

    expect(await quoted(subject, envelope())).toEqual([]);
  });
});

describe("the posture the operator chose is respected", () => {
  test("a separate vision model means the description path, as it always did", async () => {
    // `[media] image_model` is usually set because the conversation model cannot take pixels at all.
    // Handing it one there is a failed request, not a better answer.
    const { intake: subject } = intake({
      files: [indexed(0, { localPath: REAL })],
      imageModel: "antigravity:gemini-3.1-flash-lite",
    });

    expect(await quoted(subject, envelope())).toEqual([]);
  });

  test("read_images off means nothing is looked at", async () => {
    const { intake: subject } = intake({
      files: [indexed(0, { localPath: REAL })],
      readImages: false,
    });

    expect(await quoted(subject, envelope())).toEqual([]);
  });
});

/**
 * Pictures posted while nobody was talking to this agent.
 *
 * The shape that lost them: somebody posts a screenshot, then tags an agent in the *next* message.
 * The chatter from that gap was already replayed into the prompt — `overheardBefore` has done it for
 * a long time — and the files in it were left behind, so the agent read "look at this" and had
 * nothing to look at.
 *
 * `ChatAttachmentIndex.since` was written for exactly this window and had no caller anywhere. What
 * was missing was never the query.
 */
describe("pictures posted while nobody was talking to this agent", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "earlier", timestamp: 1_799_000_000_000 },
    { role: "assistant", content: "answered", timestamp: 1_799_000_001_000 },
  ];

  function rooms(files: CarriedFile[], seen: FileWindow[] = []) {
    const deps = {
      config: { gateways: [], agents: { groupContextMessages: 5 } },
      attachmentIndex: {
        since: (window: FileWindow) => {
          seen.push(window);
          return files;
        },
      },
      chatEvents: undefined,
    } as unknown as PipelineDeps;
    return new RoomMemory(deps, { outbound: { authorOf: () => null } } as never);
  }

  test("the window is the same one the chatter is replayed from", () => {
    const seen: FileWindow[] = [];
    rooms([], seen).filesBefore(envelope({ attachments: [{}, {}] as never }), history);

    expect(seen).toHaveLength(1);
    // Everything since this agent was last spoken to, up to the message being answered.
    expect(seen[0]).toMatchObject({
      gateway: "discord",
      gatewayId: "discord:nexa",
      chatId: "room-1",
      chatType: "channel",
      after: 1_799_000_000_000,
      before: 1_800_000_000_000,
    });
    // This message's own files are kept out by ref: they are described by the intake notice in the
    // same prompt, and announcing them twice is how one photo gets reported as two.
    expect(seen[0]!.exclude).toEqual(messageAttachmentRefs(envelope(), "msg-now", 2));
  });

  test("a burst folded into one message keeps out each file under the message it came with", () => {
    // Two photos sent a second apart are one turn (the batcher); the folded message's id is the second's. Kept out by
    // that id alone, the first photo was carried back in as a picture from earlier — the same picture twice.
    const seen: FileWindow[] = [];
    const first = envelope({ id: "msg-1", attachments: [{ type: "image", mimeType: "image/jpeg" }] as never });
    const second = envelope({ id: "msg-2", attachments: [{ type: "image", mimeType: "image/jpeg" }] as never });
    rooms([], seen).filesBefore(mergeEnvelopes(first, second), history);
    expect(seen[0]!.exclude).toEqual([...messageAttachmentRefs(first, "msg-1", 1), ...messageAttachmentRefs(second, "msg-2", 1)]);
  });

  test("what comes back becomes pictures, images only", async () => {
    const files = [
      indexed(0, { ref: "f-img", localPath: REAL }),
      indexed(1, { ref: "f-doc", kind: "document", mimeType: "application/pdf", localPath: REAL }),
    ];
    const { intake: subject } = intake({});

    const parts = await subject.pictures("nexa", envelope(), rooms(files).filesBefore(envelope(), history));

    expect(parts.map((part) => part.ref)).toEqual(["f-img"]);
  });

  test("after /new the window starts at the reset, never at the chat's first picture", () => {
    // Live: a DM reset at 00:32 opened with four screenshots from three days earlier in context, and
    // the agent answered from them as if they had just been sent.
    const seen: FileWindow[] = [];
    const now = 1_800_000_000_000;
    rooms([], seen).filesBefore(envelope(), [], now - 60_000);
    expect(seen[0]!.after).toBe(now - 60_000);

    // No history and no known start: a bounded lookback, not 0.
    rooms([], seen).filesBefore(envelope(), []);
    expect(seen[1]!.after).toBeGreaterThan(now - 16 * 60_000);
  });

  test("a daemon with no index asks for nothing", () => {
    const deps = { config: { gateways: [] }, attachmentIndex: undefined } as unknown as PipelineDeps;
    const memory = new RoomMemory(deps, { outbound: { authorOf: () => null } } as never);

    expect(memory.filesBefore(envelope(), history)).toEqual([]);
  });
});

describe("where each agent's commands run as its own user", () => {
  test("a picture another agent in the room stored is copied into this agent's own folder, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "nouride-room-"));
    const theirs = join(root, "nox", "abc", "2026-10-24", "shot.png");
    mkdirSync(join(theirs, ".."), { recursive: true });
    writeFileSync(theirs, "png bytes");
    const store = new AttachmentStore({ rootDir: root, maxBytes: 1_000_000, now: () => new Date("2026-10-24T10:00:00Z") });
    const deps = {
      config: { media: { imageModel: "", readImages: true, maxImageBytes: 8_388_608 } },
      attachmentIndex: { find: (ref: string) => (ref === indexed(0).ref ? indexed(0, { localPath: theirs }) : null), markStored: () => {} },
      attachments: store,
      gateways: { get: () => undefined },
    } as unknown as PipelineDeps;
    runAgentCommandsThrough({ prefix: () => [], put: () => [] });
    try {
      const subject = new AttachmentIntake(deps);
      const first = await quoted(subject, envelope());
      const path = (first[0] as { localPath: string }).localPath;
      expect(store.holds("nexa", path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("png bytes");
      const again = await quoted(subject, envelope());
      expect((again[0] as { localPath: string }).localPath).toBe(path);
    } finally {
      runAgentCommandsThrough(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
