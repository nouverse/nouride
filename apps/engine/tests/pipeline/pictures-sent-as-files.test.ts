/**
 * Pictures that arrive as files, through the intake a turn uses and the step that sends them to the model.
 *
 * A screenshot sent uncompressed from Telegram Desktop came as a document, and a document was a file whatever it held:
 * the agent opened it with its tools, step by step, where from a phone the same picture was simply in front of the
 * model (2026-10-27). The bytes decide now — a file that is a picture is one, as the type its bytes name — and what
 * reaches a provider is only what a provider takes: a HEIC sent as a picture refused the whole request.
 */

import { afterEach, expect, test } from "bun:test";
import { removePath } from "@nouride/runtime";
import type { Attachment, ChatMessage, ContentPart, MessageEnvelope } from "@nouride/shared";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { resolveImages } from "@/modules/llm/images.ts";
import { AttachmentIntake } from "@/modules/pipeline/attachments.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import { tempDir } from "../helpers.ts";

const root = tempDir("pictures-as-files");
afterEach(() => removePath(root));

const bytesOf = (text: string) => [...new TextEncoder().encode(text)];
/** What each file is, by its first bytes — the platform's label is set per test, and may say otherwise. */
const SENT: Record<string, Uint8Array> = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]),
  // ISO-BMFF with a `heic` brand: what an iPhone sends when a photo goes as a file.
  heic: new Uint8Array([0, 0, 0, 0x18, ...bytesOf("ftypheic"), 0, 0, 0, 0]),
  pdf: new TextEncoder().encode("%PDF-1.7\n"),
};

const intake = new AttachmentIntake({
  config: { media: { imageModel: "", readImages: true, maxImageBytes: 8_388_608 } },
  attachments: new AttachmentStore({ rootDir: root, maxBytes: 1024 * 1024 }),
  attachmentIndex: { markStored: () => {} },
  gateways: { get: () => ({ fetchAttachment: async (attachment: Attachment) => SENT[attachment.url!] ?? null }) },
} as unknown as PipelineDeps);

const sent = (attachment: Attachment): MessageEnvelope =>
  ({
    id: `msg-${attachment.url}`,
    gateway: "telegram",
    gatewayId: "telegram:nouva",
    chatId: "100000001",
    chatType: "dm",
    senderId: "100000001",
    text: "nah ini maksud saya",
    attachments: [attachment],
    timestamp: 1_800_000_000_000,
  }) as MessageEnvelope;

/** What the provider is sent for a message carrying the intake's media: the parts after the text. */
async function toModel(media: ContentPart[]): Promise<ContentPart[]> {
  const message: ChatMessage = { role: "user", content: [{ type: "text", text: "nah ini maksud saya" }, ...media], timestamp: 1_800_000_000_000 };
  const [resolved] = await resolveImages([message]);
  return (resolved!.content as ContentPart[]).slice(1);
}

test("a file whose bytes are a picture is a picture in front of the model, whatever it was labelled", async () => {
  const result = await intake.store("nouva", sent({ type: "file", mimeType: "application/octet-stream", filename: "Screenshot.png", url: "png" }));
  expect(result.stored[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  expect(result.media).toHaveLength(1);
  // The notice says it is in front of the model, rather than sending the agent to open it with its tools.
  expect(result.notice).toContain("are in your context as pictures");

  const parts = await toModel(result.media);
  expect(parts.find((part) => part.type === "image")).toMatchObject({ type: "image", mimeType: "image/png" });
});

test("the type its bytes name is the one sent — a JPEG labelled PNG goes as a JPEG", async () => {
  const result = await intake.store("nouva", sent({ type: "image", mimeType: "image/png", filename: "photo.png", url: "jpeg" }));
  expect(result.stored[0]?.mimeType).toBe("image/jpeg");
  const parts = await toModel(result.media);
  expect(parts.find((part) => part.type === "image")).toMatchObject({ mimeType: "image/jpeg" });
});

test("a document that is not a picture stays a file for the agent's tools", async () => {
  const result = await intake.store("nouva", sent({ type: "file", mimeType: "application/pdf", filename: "report.pdf", url: "pdf" }));
  expect(result.stored[0]).toMatchObject({ type: "file", mimeType: "application/pdf" });
  expect(result.media).toEqual([]);
  expect(result.notice).toContain("report.pdf");
});

test("a picture in a format no provider takes is said as such, never sent — it would refuse the whole request", async () => {
  const result = await intake.store("nouva", sent({ type: "image", mimeType: "image/heic", filename: "IMG_0412.HEIC", url: "heic" }));
  expect(result.stored[0]).toMatchObject({ type: "image", mimeType: "image/heic" });

  const parts = await toModel(result.media);
  expect(parts.some((part) => part.type === "image")).toBe(false);
  expect(parts).toContainEqual({
    type: "text",
    text: "[image: IMG_0412.HEIC: image/heic is not a format the model can be sent; ask for a PNG or JPEG, or convert it with your tools]",
  });
});
