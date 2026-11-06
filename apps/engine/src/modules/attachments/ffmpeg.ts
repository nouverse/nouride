/**
 * ffmpeg, the one way in: no shell, a hard timeout, an empty environment, and `-nostdin` so a codec
 * that stops to ask something cannot sit until the timeout.
 *
 * Shared by the two things that need it — a voice note an upstream will only take as mp3, and a video
 * split into frames and a sound track — so both fail the same way and log the same thing.
 */

import { basename, dirname, runCommand, whichBinary } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";

const log = createLogger("attachments.ffmpeg");

/** Long enough for a ten-minute file on a Raspberry Pi; short enough that a hung decoder ends. */
const TIMEOUT_MS = 30_000;

export interface FfmpegDeps {
  /** Replaces the lookup, so a test can say "not installed" — or name a bundled binary. */
  which?: (name: string) => string | null;
}

/** The binary, or `null` when this machine has none. */
export function findFfmpeg(deps: FfmpegDeps = {}): string | null {
  return (deps.which ?? whichBinary)("ffmpeg");
}

/**
 * Run it on `input` with `args` (everything after `-i <input>`). `true` when it exited cleanly.
 *
 * `stderr` comes back too: a probe of a file's duration is read from it, because ffmpeg with no
 * output prints the stream summary there and exits non-zero, which is not a failure for that caller.
 */
export async function runFfmpeg(
  ffmpeg: string,
  input: string,
  args: string[],
  pre: string[] = [],
): Promise<{ ok: boolean; stderr: string }> {
  const result = await runCommand(
    [ffmpeg, "-nostdin", "-hide_banner", "-y", ...pre, "-i", input, ...args],
    { cwd: dirname(input), timeoutMs: TIMEOUT_MS, maxOutputBytes: 64 * 1024, env: {} },
  );
  const ok = result.exitCode === 0;
  if (!ok && args.length > 0) {
    log.warn("ffmpeg failed", {
      file: basename(input),
      exit: result.exitCode,
      timed_out: result.timedOut,
      error: result.stderr.slice(-300),
    });
  }
  return { ok, stderr: result.stderr };
}
