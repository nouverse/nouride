/**
 * Voice notes and videos through the intake, end to end: what reaches the model, what it is told,
 * and what the operator hears about.
 *
 * The disk is real and the network is not. `AttachmentIntake.store` is the one place the pieces meet
 * — hearing, preparation, transcription, video splitting, the notice and the alert — and each piece
 * being right on its own has not stopped them disagreeing before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, whichBinary } from "@nouride/runtime";
import type { Attachment, MessageEnvelope } from "@nouride/shared";
import { AttachmentIntake } from "@/modules/pipeline/attachments.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "media");
const candidate = process.env.NOURIDE_TEST_FFMPEG ?? whichBinary("ffmpeg");
const ffmpegWorks =
  candidate !== null &&
  (await runCommand([candidate, "-version"], { cwd: tmpdir(), timeoutMs: 5000, maxOutputBytes: 4096, env: {} })).exitCode === 0;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

interface Setup {
  kind?: "openai" | "anthropic";
  listing?: object[];
  transcribeProvider?: string;
  transcript?: string | "fail";
  ffmpeg?: string | null;
  ownerChat?: boolean;
}

function intake(setup: Setup) {
  dir = mkdtempSync(join(tmpdir(), "intake-"));
  const alerts: string[] = [];
  const requests: string[] = [];
  const deps = {
    config: {
      media: {
        imageModel: "",
        readImages: true,
        maxImageBytes: 8 * 1024 * 1024,
        readAudio: true,
        audioInput: "auto",
        maxAudioSeconds: 600,
        maxAudioBytes: 20 * 1024 * 1024,
        transcribeProvider: setup.transcribeProvider ?? "",
        transcribeModel: "whisper-1",
      },
    },
    providers: { endpointFor: () => ({ kind: setup.kind ?? "openai", baseUrl: "https://gw.invalid/v1", apiKey: "k" }) },
    notifier: {
      alert: async (_key: string, text: string) => (alerts.push(text), true),
      isOwnerChat: () => setup.ownerChat === true,
    },
    gateways: { get: () => ({ fetchAttachment: async () => new Uint8Array([1]) }) },
    // The store writes the platform's bytes to disk; here the "download" is a copy of a fixture or a
    // few bytes, which is all the intake reads.
    attachments: {
      store: async (_scope: unknown, attachment: Attachment & { source?: string }, _fetch: unknown, index: number) => {
        const localPath = join(dir, attachment.filename ?? `file-${index}`);
        if (attachment.source) copyFileSync(attachment.source, localPath);
        else writeFileSync(localPath, new Uint8Array(64));
        return { ...attachment, localPath, ref: `r/${index}` };
      },
    },
  } as unknown as PipelineDeps;

  const fetchImpl = (async (url: string) => {
    requests.push(url);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: setup.listing ?? [] }), { status: 200 });
    if (setup.transcript === "fail") return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ text: setup.transcript ?? "" }), { status: 200 });
  }) as unknown as typeof fetch;

  const subject = new AttachmentIntake(deps, { fetchImpl, which: () => (setup.ffmpeg === undefined ? candidate : setup.ffmpeg) });
  return { subject, alerts, requests };
}

const envelope = (attachments: (Attachment & { source?: string })[]): MessageEnvelope =>
  ({ id: "m1", gateway: "telegram", gatewayId: "telegram:main", chatId: "c1", attachments }) as unknown as MessageEnvelope;

const voice = (extra: Partial<Attachment> = {}): Attachment => ({
  type: "voice",
  mimeType: "audio/ogg",
  filename: "voice.ogg",
  duration: 7,
  ...extra,
});

const target = { agentId: "nouva", profile: "nougate", model: "antigravity:gemini-flash" };
const hears = [{ id: "antigravity:gemini-flash", input_modalities: ["text", "audio"], input_audio_formats: ["mp3", "wav", "ogg"] }];

describe("a voice note", () => {
  test("to a model that hears: sent as it arrived, and the model is told to listen", async () => {
    const { subject, alerts } = intake({ listing: hears });
    const result = await subject.store("nouva", envelope([voice()]), target);

    expect(result.media).toEqual([
      { type: "audio_ref", ref: expect.any(String), localPath: join(dir, "voice.ogg"), format: "ogg", durationSec: 7, filename: "voice.ogg" },
    ]);
    expect(result.notice).toContain("listen to it");
    expect(alerts).toHaveLength(0);
  });

  test("to Claude: nothing sent, the model told it cannot hear, the operator told once", async () => {
    const { subject, alerts } = intake({ kind: "anthropic" });
    const first = await subject.store("nouva", envelope([voice()]), target);
    await subject.store("nouva", envelope([voice()]), target);

    expect(first.media).toEqual([]);
    expect(first.notice).toContain("you cannot hear it");
    expect(first.notice).toContain("Do not guess");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Anthropic format");
  });

  test("from the operator's own chat, the fix is in the reply and no alert repeats it", async () => {
    const { subject, alerts } = intake({ kind: "anthropic", ownerChat: true });
    const result = await subject.store("nouva", envelope([voice()]), target);
    expect(result.notice).toContain("runs this daemon");
    expect(alerts).toHaveLength(0);
  });

  test("to a model that cannot hear, with transcription on: the words, labelled as a transcript", async () => {
    const { subject, alerts, requests } = intake({ kind: "anthropic", transcribeProvider: "groq", transcript: "meeting moved to nine" });
    const result = await subject.store("nouva", envelope([voice()]), target);

    expect(result.media).toEqual([]);
    expect(requests.some((url) => url.endsWith("/audio/transcriptions"))).toBe(true);
    expect(result.notice).toContain("meeting moved to nine");
    expect(result.notice).toContain("machine transcript");
    // It worked, so there is nothing for the operator to fix.
    expect(alerts).toHaveLength(0);
  });

  test("a transcription service that fails is said to have failed — not treated as silence", async () => {
    const { subject, alerts } = intake({ kind: "anthropic", transcribeProvider: "groq", transcript: "fail" });
    const result = await subject.store("nouva", envelope([voice()]), target);
    expect(result.notice).toContain("transcription service could not");
    expect(alerts[0]).toContain("transcribe_provider");
  });

  test("a forwarded voice note is somebody else's recording", async () => {
    const { subject } = intake({ listing: hears });
    const result = await subject.store("nouva", envelope([voice({ forwarded: true })]), target);
    expect(result.notice).toContain("It is a recording, not the sender");
  });
});

describe("a video", () => {
  const clip = (name: string, extra: Partial<Attachment> = {}) => ({
    type: "video" as const,
    mimeType: "video/mp4",
    filename: name,
    source: join(FIXTURES, name),
    ...extra,
  });

  test.skipIf(!ffmpegWorks)("becomes four frames the model sees, and sound it hears", async () => {
    const { subject } = intake({ listing: hears });
    const result = await subject.store("nouva", envelope([clip("talking.mp4", { recordedBySender: true })]), target);

    expect(result.media.filter((part) => part.type === "image_ref")).toHaveLength(4);
    expect(result.media.filter((part) => part.type === "audio_ref")).toHaveLength(1);
    expect(result.notice).toContain("still frame(s)");
    expect(result.notice).toContain("not the video");
    // A video note is the sender talking, like a voice note.
    expect(result.notice).toContain("It is the sender speaking to you");
    // The turn record gets the video that arrived, not the frames made from it.
    expect(result.stored).toHaveLength(1);
  });

  test.skipIf(!ffmpegWorks)("to Claude: the frames still go, the sound is honestly not heard", async () => {
    const { subject } = intake({ kind: "anthropic" });
    const result = await subject.store("nouva", envelope([clip("talking.mp4")]), target);
    expect(result.media.filter((part) => part.type === "image_ref")).toHaveLength(4);
    expect(result.media.filter((part) => part.type === "audio_ref")).toHaveLength(0);
    expect(result.notice).toContain("The sound of the video");
    expect(result.notice).toContain("you cannot hear it");
  });

  test("with no ffmpeg: not seen, said so, and the operator told how to fix it", async () => {
    const { subject, alerts } = intake({ listing: hears, ffmpeg: null });
    const result = await subject.store("nouva", envelope([clip("talking.mp4")]), target);
    expect(result.media).toEqual([]);
    expect(result.notice).toContain("you cannot see it");
    expect(alerts.some((text) => text.includes("ffmpeg"))).toBe(true);
  });
});
