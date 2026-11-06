/**
 * A video, split into what a model can take: frames, and a sound track.
 *
 * Run against a real ffmpeg, because the parts that break are ffmpeg's — a seek flag in the wrong
 * place, a filter a minimal build lacks, a silent video treated as an error. `NOURIDE_TEST_FFMPEG`
 * names one; otherwise the one on PATH, if it runs. With neither, the ffmpeg tests are skipped and the
 * one that needs no ffmpeg still runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, whichBinary } from "@nouride/runtime";
import { splitVideo } from "@/modules/attachments/video.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "media");
const candidate = process.env.NOURIDE_TEST_FFMPEG ?? whichBinary("ffmpeg");
const works =
  candidate !== null &&
  (await runCommand([candidate, "-version"], { cwd: tmpdir(), timeoutMs: 5000, maxOutputBytes: 4096, env: {} })).exitCode === 0;
const ffmpeg = { which: () => candidate };

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A copy in a directory of its own — the split writes its files beside the video. */
function video(name: string): string {
  dir = mkdtempSync(join(tmpdir(), "video-"));
  const path = join(dir, name);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

describe("splitting a video", () => {
  test.skipIf(!works)("four frames and the sound, from a video that talks", async () => {
    const path = video("talking.mp4");
    const split = await splitVideo({ localPath: path }, ffmpeg);
    if (!split.ok) throw new Error(`split failed: ${split.reason}`);

    expect(split.parts.frames).toHaveLength(4);
    for (const frame of split.parts.frames) expect(existsSync(frame.localPath)).toBe(true);
    // Read from the middle of each quarter, never the first frame: that one is often black.
    expect(split.parts.frames[0]!.atSec).toBeGreaterThan(0);
    expect(split.parts.durationSec).toBeCloseTo(1.79, 1);
    expect(split.parts.track).toBe(`${path}.sound.mp3`);
    expect(existsSync(split.parts.track!)).toBe(true);
  });

  test.skipIf(!works)("a silent video has frames and no track — which is not a failure", async () => {
    const split = await splitVideo({ localPath: video("silent.mp4") }, ffmpeg);
    if (!split.ok) throw new Error(`split failed: ${split.reason}`);
    expect(split.parts.frames).toHaveLength(4);
    expect(split.parts.track).toBeNull();
  });

  test.skipIf(!works)("the second time costs nothing: the files are reused", async () => {
    const path = video("talking.mp4");
    await splitVideo({ localPath: path }, ffmpeg);
    // A binary that cannot run proves nothing was run: every part has to come from disk.
    const again = await splitVideo({ localPath: path, durationSec: 1.79 }, { which: () => "/bin/false" });
    if (!again.ok) throw new Error(`reuse failed: ${again.reason}`);
    expect(again.parts.frames).toHaveLength(4);
    expect(again.parts.track).toBe(`${path}.sound.mp3`);
  });

  test("no ffmpeg is a reason, not a crash", async () => {
    expect(await splitVideo({ localPath: "/nowhere.mp4" }, { which: () => null })).toEqual({ ok: false, reason: "no_ffmpeg" });
  });
});
