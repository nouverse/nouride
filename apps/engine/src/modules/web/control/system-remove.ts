/**
 * Deleting from System's Files: what the question before it says, what stops it, and who does it.
 *
 * What may be deleted at all is `system-files.ts`'s (`findRemovable`). Three things are decided here:
 *
 * - **What it would take** (`weigh`): how many files and how much of the disk, so the question names them. Counted
 *   to a ceiling in the daemon and sized by `du` in a process of its own: a workspace holds a project's dependencies,
 *   and walking a hundred thousand files here would hold every conversation still.
 * - **Whether something is working there** (`usedBy`): a running mission's folder, a running job's folder and its
 *   log. Deleting those takes the ground from under work in progress, so it waits until that has ended.
 * - **Who deletes** (`remove`). Where each agent is its own user, what its commands made is that user's, in folders
 *   the daemon's user often cannot change: an agent's own folder is emptied as that agent, the shared one as each
 *   agent in turn until nothing is left, and only then by the daemon itself. Everything else here is the daemon's.
 */

import type { SystemFileWeight } from "@nouride/wire";
import { agentCommandsHaveOwnUsers, dirname, join, linkTarget, listDir, realPathStrict, removeAsAgent, removePath, runCommand, statFile } from "@nouride/runtime";
import { removableAt, type Entry } from "./system-files.ts";

type Found = Extract<Entry, { ok: true }>;

/** Files are counted up to this many entries looked at; past it the question says "more than". */
const COUNT_MAX = 20_000;
/** A size that takes longer than this to measure is left out of the question, which is asked without it. */
const SIZE_TIMEOUT_MS = 20_000;

/** The files under `real`, a link counted as one and never followed, until `max` entries have been looked at. */
export function countFiles(real: string, max = COUNT_MAX): { files: number; more: boolean } {
  let files = 0;
  let seen = 0;
  const folders = [real];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const entry of listDir(folder)) {
      seen += 1;
      if (seen > max) return { files, more: true };
      if (entry.isDirectory) folders.push(join(folder, entry.name));
      else files += 1;
    }
  }
  return { files, more: false };
}

type Run = (cmd: string[], opts: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: Record<string, string> }) => Promise<{ stdout: string; timedOut: boolean }>;

/** What deleting `found` would take. A file is itself; a link is said as one, since what it leads to stays. */
export async function weigh(found: Found, run: Run = runCommand, max = COUNT_MAX): Promise<SystemFileWeight> {
  if (found.link) return { entry: found.entry, files: 1, more: false, bytes: null, link: true };
  if (found.entry.kind === "file") return { entry: found.entry, files: 1, more: false, bytes: found.entry.sizeBytes };
  const counted = countFiles(found.real, max);
  // `du` ends with an error where part of the folder is not the daemon's to read, having counted the rest: its line
  // is what counts. A plain PATH: the daemon's own environment is not a command's to inherit.
  const sized = await run(["du", "-sk", "--", found.real], { cwd: dirname(found.real), timeoutMs: SIZE_TIMEOUT_MS, maxOutputBytes: 64 * 1024, env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" } }).catch(() => null);
  const kilobytes = sized && !sized.timedOut ? /^(\d+)\t/m.exec(sized.stdout)?.[1] : undefined;
  return { entry: found.entry, ...counted, bytes: kilobytes === undefined ? null : Number(kilobytes) * 1024 };
}

/** What is running now and where: each mission's folder, each job's folder and its log, as the daemon wrote them. */
export interface Working {
  missions: () => { workdir?: string | null }[];
  jobs: () => { cwd: string; logPath: string }[];
}

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);

/**
 * Whether a running mission or job is working where `found` is. It is, when the folder it works in is what would be
 * deleted or is inside it, and when what would be deleted is inside that folder: a file of a mission in progress is
 * the mission's. Not the last where the folder is one Nouride lays out itself (an agent's whole workspace, which a
 * command runs in by default): a job there would hold every file that agent ever made.
 */
export function usedBy(found: Found, root: string, working: Working): "mission" | "job" | null {
  const base = realPathStrict(root);
  if (!base) return null;
  const uses = (where: string | null | undefined, whole: boolean): boolean => {
    if (!where) return false;
    const real = realPathStrict(where) ?? where;
    if (within(real, found.real)) return true;
    return whole && within(found.real, real) && real.startsWith(`${base}/`) && removableAt(real.slice(base.length + 1), "folder");
  };
  if (working.missions().some((mission) => uses(mission.workdir, true))) return "mission";
  if (working.jobs().some((job) => uses(job.cwd, true) || uses(job.logPath, false))) return "job";
  return null;
}

const gone = (real: string) => linkTarget(real) === null && statFile(real) === null;

/**
 * `found`, deleted; whether it is gone. `agents` are the ids of the agents there are.
 *
 * The daemon deletes last in a folder agents write to, and only where that folder is still the one that was looked
 * at: a path it follows as its own user is one an agent's command could have turned into a link meanwhile, to
 * something only the daemon may delete.
 */
export async function remove(found: Found, agents: readonly string[]): Promise<boolean> {
  const parts = found.led.split("/");
  if (agentCommandsHaveOwnUsers() && parts[0] === "workspace" && (parts[1] === "private" || parts[1] === "shared")) {
    for (const agent of parts[1] === "private" ? agents.filter((id) => id === parts[2]) : agents) {
      await removeAsAgent(agent, found.real).catch(() => undefined);
      if (gone(found.real)) return true;
    }
    if (realPathStrict(dirname(found.real)) !== dirname(found.real)) return false;
  }
  try {
    removePath(found.real);
  } catch {
    // Part of it is another user's: what is left says so.
  }
  return gone(found.real);
}
