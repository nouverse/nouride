/**
 * A video, taken apart into what a model can actually take: a few frames and its sound.
 *
 * No chat model this daemon talks to takes a video file on the OpenAI wire, and Claude takes none at
 * all. Every one of them takes pictures, though, and some take sound — so a video becomes four frames
 * that go down the image path (seen natively, or described by `[media] image_model`) and a sound track
 * that goes down the audio path (heard, transcribed, or honestly not). Nothing here decides who sees
 * or hears what; it only produces the files.
 *
 * Four frames, from the middle of each quarter: the very first frame of a phone video is often black
 * or a blur of the thumb reaching for the button, and four is what a request can carry alongside the
 * message's own pictures without pushing them out of the image budget.
 *
 * Every file is written beside the video and reused, so opening it again later costs nothing.
 */

import { statFile } from "@nouride/runtime";
import { findFfmpeg, runFfmpeg, type FfmpegDeps } from "./ffmpeg.ts";

const FRAMES = 4;
/** Wide enough to read text on a screen recording; small enough that four cost what one photo does. */
const FRAME_WIDTH = 768;

export interface VideoParts {
  frames: { localPath: string; atSec: number }[];
  /** The sound, as mp3 — `null` for a silent video, which is not an error. */
  track: string | null;
  durationSec: number | null;
}

export type SplitVideo = { ok: true; parts: VideoParts } | { ok: false; reason: "no_ffmpeg" | "unreadable" };

export async function splitVideo(
  file: { localPath: string; durationSec?: number },
  deps: FfmpegDeps = {},
): Promise<SplitVideo> {
  const ffmpeg = findFfmpeg(deps);
  if (!ffmpeg) return { ok: false, reason: "no_ffmpeg" };

  const probe = await probeVideo(ffmpeg, file.localPath);
  const durationSec = file.durationSec ?? probe.durationSec;
  const frames: VideoParts["frames"] = [];
  for (let index = 0; index < FRAMES; index += 1) {
    // Unknown length: the first frame only, which every decodable video has.
    if (durationSec === null && index > 0) break;
    const atSec = durationSec === null ? 0 : (durationSec * (index + 0.5)) / FRAMES;
    const out = `${file.localPath}.frame-${index + 1}.jpg`;
    const done =
      statFile(out) !== null ||
      (await runFfmpeg(
        ffmpeg,
        file.localPath,
        ["-loglevel", "error", "-frames:v", "1", "-vf", `scale='min(${FRAME_WIDTH},iw)':-2`, "-q:v", "4", out],
        // Seeking before the input is the fast seek: it jumps to the nearest keyframe instead of
        // decoding everything up to the timestamp, which on a long video is the whole cost.
        ["-ss", atSec.toFixed(2)],
      )).ok;
    if (done && statFile(out)) frames.push({ localPath: out, atSec });
  }
  if (frames.length === 0) return { ok: false, reason: "unreadable" };

  // A silent video has no track to extract, and asking for one anyway is an ffmpeg error in the log
  // for every screen recording anybody sends.
  const trackPath = `${file.localPath}.sound.mp3`;
  // A track already on disk is used whatever the probe says — it was extracted from this file before.
  const track =
    statFile(trackPath) !== null ||
    (probe.hasAudio &&
      (await runFfmpeg(ffmpeg, file.localPath, ["-loglevel", "error", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", trackPath])).ok)
      ? trackPath
      : null;

  return { ok: true, parts: { frames, track: track && statFile(track) ? track : null, durationSec } };
}

/**
 * The length and whether there is any sound, read from ffmpeg's own stream summary.
 *
 * `ffmpeg -i file` with no output prints `Duration: 00:01:23.45` and one `Stream … Audio:` line per
 * sound track to stderr, and exits non-zero — which is the answer, not a failure. No ffprobe, because
 * a bundled or minimal ffmpeg often ships without it.
 */
async function probeVideo(ffmpeg: string, localPath: string): Promise<{ durationSec: number | null; hasAudio: boolean }> {
  const { stderr } = await runFfmpeg(ffmpeg, localPath, []);
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  return { durationSec: seconds > 0 ? seconds : null, hasAudio: /Stream #\S+.*: Audio:/.test(stderr) };
}
