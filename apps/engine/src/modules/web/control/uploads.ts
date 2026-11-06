/**
 * Files the dashboard sends, on their way to becoming attachments.
 *
 * Every other gateway hands the pipeline a *reference* — a Telegram file id, a Discord CDN URL — and
 * the attachment intake fetches it. A browser has no such reference: it holds bytes. So they land here
 * first, on disk, and what travels into the turn is a path, which is exactly the shape the local
 * gateway already knows how to read.
 *
 * ## Why this directory is a boundary, not just a folder
 *
 * `parseAttachments` accepts any path, which is right for the CLI — it runs as the operator, on their
 * own machine, and `/attach ~/report.pdf` in `nouride chat` is the whole point. It is wrong for a browser:
 * a dashboard account is not necessarily the host's owner, and a request that could name
 * `/etc/shadow` as an attachment would turn "send a file" into "read anything this daemon can". So the
 * chat route accepts paths only from inside this directory, and this module is the only thing that
 * writes here.
 *
 * ## Why the copies are short-lived
 *
 * The durable copy is the agent's attachment store: the intake reads these bytes, writes them into the
 * conversation's own directory, and everything afterwards — the model, `read`, the retention sweep —
 * works from there. What is left here is a spare copy of something already saved, so it goes the next
 * day rather than living out the retention window twice.
 */

import {
  basename,
  ensureDir,
  join,
  listDir,
  removePath,
  statFile,
  writeFileAtomic,
} from "@nouride/runtime";
import { createLogger, newId } from "@nouride/shared";

const log = createLogger("control.uploads");

/**
 * Files per request.
 *
 * A cap because a browser can offer a thousand-file directory in one drop, and without one the request
 * fills the disk before anything has validated it. Ten is more than a message needs and far less than
 * an accident.
 */
export const MAX_FILES_PER_REQUEST = 10;

/**
 * How long a spare copy lives here.
 *
 * One day, because that is what it is: a copy of bytes the attachment store already holds. Anything
 * longer keeps two of every screenshot anybody ever sent, in a directory nothing reads.
 */
const UPLOAD_RETENTION_DAYS = 1;

export interface StoredUpload {
  /** The name on disk, which is deliberately not the name the person chose. */
  path: string;
  /** What they called it — for the chat, the prompt and the transcript. */
  name: string;
  mimeType: string;
  bytes: number;
}

/**
 * A filename that is safe to put on disk, from one that came out of a browser.
 *
 * Windows separators are flattened first: `name` is whatever the client sent, and a backslashed
 * traversal is a perfectly ordinary string in a multipart part header — one that `basename` does not
 * strip on Linux.
 */
export function safeFileName(raw: string): string {
  const flattened = raw.replaceAll("\\", "/");
  const base = basename(flattened).trim();
  const cleaned = base
    .replace(/[^A-Za-z0-9._\-()[\] ]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

/** Why this file cannot be accepted, or null. */
export function refuseUpload(file: { name: string; size: number }, maxBytes: number): string | null {
  if (file.size <= 0) return `"${file.name}" is empty`;
  if (file.size > maxBytes) {
    const mb = (n: number) => Math.max(1, Math.round(n / 1024 / 1024));
    return `"${file.name}" is ${mb(file.size)}MB, over the limit of ${mb(maxBytes)}MB`;
  }
  return null;
}

export class UploadStore {
  constructor(readonly dir: string) {}

  /**
   * Write one file and say where it went.
   *
   * The stored name is `<id>-<safe name>`: the id makes a collision impossible without hiding what the
   * file is, which matters because the agent is about to be handed this path — and a directory of
   * `a3f9c2.bin` is one nobody can reason about.
   */
  async save(file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<StoredUpload> {
    ensureDir(this.dir);
    const name = safeFileName(file.name);
    const path = join(this.dir, `${newId("up")}-${name}`);
    await writeFileAtomic(path, file.bytes);
    return { path, name, mimeType: file.mimeType, bytes: file.bytes.byteLength };
  }

  /**
   * Is this path one of ours?
   *
   * What the chat route asks before letting a browser name a file. Directly inside the directory, not
   * anywhere beneath it — there are no subdirectories here, so a path claiming one is a path trying
   * something.
   */
  holds(path: string): boolean {
    const prefix = this.dir.endsWith("/") ? this.dir : `${this.dir}/`;
    if (!path.startsWith(prefix)) return false;
    const rest = path.slice(prefix.length);
    return rest.length > 0 && !rest.includes("/");
  }

  /** Delete spare copies older than `days`. Called from the daily sweep. */
  sweep(days: number = UPLOAD_RETENTION_DAYS, now: number = Date.now()): number {
    if (days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60_000;
    let removed = 0;
    for (const entry of listDir(this.dir)) {
      if (entry.isDirectory) continue;
      const path = join(this.dir, entry.name);
      const stat = statFile(path);
      if (stat && stat.mtimeMs < cutoff) {
        removePath(path);
        removed += 1;
      }
    }
    if (removed > 0) log.debug("old upload copies removed", { files: removed });
    return removed;
  }
}
