/**
 * The files of messages handed up and not yet answered, held for the daemon to ask for (`fetch_media`) once it has
 * let the sender in. Downloaded as they came, a sender nobody answers filled the disk: a blocked one, one past their
 * messages, a group's chatter.
 *
 * What is held is the message, not the file: the address of its download and the key that opens it, a few
 * kilobytes. Written in the number's own folder, encrypted with its login's key as the login is, so a restart keeps
 * it: a message waiting in the daemon's inbox across a restart, or a picture overheard in a group and asked about
 * later, was otherwise answered as gone. Asked for more than once (two agents answering one message), it is there
 * each time. The newest `HELD_MAX`, each for `HELD_FOR_MS`; a file that cannot be read back is let go.
 */

import { ensureDir, join, listDir, openAesGcm, readBytesSync, removePath, renamePath, sealAesGcm, writeBytesSync } from "@nouride/runtime";
import { BufferJSON, type WAMessage } from "@whiskeysockets/baileys";

/** The newest this many. A message is a few kilobytes: five hundred is a couple of megabytes on disk at most. */
export const HELD_MAX = 500;
/**
 * Each for this long: a message waits in a queue for minutes, a picture overheard in a group is asked about within the
 * week, and past that its address has usually aged out at WhatsApp, where only the sender's phone can send it again.
 */
export const HELD_FOR_MS = 7 * 24 * 60 * 60 * 1000;

export interface Held {
  message: WAMessage;
  at: number;
  mimeType: string;
  fileName?: string;
}

/** A ref names a file: kept to what a file name may hold, as the login's files are. */
const fileOf = (dir: string, ref: string): string => join(dir, `${ref.replace(/[^0-9A-Za-z._-]/g, "_")}.enc`);

export class HeldFiles {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly dir: string,
    private readonly key: Uint8Array,
    private readonly note: (message: string, detail?: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** What an earlier start held, read back: the expired and the unreadable let go, the newest kept. */
  load(): void {
    ensureDir(this.dir, 0o700);
    const found: [string, Held][] = [];
    for (const { name, isFile } of listDir(this.dir)) {
      if (!isFile || !name.endsWith(".enc")) continue;
      const path = join(this.dir, name);
      try {
        const one = JSON.parse(new TextDecoder().decode(openAesGcm(this.key, readBytesSync(path))), BufferJSON.reviver) as Held & { ref: string };
        if (this.now() - one.at > HELD_FOR_MS) removePath(path);
        else found.push([one.ref, { message: one.message, at: one.at, mimeType: one.mimeType, ...(one.fileName ? { fileName: one.fileName } : {}) }]);
      } catch (err) {
        // Another login's key, or a half-written file: nothing anybody can fetch, so it goes.
        this.note("a held file could not be read back, and is let go", { file: name, error: String(err) });
        removePath(path);
      }
    }
    found.sort((a, b) => a[1].at - b[1].at);
    for (const [ref, one] of found) this.held.set(ref, one);
    this.trim();
  }

  hold(ref: string, one: Held): void {
    this.held.set(ref, one);
    try {
      ensureDir(this.dir, 0o700);
      const path = fileOf(this.dir, ref);
      // Written aside and renamed, as the login is: a crash mid-write leaves no half-file to be read back.
      writeBytesSync(`${path}.tmp`, sealAesGcm(this.key, new TextEncoder().encode(JSON.stringify({ ref, ...one }, BufferJSON.replacer))), 0o600);
      renamePath(`${path}.tmp`, path);
    } catch (err) {
      // Held in memory still: only a restart loses it, as before this was kept on disk.
      this.note("a held file could not be written to disk; it is held until the next start", { error: String(err) });
    }
    this.trim();
  }

  /** The held file, while it is held; asked for again, it is there again. */
  get(ref: string): Held | undefined {
    const one = this.held.get(ref);
    if (one && this.now() - one.at > HELD_FOR_MS) {
      this.forget(ref);
      return undefined;
    }
    return one;
  }

  get size(): number {
    return this.held.size;
  }

  /** Those past their time, then the oldest beyond the newest kept. */
  private trim(): void {
    const now = this.now();
    for (const [ref, one] of this.held) if (now - one.at > HELD_FOR_MS) this.forget(ref);
    while (this.held.size > HELD_MAX) this.forget(this.held.keys().next().value as string);
  }

  private forget(ref: string): void {
    this.held.delete(ref);
    try {
      removePath(fileOf(this.dir, ref));
    } catch {
      // Already gone.
    }
  }
}
