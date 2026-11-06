/**
 * A stored voice note, made ready to send.
 *
 * The property the appliance depends on: a voice note in a format the model takes is sent as it
 * arrived, and nothing is run. ffmpeg is the exception, for a model whose gateway takes only mp3/wav.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareClip } from "@/modules/attachments/voice-clip.ts";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function voiceNote(bytes = 100): string {
  dir = mkdtempSync(join(tmpdir(), "voice-"));
  const path = join(dir, "note.ogg");
  writeFileSync(path, new Uint8Array(bytes));
  return path;
}

const limits = { maxSeconds: 600, maxBytes: 1_000_000 };
const ogg = (localPath: string, durationSec?: number) => ({
  localPath,
  mimeType: "audio/ogg; codecs=opus",
  ...(durationSec === undefined ? {} : { durationSec }),
});

describe("preparing a voice note", () => {
  test("an Ogg note to a model that takes Ogg is sent as it is, and ffmpeg is never run", async () => {
    const path = voiceNote();
    let ran = 0;
    const clip = await prepareClip(ogg(path), { hears: true, formats: ["mp3", "wav", "ogg"] }, limits, {
      transcode: async () => ((ran += 1), true),
    });
    expect(clip).toEqual({ ok: true, localPath: path, format: "ogg" });
    expect(ran).toBe(0);
  });

  test("to a model that takes only mp3 it is transcoded once, and the result is reused", async () => {
    const path = voiceNote();
    let ran = 0;
    const transcode = async (_input: string, output: string) => {
      ran += 1;
      writeFileSync(output, new Uint8Array(50));
      return true;
    };
    const hearing = { hears: true as const, formats: ["mp3", "wav"] as ("mp3" | "wav")[] };

    const first = await prepareClip(ogg(path), hearing, limits, { transcode });
    const second = await prepareClip(ogg(path), hearing, limits, { transcode });
    expect(first).toEqual({ ok: true, localPath: `${path}.voice.mp3`, format: "mp3" });
    expect(second).toEqual(first);
    expect(ran).toBe(1);
  });

  test("no ffmpeg is a reason, not a crash", async () => {
    const clip = await prepareClip(ogg(voiceNote()), { hears: true, formats: ["mp3"] }, limits, { which: () => null });
    expect(clip).toEqual({ ok: false, reason: "no_ffmpeg" });
  });

  test("a failed transcode leaves nothing behind for the next voice note to pick up", async () => {
    const path = voiceNote();
    const clip = await prepareClip(ogg(path), { hears: true, formats: ["mp3"] }, limits, {
      transcode: async (_input, output) => (writeFileSync(output, "half"), false),
    });
    expect(clip).toEqual({ ok: false, reason: "transcode_failed" });
    expect(existsSync(`${path}.voice.mp3`)).toBe(false);
  });

  test("a model that cannot hear passes its reason through", async () => {
    expect(await prepareClip(ogg(voiceNote()), { hears: false, reason: "wire_no_audio" }, limits)).toEqual({
      ok: false,
      reason: "wire_no_audio",
    });
  });

  test("too long is refused from the platform's duration, before any work", async () => {
    const clip = await prepareClip(ogg(voiceNote(), 3600), { hears: true, formats: ["ogg"] }, limits, {
      transcode: async () => {
        throw new Error("must not run");
      },
    });
    expect(clip).toEqual({ ok: false, reason: "too_long" });
  });

  test("too large is measured on the file that would be sent", async () => {
    const clip = await prepareClip(ogg(voiceNote(2_000_000)), { hears: true, formats: ["ogg"] }, limits);
    expect(clip).toEqual({ ok: false, reason: "too_large" });
  });
});
