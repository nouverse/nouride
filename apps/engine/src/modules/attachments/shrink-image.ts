/**
 * A smaller copy of a picture that is too large on a side for a model, made by ffmpeg and kept for the next request.
 *
 * A provider refuses a request over one picture past its limit in pixels, and a conversation holds its pictures: once
 * a long screenshot was in one, every turn after it died the same way, whatever was asked. A model reads no more than
 * the bound anyway and scales the rest down itself, so the copy loses nothing it would have seen.
 *
 * Kept in memory, not beside the file: a picture an agent opened with `read` is in its workspace, and a copy written
 * there is a file in somebody's repository. A conversation is resolved again for every request of every turn, so
 * without keeping it each one would run ffmpeg once per large picture.
 */

import { join, makeTempDir, readFileBytes, removePath, statFile, tempDir } from "@nouride/runtime";
import { createLogger, imageSize, sniffImageMime } from "@nouride/shared";
import { findFfmpeg, runFfmpeg, type FfmpegDeps } from "./ffmpeg.ts";

const log = createLogger("attachments.shrink");

/** What the kept copies may weigh together: about what two requests carry in pictures. */
const KEPT_BYTES = 32 * 1024 * 1024;
/** And how many answers, the ones that weigh nothing included: a file ffmpeg cannot read is not asked about again. */
const MOST_KEPT = 512;

export interface SmallerImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ShrinkDeps extends FfmpegDeps {
  /** Replaces the run, so a test can stand in for ffmpeg: it writes its output where the last argument says. */
  run?: typeof runFfmpeg;
  keptBytes?: number;
}

export class ImageShrinker {
  /** Newest last: a `Map` keeps the order things were put in, so the first key is the one longest unused. */
  private readonly kept = new Map<string, SmallerImage | null>();
  private weight = 0;

  constructor(private readonly deps: ShrinkDeps = {}) {}

  /**
   * The picture at `path`, no longer than `maxSide` pixels on a side, or `null` where no copy can be made: no ffmpeg
   * on this machine, a file it cannot read, a copy that came out no smaller. Never throws.
   */
  async shrink(path: string, maxSide: number): Promise<SmallerImage | null> {
    const stat = statFile(path);
    if (!stat) return null;
    // The file's size and time with its path: a file written again under the same name is another picture.
    const key = [path, stat.size, stat.mtimeMs, maxSide].join("\u0000");
    const known = this.kept.get(key);
    if (known !== undefined) {
      this.kept.delete(key);
      this.kept.set(key, known);
      return known;
    }

    const ffmpeg = findFfmpeg(this.deps);
    // Not kept: ffmpeg installed a minute from now is found by the next request.
    if (!ffmpeg) return null;
    const made = await this.make(ffmpeg, path, maxSide);
    this.keep(key, made);
    return made;
  }

  private async make(ffmpeg: string, path: string, maxSide: number): Promise<SmallerImage | null> {
    let work = "";
    try {
      const original = sniffImageMime(await readFileBytes(path));
      // A photograph stays one: as PNG it would weigh several times what it did. Everything else is a screenshot or a
      // drawing more often than not, where JPEG smears the text a model is asked to read.
      const photo = original === "image/jpeg";
      work = makeTempDir(tempDir(), "nouride-picture-");
      const out = join(work, photo ? "smaller.jpg" : "smaller.png");
      const fit = `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
      const ran = await (this.deps.run ?? runFfmpeg)(ffmpeg, path, ["-loglevel", "error", "-frames:v", "1", "-vf", fit, ...(photo ? ["-q:v", "3"] : []), out]);
      if (!ran.ok || !statFile(out)) return null;
      const bytes = await readFileBytes(out);
      const mimeType = sniffImageMime(bytes);
      const size = imageSize(bytes);
      // What came out is checked as what went in was: a copy still too large would be refused like the original.
      if (!mimeType || !size || Math.max(size.width, size.height) > maxSide) {
        log.warn("a smaller copy of a picture came out wrong", { path, type: mimeType, width: size?.width, height: size?.height, max_side: maxSide });
        return null;
      }
      return { bytes, mimeType };
    } catch (err) {
      log.warn("a smaller copy of a picture could not be made", { path, error: String(err) });
      return null;
    } finally {
      if (work) removePath(work);
    }
  }

  private keep(key: string, made: SmallerImage | null): void {
    const most = this.deps.keptBytes ?? KEPT_BYTES;
    const weighs = made?.bytes.byteLength ?? 0;
    // One too heavy to keep is made again next time, which is slow and still right.
    if (weighs > most) return;
    this.kept.set(key, made);
    this.weight += weighs;
    for (const [oldest, copy] of this.kept) {
      if (this.weight <= most && this.kept.size <= MOST_KEPT) break;
      this.kept.delete(oldest);
      this.weight -= copy?.bytes.byteLength ?? 0;
    }
  }
}
