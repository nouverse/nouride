/**
 * How full the machine is now, said on the message a turn answers.
 *
 * A turn is told what else is at work on the box (`pipeline/work-now.ts`) and was never told how full it is: "a build
 * is running", and not that the commands already hold most of the memory they may, nor that the disk is nearly out. So
 * an agent started a second build beside the first and one of them was killed for memory, or wrote a large file to a
 * disk with no room for it, and learned of either only from the failure. The daemon reads both figures already, for
 * its System page.
 *
 * Said only where the machine is short of room, and never otherwise: a line on every message that says all is well
 * is a line nobody reads on the day it changes. It tells and locks nothing, as the line about work does: the agent is
 * the one that waits, or does the light part first.
 *
 * Two figures, each counted only where the machine keeps it. The commands' memory where they have a cap of their own
 * (a systemd unit that hands a cgroup over): elsewhere there is no cap to be near. The disk under the data folder,
 * which is where every agent's work lands.
 */

import { formatBytes } from "@nouride/shared";

/**
 * The commands hold this share of the memory they may, or more: said. A starting value, chosen and not measured: a
 * build or a headless browser takes a gigabyte or more, which on a small box is the fifth left over.
 */
export const COMMANDS_FULL_SHARE = 0.8;

/**
 * The disk is said when less than this share of it is free, and less than `DISK_FREE_BYTES` in all. Both, because
 * either alone misleads: a tenth of a large disk is room for anything an agent does, and a few gigabytes are most of
 * a small one. Starting values, chosen and not measured.
 */
export const DISK_FREE_SHARE = 0.1;
export const DISK_FREE_BYTES = 10 * 1024 ** 3;

/** What the machine says of itself, each figure null where it keeps none. */
export interface BoxFigures {
  /** What the agents' commands hold together and may hold. `maxBytes` null: no cap of their own. */
  commands: { usedBytes: number; maxBytes: number | null } | null;
  /** The disk the data folder is on. */
  disk: { totalBytes: number; freeBytes: number } | null;
}

/** The line, or null where the machine has room, or says nothing of itself. */
export function fullNote(figures: BoxFigures): string | null {
  const short: string[] = [];
  const commands = figures.commands;
  if (commands?.maxBytes && commands.maxBytes > 0 && commands.usedBytes / commands.maxBytes >= COMMANDS_FULL_SHARE) {
    short.push(`the commands running here hold ${formatBytes(commands.usedBytes)} of the ${formatBytes(commands.maxBytes)} of memory they may use together`);
  }
  const disk = figures.disk;
  if (disk && disk.totalBytes > 0 && disk.freeBytes < DISK_FREE_BYTES && disk.freeBytes / disk.totalBytes < DISK_FREE_SHARE) {
    short.push(`${formatBytes(disk.freeBytes)} of disk is free, of ${formatBytes(disk.totalBytes)}`);
  }
  if (short.length === 0) return null;
  return `(This machine is short of room now: ${short.join("; ")}. Something heavy started now may be stopped or fail: wait for work to end, or do the light part first, and say so if the person asked for the heavy part.)`;
}

/** How long a reading is kept (a starting value): the figures move by the minute, and a turn's message is built often. */
const KEPT_MS = 30_000;

/**
 * The line as the pipeline asks for it: read from the machine, and kept for half a minute so a busy chat does not
 * read the disk on every message. A reading that throws is no reading: nothing is said.
 */
export function boxFull(read: () => BoxFigures, now: () => number = Date.now): () => string | null {
  let kept: { at: number; note: string | null } | null = null;
  return () => {
    const at = now();
    if (kept && at - kept.at < KEPT_MS) return kept.note;
    let note: string | null = null;
    try {
      note = fullNote(read());
    } catch {
      note = null;
    }
    kept = { at, note };
    return note;
  };
}
