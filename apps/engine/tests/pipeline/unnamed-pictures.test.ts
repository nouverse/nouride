/**
 * Pictures a platform sends with no name, one message after another, through the intake a turn uses.
 *
 * WhatsApp and Telegram name no photo, and the store named a file by its place in the message alone: every picture in
 * a chat that day was `01-image.jpg`, each written over the last. A turn hands the model the picture's path, and the
 * conversation carries it — so every earlier picture showed the newest. On 2026-10-24 a quiz sent one photo at a time
 * looked to the agent like the same question every time, and it took back answers that had been right.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { removePath } from "@nouride/runtime";
import type { Attachment, MessageEnvelope } from "@nouride/shared";
import { messageAttachmentRefs } from "@/modules/attachments/chat-attachments.store.ts";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { AttachmentIntake } from "@/modules/pipeline/attachments.ts";
import { mergeEnvelopes } from "@/modules/pipeline/messages.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import { tempDir } from "../helpers.ts";

const root = tempDir("unnamed-pictures");
afterEach(() => removePath(root));

/** What the phone sent for each photo — the bytes the platform hands back for it. */
const SENT: Record<string, Uint8Array> = { "photo-1": new Uint8Array([1, 1, 1]), "photo-2": new Uint8Array([2, 2, 2]) };

/** Which file each indexed ref was pointed at — what a reply to that message, or `attachment_read`, opens later. */
const marked = new Map<string, string>();

const intake = new AttachmentIntake({
  config: { media: { imageModel: "", readImages: true, maxImageBytes: 8_388_608 } },
  attachments: new AttachmentStore({ rootDir: root, maxBytes: 1024 * 1024 }),
  attachmentIndex: { markStored: (ref: string, path: string) => marked.set(ref, path) },
  gateways: { get: () => ({ fetchAttachment: async (attachment: Attachment) => SENT[attachment.url!] ?? null }) },
} as unknown as PipelineDeps);

const message = (id: string, url: string): MessageEnvelope =>
  ({
    id,
    gateway: "whatsapp",
    gatewayId: "whatsapp:nouva",
    chatId: "100000000000001@lid",
    chatType: "dm",
    senderId: "100000000000001@lid",
    text: "",
    attachments: [{ type: "image", mimeType: "image/jpeg", url }],
    timestamp: 1_800_000_000_000,
  }) as MessageEnvelope;

test("each photo the model is handed is the one sent with its message — the earlier one is not the later's", async () => {
  const first = await intake.store("nouva", message("msg-1", "photo-1"));
  const second = await intake.store("nouva", message("msg-2", "photo-2"));
  const [one] = first.media;
  const [two] = second.media;
  if (one?.type !== "image_ref" || two?.type !== "image_ref") throw new Error("expected a picture for the model each time");

  expect(two.localPath).not.toBe(one.localPath);
  // Each says when it came, so the line in front of it can say which is new (`llm/images.ts`).
  expect([one.sentAt, two.sentAt]).toEqual([1_800_000_000_000, 1_800_000_000_000]);
  // What a later turn reads back for the first message's picture.
  expect([...readFileSync(one.localPath)]).toEqual([1, 1, 1]);
  expect([...readFileSync(two.localPath)]).toEqual([2, 2, 2]);
});

test("two photos a second apart, folded into one turn, are each indexed under their own message's ref", async () => {
  // What the batcher does with a burst: one message, the second one's id. Indexed by that id alone, the second photo's
  // ref pointed at the first photo's file, and a reply to it — or `attachment_read` — opened the wrong picture.
  const first = message("msg-a", "photo-1");
  const second = message("msg-b", "photo-2");
  const folded = await intake.store("nouva", mergeEnvelopes(first, second));
  expect(folded.media).toHaveLength(2);

  const refFirst = messageAttachmentRefs(first, "msg-a", 1)[0]!;
  const refSecond = messageAttachmentRefs(second, "msg-b", 1)[0]!;
  expect([...readFileSync(marked.get(refFirst)!)]).toEqual([1, 1, 1]);
  expect([...readFileSync(marked.get(refSecond)!)]).toEqual([2, 2, 2]);
  // And the pictures the model is handed carry those same refs, so the turn and the index name a file alike.
  expect(folded.media.map((part) => part.ref)).toEqual([refFirst, refSecond]);
});
