/**
 * A stored audio file, made ready to send — or the reason it will not be.
 *
 * Most of the time this does nothing at all. A Telegram or WhatsApp voice note is Ogg Opus, and
 * Nougate takes `ogg` for the Gemini models that hear it, so the file on disk *is* the file sent: no
 * ffmpeg, no CPU, nothing written. Transcoding is for a model whose gateway takes only what OpenAI's
 * `input_audio` defines, and it runs once — the result sits beside the original and is reused.
 *
 * Every failure here is a reason, never a throw. A clip that cannot be sent is still a voice note the
 * sender is waiting on an answer to, and the answer is the honest one: it could not be heard.
 */

import { removePath, statFile } from "@nouride/runtime";
import type { AudioFormat } from "@nouride/shared";
import { findFfmpeg, runFfmpeg } from "./ffmpeg.ts";
import type { DeafReason, Hearing } from "./hearing.ts";

/**
 * Why a clip was not sent: the hearing reasons, plus what can go wrong with the file itself.
 * `transcribe_failed` is set by the intake, when the fallback service was asked and failed.
 */
export type UnheardReason = DeafReason | "no_ffmpeg" | "transcode_failed" | "transcribe_failed" | "too_long" | "too_large";

export type PreparedClip =
  | { ok: true; localPath: string; format: AudioFormat }
  | { ok: false; reason: UnheardReason };

export interface ClipLimits {
  maxSeconds: number;
  maxBytes: number;
}

export interface ClipDeps {
  /** Injectable so a test can stand in for ffmpeg. Resolves `true` when `output` was written. */
  transcode?: (input: string, output: string, format: AudioFormat) => Promise<boolean>;
  which?: (name: string) => string | null;
}

export async function prepareClip(
  file: { localPath: string; mimeType: string; durationSec?: number },
  hearing: Hearing,
  limits: ClipLimits,
  deps: ClipDeps = {},
): Promise<PreparedClip> {
  if (!hearing.hears) return { ok: false, reason: hearing.reason };
  // The platform's own duration, before any work: a podcast is refused without being read.
  if (file.durationSec !== undefined && file.durationSec > limits.maxSeconds) return { ok: false, reason: "too_long" };

  const original = formatOf(file.mimeType);
  if (original && hearing.formats.includes(original)) return sized(file.localPath, original, limits);

  // mp3 when it is on offer — it is a tenth of the size of wav for speech, which is what arrives.
  const target: AudioFormat = hearing.formats.includes("mp3") ? "mp3" : "wav";
  const output = `${file.localPath}.voice.${target}`;
  if (statFile(output)) return sized(output, target, limits);

  const ffmpeg = findFfmpeg(deps);
  if (!ffmpeg && !deps.transcode) return { ok: false, reason: "no_ffmpeg" };

  const transcode = deps.transcode ?? ((input, out, format) => transcodeWith(ffmpeg as string, input, out, format));
  const done = await transcode(file.localPath, output, target).catch(() => false);
  if (!done || !statFile(output)) {
    // A half-written file left here would be picked up as a finished transcode by the reuse check
    // above, and sent — so a failure takes its output with it.
    removePath(output);
    return { ok: false, reason: "transcode_failed" };
  }
  return sized(output, target, limits);
}

/**
 * The format a MIME type names, or `null` for one that has to be converted.
 *
 * Parameters stripped first: WhatsApp sends `audio/ogg; codecs=opus`. `audio/opus` is Opus in an Ogg
 * container in practice, which is what every gateway means by `ogg`.
 */
function formatOf(mimeType: string): AudioFormat | null {
  const bare = mimeType.split(";")[0]!.trim().toLowerCase();
  if (bare === "audio/ogg" || bare === "audio/opus" || bare === "audio/oga") return "ogg";
  if (bare === "audio/mpeg" || bare === "audio/mp3") return "mp3";
  if (bare === "audio/wav" || bare === "audio/x-wav" || bare === "audio/wave") return "wav";
  return null;
}

function sized(localPath: string, format: AudioFormat, limits: ClipLimits): PreparedClip {
  const size = statFile(localPath)?.size;
  if (size === undefined) return { ok: false, reason: "transcode_failed" };
  if (size > limits.maxBytes) return { ok: false, reason: "too_large" };
  return { ok: true, localPath, format };
}

/**
 * Speech, small: mono, 16 kHz, 32 kbps for mp3. Ten minutes comes to about 2.4 MB, and nothing a
 * speech model listens for is lost below that.
 */
async function transcodeWith(ffmpeg: string, input: string, output: string, format: AudioFormat): Promise<boolean> {
  const codec = format === "wav" ? ["-c:a", "pcm_s16le"] : ["-b:a", "32k"];
  return (await runFfmpeg(ffmpeg, input, ["-loglevel", "error", "-vn", "-ac", "1", "-ar", "16000", ...codec, output])).ok;
}
