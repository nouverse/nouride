/**
 * How large the data folder is, by what is in it: what System's Overview shows under the disk.
 *
 * Counted by `du`, each entry of the folder by its name, in a process of its own: a data folder is tens of gigabytes in hundreds of thousands of files, and
 * walking it in the daemon would hold every conversation still for as long as that takes. So a reading is asked for
 * and comes later: `read` answers what is known now and starts a measure when none is fresh, and the page asks again.
 * Nothing runs while no one has the page open.
 */

import type { SystemFolderSizes } from "@nouride/wire";
import { listDir, runCommand } from "@nouride/runtime";
import { contained, createLogger } from "@nouride/shared";

const log = createLogger("web.system");

/** A measure is good for this long: a folder's size is not a figure that moves by the minute. */
const FRESH_MS = 10 * 60_000;
/** A measure that takes longer than this is given up, and said as not available until asked again. */
const TIMEOUT_MS = 120_000;

type Run = (cmd: string[], opts: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: Record<string, string> }) => Promise<{ stdout: string; timedOut: boolean }>;

/**
 * `du -sk -- ./a ./b …`'s lines read: what each entry of the folder takes on disk, largest first, and their sum.
 * Null when it printed no line for anything asked: nothing was counted, and that is not a size of zero.
 *
 * Each entry by its name, and not `du -a -d 1` of the folder: the BSD `du` a Mac has refuses those two together.
 */
export function folderSizesOf(stdout: string): { totalBytes: number; entries: { name: string; bytes: number }[] } | null {
  const entries: { name: string; bytes: number }[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\d+)\t\.\/(.+)$/.exec(line);
    if (match) entries.push({ name: match[2]!.replace(/\/+$/, ""), bytes: Number(match[1]) * 1024 });
  }
  if (entries.length === 0) return null;
  return { totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), entries: entries.sort((a, b) => b.bytes - a.bytes) };
}

export class FolderSizes {
  private known: { at: number; totalBytes: number; entries: { name: string; bytes: number }[] } | null = null;
  private measuring = false;
  /** When the last measure came to nothing, so the next is not started at every look: a `du` that is not there is not there a second later either. */
  private failedAt: number | null = null;

  constructor(
    private readonly root: string,
    private readonly run: Run = runCommand,
    private readonly now: () => number = Date.now,
  ) {}

  /** What is known now, with a measure started when there is none or it has gone stale. */
  read(): SystemFolderSizes {
    const last = Math.max(this.known?.at ?? -Infinity, this.failedAt ?? -Infinity);
    if (this.now() - last > FRESH_MS && !this.measuring) contained(log, "the data folder's size was not measured", () => this.measure())();
    const state = this.measuring ? "measuring" : this.known ? "ready" : "unavailable";
    return { state, measuredAt: this.known?.at ?? null, totalBytes: this.known?.totalBytes ?? null, entries: this.known?.entries ?? [] };
  }

  private async measure(): Promise<void> {
    this.measuring = true;
    try {
      const names = listDir(this.root).map((entry) => `./${entry.name}`);
      if (names.length === 0) {
        this.failedAt = null;
        this.known = { at: this.now(), totalBytes: 0, entries: [] };
        return;
      }
      // A plain PATH: the daemon's own environment is not a command's to inherit, and `du` is where a system keeps it.
      const done = await this.run(["du", "-sk", "--", ...names], { cwd: this.root, timeoutMs: TIMEOUT_MS, maxOutputBytes: 1024 * 1024, env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" } });
      // `du` ends with an error where one folder could not be read, having counted the rest: its lines are what counts.
      const read = done.timedOut ? null : folderSizesOf(done.stdout);
      this.failedAt = read === null ? this.now() : null;
      if (read) this.known = { at: this.now(), ...read };
    } catch (err) {
      this.failedAt = this.now();
      throw err;
    } finally {
      this.measuring = false;
    }
  }
}
