/**
 * File I/O adapter. Wraps `Bun.file` / `Bun.write` and `node:fs` so no business
 * logic touches either directly (TD-001).
 */

import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { escapes } from "./path.ts";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  /** Permission bits only (`0o640`), for a check that a secret is not readable by more than it should be. */
  mode: number;
}

export async function readTextFile(path: string): Promise<string> {
  return await Bun.file(path).text();
}

/** `null` rather than a throw — a missing optional persona file is not an error. */
export async function readTextFileIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}

/**
 * A text file read only where it is a regular file of at most `maxBytes` — never through a link, never a device or a
 * pipe — or null where there is none. For a file in a folder another user writes, read with the daemon's rights: one
 * read through a link there read whatever the link named, the daemon's own files too, and a link to an endless device
 * read without end (0.8.1). Opened without following a link and checked on what was opened, so nothing can be swapped
 * in between.
 */
export function readPlainTextFile(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error(`${path} is a link, not a file of its own, so it is not read`);
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a plain file, so it is not read`);
    if (stat.size > maxBytes) throw new Error(`${path} is ${stat.size} bytes, more than the ${maxBytes} it may be`);
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const got = readSync(fd, bytes, read, bytes.length - read, read);
      if (got === 0) break;
      read += got;
    }
    return bytes.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The first `n` bytes, without reading the rest.
 *
 * Exists for one caller — `read` sniffing whether a file is a document rather than text — and not
 * reading the rest is the whole point: pulling 25 MB of PDF into memory to look at four
 * magic bytes is the kind of cost that is invisible until somebody attaches a scan.
 */
export async function readHeadBytes(path: string, n: number): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).slice(0, n).arrayBuffer());
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  ensureDir(dirname(path));
  await Bun.write(path, content);
}

/**
 * Write via temp file + rename, which is atomic within a filesystem.
 *
 * Used for anything a reader could catch mid-write: MEMORY.md while an agent is
 * reasoning over it, credentials, config. A half-written MEMORY.md is a corrupted
 * identity, and the failure surfaces later as strange behaviour rather than an
 * I/O error.
 *
 * `mode`: the file is *created* with it. The secret store was written with the umask's mode and
 * chmodded after the rename — readable by any local user for that moment, and for good when a crash
 * fell between the two. `Bun.write` takes no mode, so this one is written with `node:fs`.
 *
 * Without `mode`, a file this replaces keeps the permissions it had. The temp file the rename puts in its place was
 * the umask's, so every save of a `config.toml` at 0640 — the boot bringing it forward included — left it 0644,
 * readable by every local user.
 *
 * Atomic is not durable: the temp file is synced before the rename and the folder after it (`syncFile`, `syncFolder`),
 * so a power cut leaves the old file or the new one, and never an empty one under the name.
 */
export async function writeTextFileAtomic(path: string, content: string, options: { mode?: number } = {}): Promise<void> {
  ensureDir(dirname(path));
  const tmp = tempPathFor(path);
  const mode = options.mode ?? fileMode(path);
  try {
    if (mode === null) {
      await Bun.write(tmp, content);
    } else {
      // `wx`: created by this write, with this mode — never an older file of that name, keeping the mode it had.
      writeFileSync(tmp, content, { mode, flag: "wx" });
      // Exactly these bits: the create above is narrowed by the umask, and a kept 0664 would come back 0644.
      setFileMode(tmp, mode);
    }
    syncFile(tmp);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncFolder(dirname(path));
}

/**
 * A file's bytes on the disk, before a rename puts it under its name. Without this the rename can reach the disk before
 * the data it points at, and after a power cut the name holds zero bytes: a `secrets.json` that empty read as no
 * secrets at all. A failure is an error, as the write's own would be.
 */
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * A rename on the disk. It lives in the folder, and until the folder is synced a power cut can still undo it. Not
 * every filesystem lets a folder be synced, and that is not an error: the rename is still atomic there, and when it
 * reaches the disk is left to the kernel's next writeback.
 */
function syncFolder(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // See above: a folder that cannot be synced leaves the write as atomic as it was.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * A temp file no other write shares. It was `<path>.<pid>.tmp`: two writes of one path in one process wrote the same
 * temp file, the first rename took it, and the second failed on a file that was gone — a save that answered 500 while
 * the file held the other one's text. Random rather than counted, so a run that crashed under the same pid left
 * nothing a later write could open again.
 */
function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${randomUUID().slice(0, 12)}.tmp`;
}

/**
 * Atomic write for bytes — inbound attachments, and the encrypted secret store (with `mode`).
 *
 * Same temp-then-rename as the text version, and for the same reason: an agent that reads a
 * half-downloaded file gets a corrupt PDF and no indication why. Separate function rather than a
 * union parameter so the text path keeps its string type.
 */
export async function writeFileAtomic(path: string, bytes: Uint8Array, options: { mode?: number } = {}): Promise<void> {
  ensureDir(dirname(path));
  const tmp = tempPathFor(path);
  try {
    if (options.mode === undefined) {
      await Bun.write(tmp, bytes);
    } else {
      // Created with its mode, as `writeTextFileAtomic` does: the encrypted secret store is never readable wider for a
      // moment between a write and a chmod.
      writeFileSync(tmp, bytes, { mode: options.mode, flag: "wx" });
      setFileMode(tmp, options.mode);
    }
    syncFile(tmp);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncFolder(dirname(path));
}

/**
 * Free bytes on the filesystem holding `path`, or `null` when it cannot be determined.
 *
 * `statfs` rather than shelling out to `df`: parsing another program's table is a portability problem
 * in itself, and this must work on a host where `exec` is locked down.
 *
 * `null` rather than 0 on failure. Zero would read as "the disk is full" and trip every warning at
 * boot on a filesystem that simply does not report this.
 */
export function freeDiskBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/**
 * A window of a file, as a body a `Response` reads lazily.
 *
 * Exists so an HTTP range request can be answered without pulling the whole file into memory first.
 * That is not a micro-optimisation for video: reading a 300 MB recording whole is 300 MB of RSS on a
 * box that runs with `--smol` and has 512 MB of it, and the request that does it is one a browser
 * makes *on its own* while somebody drags a scrub bar.
 *
 * **Returns the sliced file, never `.stream()` of it** — and the reason has an expiry date on it, so
 * here is the whole story. On Bun 1.4.0 `Bun.file(p).slice(a, b).stream()` silently ignored the slice
 * and streamed the entire file: measured, not assumed, a 100-byte slice came back as all 1000. Bun
 * 1.4.2 fixes it; both forms now return 100.
 *
 * This still does not call `.stream()`, because the fix changes nothing about which form is better.
 * Handing a `Response` the slice directly works on both versions, is one call rather than two, and
 * cannot regress the same way. Reintroducing `.stream()` would buy nothing and would silently lower
 * the floor on the Bun version this package runs against.
 *
 * The failure it caused is worth keeping in view, because it is nearly invisible: every range request
 * answered with the whole file, under a `Content-Range` header claiming otherwise, which is a video
 * that plays and will not seek.
 *
 * `end` is exclusive, matching `Blob.slice` and `Array.slice`. HTTP's `Range` is inclusive at both
 * ends, so the caller converts — stated here because getting it wrong costs exactly one byte.
 */
export function readFileRange(path: string, start: number, end: number): Blob {
  return Bun.file(path).slice(start, end);
}

/** The whole file, as a body a `Response` reads lazily. Same reason as `readFileRange`. */
export function readFileBody(path: string): Blob {
  return Bun.file(path);
}

export async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/**
 * Whether `path` is a directory.
 *
 * Separate from `fileExists` because that one answers `false` for a directory — `Bun.file()` models a
 * file, and asking it about a folder is not a question it has. A caller looking for a directory and
 * reaching for the obvious helper gets a confident "no" for something that is right there.
 */
export function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `mode` applies to what is created, as it is created — `0o700` for a directory of credentials. */
export function ensureDir(path: string, mode?: number): void {
  mkdirSync(path, { recursive: true, ...(mode !== undefined ? { mode } : {}) });
}

/**
 * Read a file as text, synchronously.
 *
 * The async form is the default everywhere else. This exists for the places already holding a synchronous
 * decision — building an approval summary inside the tool gate, where returning a promise would mean
 * making the gate async for a cosmetic field.
 */
export function readTextFileSync(path: string): string {
  return readFileSync(path, "utf-8");
}

/**
 * Copy one file whole — through a temp name, so a copy cut short is never left under its own — keeping the
 * modification time the source had *before* the copy began.
 *
 * For snapshots, which compare the next one against this copy by size and time instead of reading both
 * (`rsync`'s quick check). Read before, not after: a source replaced mid-copy then leaves a copy whose time is older
 * than the source's, which the next snapshot copies again, rather than new bytes under an old time it would link.
 */
export function copyFileAtomic(from: string, to: string): void {
  const before = statSync(from);
  ensureDir(dirname(to));
  const tmp = tempPathFor(to);
  try {
    copyFileSync(from, tmp);
    utimesSync(tmp, before.atimeMs / 1000, before.mtimeMs / 1000);
    syncFile(tmp);
    renameSync(tmp, to);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncFolder(dirname(to));
}

/**
 * Empty a file in place, keeping its inode — for a log another process holds open for appending, which a rename would
 * leave writing into the renamed file.
 */
export function truncateFile(path: string): void {
  truncateSync(path, 0);
}

/**
 * Move a file, atomically within one filesystem.
 *
 * Exported for the database restore, which moves the live file aside before putting a snapshot in
 * its place — a copy-then-delete there would leave a window in which neither file is the database.
 * Throws across filesystems (`EXDEV`), which is the honest failure: the caller wanted an atomic
 * move and did not get one.
 */
export function renamePath(from: string, to: string): void {
  renameSync(from, to);
}

/**
 * A second name for an existing file — a hard link, so both names share one copy on disk.
 *
 * For snapshots that keep unchanged files once (`rsync --link-dest`). `false` rather than a throw
 * when the filesystem refuses (FAT, a link across devices): the caller copies instead.
 */
export function linkFile(existing: string, path: string): boolean {
  try {
    ensureDir(dirname(path));
    linkSync(existing, path);
    return true;
  } catch {
    return false;
  }
}

export function statFile(path: string): FileStat | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), mode: s.mode & 0o7777 };
  } catch {
    return null;
  }
}

/**
 * Can this process write into `path`?
 *
 * `statFile` answers whether a directory exists, which is a different question and the one that
 * misleads: a memory directory owned by another service user stats perfectly and rejects every write.
 * Checked with `W_OK` rather than by reading the mode, because the answer depends on the effective
 * uid, supplementary groups and any mount flags — none of which a permission bit reveals on its own.
 */
export function isWritableDir(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return false;
    // W_OK | X_OK: writing a file needs the directory searchable as well as writable.
    accessSync(path, 3);
    return true;
  } catch {
    return false;
  }
}

/** Whether `path` is a directory this process can list and open things in, by the effective uid as {@link isWritableDir}. */
export function isReadableDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    // R_OK | X_OK: listing it needs read, opening what is in it needs search.
    accessSync(path, 5);
    return true;
  } catch {
    return false;
  }
}

/**
 * Can this process read and write `path` — a socket, a device? By the effective uid, groups and mounts, as
 * {@link isWritableDir} is, because a mode bit cannot say what a service's sandbox lets it reach.
 */
export function canReadWrite(path: string): boolean {
  try {
    // R_OK | W_OK.
    accessSync(path, 6);
    return true;
  } catch {
    return false;
  }
}

/**
 * A folder's entries. `isFile` is a regular file's: a link, a socket or a pipe is neither it nor a directory, as the
 * entry itself says, not what a link points to.
 */
export function listDir(path: string): { name: string; isDirectory: boolean; isFile: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch {
    return [];
  }
}

/** The uid that owns `path` (following links), or null when it cannot be read. */
export function fileOwner(path: string): number | null {
  try {
    return statSync(path).uid;
  } catch {
    return null;
  }
}

/** Where a symlink points, as it was written, or null when `path` is not one. */
export function linkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Set a file's modification time (milliseconds since the epoch): a backup's age is read from it (`commons/backups.ts`). */
export function setModifiedTime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

/** A file's permission bits (`0o640`), or null when there is no file there. */
export function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return null;
  }
}

/**
 * Set POSIX permissions, e.g. `0o600` for a credential file.
 *
 * Silently does nothing where the filesystem has no concept of them (a Windows host, some
 * bind mounts) — a secret store that refuses to start because it could not tighten a mode
 * it never had is worse than one that works with a warning from the caller.
 */
export function setFileMode(path: string, mode: number): boolean {
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `pid` a process we would collide with?
 *
 * `EPERM` counts as alive: it means the process exists but belongs to another user, which is
 * still a reason not to start. Treating it as dead — as an ESRCH-only check does — would remove
 * a live daemon's lock and give two processes the same data directory.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Narrowed rather than `any`: an errno is the one field wanted, and a thrown non-Error (a string
    // from a native binding, say) must read as "not EPERM" rather than throwing inside the check.
    return errnoOf(err) === "EPERM";
  }
}

/**
 * Resolve `candidate` inside `base`, or throw.
 *
 * The tool sandbox confines every path argument through here (§7.1 SPEC). Note it checks the
 * *real* path: `../` sequences, absolute paths, and symlinks are all resolved via `realpathSync`
 * before comparison, so the check cannot be walked around by spelling the path differently or
 * by creating a symlink that points outside the workspace.
 */
export function resolveWithin(base: string, candidate: string): string {
  const baseResolved = resolve(base);
  const baseAbs = safeRealpath(baseResolved);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(join(baseAbs, candidate));

  // The target may not exist yet (write/create operations). Walk up to the nearest existing
  // ancestor and resolve symlinks there — a symlink in a parent directory is just as dangerous
  // as one on the leaf.
  const real = safeRealpath(target);

  const rel = relative(baseAbs, real);
  if (escapes(rel)) {
    throw new Error(`path escapes workspace: ${candidate}`);
  }
  return real;
}

/**
 * The real path of an executable or file, symlinks followed.
 *
 * Exported for one caller with one need: the CLI is installed as a symlink on `PATH`
 * (`/usr/local/bin/nouride -> /srv/nouride/nouride`), and finding the install it belongs to means
 * resolving that symlink first. `dirname(process.execPath)` on the unresolved path answers
 * `/usr/local/bin`, where no install lives.
 *
 * Falls back to the input rather than throwing: a path that cannot be resolved is a path that will
 * fail its next `statFile` anyway, and the caller is already written to treat that as "not here".
 */
export function realPath(target: string): string {
  return safeRealpath(target);
}

/**
 * The real path of something that exists, symlinks followed — or null when it does not, or cannot be read. No fallback:
 * a caller deciding whether a path is safe to delete must not be handed a lexical guess where a symlink could be.
 *
 * The system's `realpath(3)`, not the JavaScript one: that collapses `..` as text before it follows a link, and the
 * kernel does the opposite — `link/..`, with `link` pointing out, is the parent of where it points. A command that
 * names such a path is run as written, so its target is what the kernel reads.
 */
export function realPathStrict(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * Resolve symlinks when the path (or an ancestor) exists, otherwise fall back to lexical
 * `resolve()`. Walking up to the nearest existing ancestor catches symlinks in parent
 * directories even when the leaf doesn't exist yet (write/create operations).
 */
function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    // Walk up to the nearest existing ancestor.
    let dir = dirname(target);
    while (dir !== dirname(dir)) {
      try {
        return join(realpathSync(dir), relative(dir, target));
      } catch {
        dir = dirname(dir);
      }
    }
    // Nothing on the path exists at all — fall back to lexical resolution.
    return target;
  }
}

/**
 * sha256 of a file's contents, or `null` when it cannot be read.
 *
 * Used to bind a durable exec grant to the *contents* of a script it will run: `bash deploy.sh`
 * approved once must not stay approved after `deploy.sh` is rewritten, or "allow always" becomes
 * a permanent grant for arbitrary code.
 *
 * `null` rather than a throw for an unreadable file, and the caller treats that as "no digest" —
 * which produces a *different* grant key than any digest would, so an unreadable file fails
 * toward asking again rather than toward matching an existing grant.
 */
export function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Files matching a glob, relative to `cwd`.
 *
 * `Bun.Glob` rather than a hand-rolled walk: it is the runtime's own matcher, so the pattern syntax an
 * agent writes is the one it read about, and this file is where a Bun API belongs (TD-001).
 *
 * `limit` is a hard stop, not a suggestion. A pattern like `**\/*` in a home directory returns
 * hundreds of thousands of paths, and the caller is putting the result into a prompt — an unbounded
 * result would blow the context window before anyone noticed the pattern was too broad.
 */
export async function globFiles(
  pattern: string,
  cwd: string,
  limit: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const glob = new Bun.Glob(pattern);
  const paths: string[] = [];
  let truncated = false;

  try {
    for await (const match of glob.scan({ cwd, onlyFiles: true, followSymlinks: false, dot: false })) {
      if (paths.length >= limit) {
        truncated = true;
        break;
      }
      paths.push(match);
    }
  } catch {
    // A directory that is not there has no matches — that is the answer, not a failure.
    //
    // Found live: the per-conversation attachment root is a workspace root from the first turn, but
    // nothing creates the directory until a file is actually stored. `Bun.Glob.scan` threw ENOENT on
    // it, both search tools died, and the agent told the user to run `grep` themselves. Also covers a
    // root deleted while a turn is running.
    return { paths, truncated };
  }

  return { paths, truncated };
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Belongs in the runtime adapter because "where is home" is a platform question. Applied wherever a
 * path enters from config, because a tilde is what people type and it is not an absolute path — so
 * `resolve(cwd, "~/project")` produces `<cwd>/~/project`, a directory that does not exist.
 *
 * Observed exactly that way: an agent with `roots = ["~/nouride-test/project"]` reported a file it had
 * been pointed at as missing, while `ls` in that directory showed it. The sandbox was correct; the root
 * it was comparing against was a literal `~`.
 *
 * Only a *leading* `~/` or a bare `~`. A tilde elsewhere in a path is a legal filename character, and
 * `~user` (another account's home) is deliberately not supported — resolving it needs the password
 * database and nobody writes it in a config file.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Does this path exist, synchronously.
 *
 * The async `fileExists` is what almost everything should use. This one is for the CLI's `stop`
 * path, which reads a lock file and signals a pid before anything async is worth starting.
 */
export function fileExistsSync(path: string): boolean {
  return statFile(path) !== null;
}

/**
 * Write bytes without awaiting — for a caller already inside a synchronous send path.
 *
 * `mode` is set as the file is created, never after: a credential written then `chmod`ed is readable
 * by anyone for the moment between the two.
 */
export function writeBytesSync(path: string, bytes: Uint8Array, mode?: number): void {
  writeFileSync(path, bytes, mode !== undefined ? { mode } : undefined);
}

/** Read a whole file as bytes, synchronously. */
export function readBytesSync(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** The system temp directory. */
export { tmpdir as tempDir } from "node:os";

/**
 * The `code` off a thrown filesystem error, when there is one.
 *
 * Node puts an errno string on its errors and nothing types it, so the two call sites above used
 * `catch (err: any)` and reached straight for `.code`. This is the same reach with the lie removed:
 * anything without a string `code` — a thrown string, a rejected non-Error — answers `undefined`,
 * which is what both callers already treated it as.
 */
function errnoOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
