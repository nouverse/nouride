/**
 * The build the unit's guard put aside, back in — `nouride update --retry`.
 *
 * When an update does not come up, the guard puts the previous build back and leaves the new one beside it, each part
 * under its own name with `.failed` after it (`service/update-guard.ts`): the binary, the dashboard, the skills and
 * the rest. Where the new build had migrated the database before it failed, the old one then refuses to start, and
 * said "start the newer build again", which nothing did. Its parts are six names, and the binary moved back by hand
 * ran over the older build's dashboard, which asked to be reloaded for a version those files could never be.
 *
 * So the way forward is one call: every part that was put aside goes back, all of them or none, and the build that ran
 * meanwhile is kept in `.nouride-previous/`, as an install keeps the one it replaces, so `--rollback` still goes back
 * from there. Here and not in the update plugin, as the guard and the rollback are: it has to work in a build that
 * cannot update.
 */

import { ensureDir, join, readTextFileSync, removePath, renamePath, statFile } from "@nouride/runtime";
import { FAILED_SUFFIX, PENDING_FILE, ROLLED_BACK_FILE, SWAPPED } from "@/service/update-guard.ts";
import { keptBuild, recordKeptBuild } from "./rollback.ts";

const PREVIOUS = ".nouride-previous";

export interface PutAside {
  /** The parts that stand beside the install with `.failed` after their name, in the order they are swapped. */
  names: string[];
  /** The version that did not start, where the guard's marker still says: gone once the previous build has run. */
  version: string | null;
  /** The version the guard put back, where the marker says. */
  replaced: string | null;
}

const exists = (path: string) => statFile(path) !== null;

/** What the guard left of the build it took out, or null where it left none. */
export function putAside(installDir: string): PutAside | null {
  const names = SWAPPED.filter((name) => exists(join(installDir, `${name}${FAILED_SUFFIX}`)));
  if (names.length === 0) return null;
  let marker: { from?: unknown; to?: unknown } = {};
  try {
    marker = JSON.parse(readTextFileSync(join(installDir, ROLLED_BACK_FILE))) as typeof marker;
  } catch {
    // No marker, or one cut off as it was written: the parts are there, and which version they are is asked of them.
  }
  const version = (value: unknown) => (typeof value === "string" && /^v?\d+\.\d+\.\d+\S*$/.test(value.trim()) ? value.trim().replace(/^v/, "") : null);
  return { names, version: version(marker.to), replaced: version(marker.from) };
}

/**
 * Why what was put aside is not taken again, or null when it is. Pure.
 *
 * Without its binary it is no build. And a build kept in `.nouride-previous/` means something was installed since the
 * guard put the old one back: what stands with `.failed` is then older than what runs, and taking it would go back
 * over that install while losing the build it kept.
 */
export function retryRefusal(aside: PutAside, somethingKept: boolean): string | null {
  if (!aside.names.includes("nouride")) {
    return `What was put aside has no binary among it (${aside.names.map((name) => `${name}${FAILED_SUFFIX}`).join(", ")}): it is not a build that can be started.`;
  }
  if (somethingKept) {
    return `A build is kept in ${PREVIOUS}, so something was installed after the update that did not start: what was put aside is older than what runs now.`;
  }
  return null;
}

/**
 * Put back every part that was put aside, and keep the part it replaces in `.nouride-previous/`. A failure part-way
 * puts back what it had moved: an install left half on each version is a dashboard that does not match its binary.
 * The guard's marker goes, and what is kept is recorded as any install records it.
 */
export function takeAgain(installDir: string, aside: PutAside, currentVersion: string): string[] {
  const previous = join(installDir, PREVIOUS);
  ensureDir(previous);
  const moved: string[] = [];
  try {
    for (const name of aside.names) {
      const live = join(installDir, name);
      removePath(join(previous, name));
      if (exists(live)) renamePath(live, join(previous, name));
      moved.push(name);
      renamePath(join(installDir, `${name}${FAILED_SUFFIX}`), live);
    }
  } catch (err) {
    for (const name of moved.toReversed()) {
      const live = join(installDir, name);
      try {
        if (exists(live) && !exists(join(installDir, `${name}${FAILED_SUFFIX}`))) renamePath(live, join(installDir, `${name}${FAILED_SUFFIX}`));
        if (exists(join(previous, name))) renamePath(join(previous, name), live);
      } catch {
        // The error being reported is the one that started this.
      }
    }
    throw new Error(`putting the build back failed, and its files were left as they were: ${err instanceof Error ? err.message : String(err)}`);
  }
  recordKeptBuild(previous, { version: currentVersion, by: aside.version });
  removePath(join(installDir, ROLLED_BACK_FILE));
  removePath(join(installDir, PENDING_FILE));
  removePath(join(installDir, `${PENDING_FILE}.attempts`));
  return moved;
}

/** Whether a build is kept in `.nouride-previous/` already: `retryRefusal`'s second answer. */
export function somethingKept(installDir: string): boolean {
  return keptBuild(installDir) !== null;
}
