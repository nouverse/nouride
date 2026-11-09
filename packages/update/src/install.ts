/**
 * Turning a downloaded release into the running one, in a way that survives failing.
 *
 * The download is not here — it is in `download.ts`, because it is pausable and this is not.
 * What is left is the irreversible half, and its three properties, in the order they were
 * learned:
 *
 * 1. **The checksum is verified before anything is moved.** A truncated download that still
 *    untars produces a binary that does not run, and by then the old one is gone.
 * 2. **The swap is renames, not copies.** Every path involved is inside the install directory,
 *    so each rename is atomic on the same filesystem, and a rename *over* a running executable
 *    is allowed — the running process keeps the inode it opened. A copy would hit `ETXTBSY` on
 *    Linux for exactly the file that matters.
 * 3. **The previous version is kept.** Not out of caution about this code: an update that boots
 *    into a daemon which refuses its own config leaves nobody able to ask for anything, and the
 *    only way back is a copy of what was working.
 *
 * Nothing here restarts anything. The swap leaves a daemon running the old inode until
 * something ends the process — deliberately, because the restart has a follow-up turn to
 * schedule first and that ordering belongs to the caller.
 */

import { digestFile, ensureDir, extractTarGz, join, makeTempDir, readHeadBytes, removePath, renamePath, runCommand, runningPlatform, setFileMode, statFile, systemProgram } from "@nouride/runtime";
import type { Edition } from "./edition.ts";
import { requiresSignature, verifyChecksums } from "./signing.ts";
import { meetsFloor, releaseFloor } from "./floor.ts";
import { foreignArtifact, foreignExecutable, type PlatformArch } from "./platform-guard.ts";

export interface InstallInput {
  installDir: string;
  /** The finished tarball on disk, as `download.ts` left it. */
  tarball: string;
  /**
   * The names to swap — the engine's `SWAPPED` (`apps/engine/src/service/update-guard.ts`). Anything else in the
   * tarball stays in the staging tree.
   *
   * Handed in rather than kept here: the unit's guard and `nouride update --rollback` put back exactly these names,
   * and they live in the engine, which cannot import this package. This held a copy of its own, and every copy of the
   * list kept `wa-bridge` long after the last release shipped one.
   */
  swap: readonly string[];
  /** Where the release's own `SHA256SUMS` lives. */
  checksumUrl: string;
  /** The artifact's own name, which is the key in the checksum file. */
  artifact: string;
  /** Where the checksum file's signature is. Required for the releases `requiresSignature` names. */
  signatureUrl?: string;
  /** Which edition is installing, which with `tag` decides whether a signature is required. */
  edition?: Edition;
  /** The release being installed — a public one from `SIGNED_SINCE` on must be signed too. */
  tag?: string;
  /** The version installing it. A release whose floor (`floor.ts`) is above it is refused. */
  from?: string;
  /** Tests only: keys to verify against instead of the compiled-in ones. The engine never sets it. */
  trustedKeys?: readonly string[];
  /**
   * Tests only: the machine to install for instead of the one this runs on (`runningPlatform`). The engine never sets
   * it — what is installed is checked against what the operating system says now, not against anything handed in.
   */
  host?: PlatformArch;
  /** Injected so tests do not reach the network. */
  fetchImpl: typeof fetch;
  /** The pauses before each try again of the checksum file and its signature (`RETRY_WAITS_MS`); a test passes none. */
  retryWaitsMs?: readonly number[];
}

export interface ApplyReport {
  /** Which of the names in `swap` actually moved. */
  replaced: string[];
  /** Where the previous version is, until the next update. */
  backupDir: string;
  bytes: number;
  sha256: string;
}

/**
 * Verify, extract, swap.
 *
 * Throws on every failure with a sentence naming the step, because the caller's job is to put
 * that in front of a person and every one of these has a different remedy.
 */
export async function installStaged(input: InstallInput): Promise<ApplyReport> {
  // Each name is one entry of the install directory, and the swap renames it there: a separator or `..` would reach
  // outside it, and an empty list would report an install that installed nothing. Refused before anything is fetched.
  const outside = input.swap.find((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes(".."));
  if (outside !== undefined) throw new Error(`${JSON.stringify(outside)} is not an entry of the install directory, so it cannot be swapped`);
  if (!input.swap.includes("nouride")) throw new Error("the names to swap do not include `nouride`, so nothing would be installed");

  // A build for another platform or architecture is refused by name before anything is fetched, and by the executable's
  // own header once unpacked (`platform-guard.ts`).
  const host = input.host ?? runningPlatform();
  const foreign = foreignArtifact(input.artifact, host);
  if (foreign) throw new Error(foreign);

  const { bytes, sha256 } = await digestFile(input.tarball);

  const waits = input.retryWaitsMs ?? RETRY_WAITS_MS;
  const checksums = await fetchText(input.checksumUrl, input.fetchImpl, waits);

  // The checksum file is only as good as whoever published it — see `signing.ts`. Checked before
  // it is used for anything, and for a private edition a missing signature is a refusal.
  if (input.signatureUrl) {
    const signature = await fetchText(input.signatureUrl, input.fetchImpl, waits);
    if (!verifyChecksums(checksums, signature, input.trustedKeys)) {
      throw new Error("the release's checksum file is not signed by Nouverse; refusing to install it");
    }
  } else if (input.edition && requiresSignature(input.edition, input.tag)) {
    throw new Error(
      requiresSignature(input.edition)
        ? `the ${input.edition} edition installs only signed releases, and this one came with no signature`
        : `${input.tag} must be signed, and came with no signature; refusing to install it`,
    );
  }

  /**
   * The floor, from the file just verified: the check read it unverified, and an install that went ahead without a
   * fresh check read nothing — so this is where it holds. Refused before a byte of the tarball is unpacked.
   */
  const needs = releaseFloor(checksums);
  if (input.from !== undefined && !meetsFloor(input.from, needs)) {
    const release = (input.tag ?? "this release").replace(/^v/, "");
    throw new Error(`${release} needs ${needs} first, and this install runs ${input.from}: update to ${needs} first, then to ${release}`);
  }

  const expected = checksumFor(checksums, input.artifact);
  if (expected !== sha256) {
    throw new Error(
      `checksum mismatch for ${input.artifact}: the channel says ${expected}, the download is ${sha256}`,
    );
  }

  const tree = makeTempDir(input.installDir, ".nouride-unpack-");
  try {
    await extract(input.tarball, tree);

    const binary = join(tree, "nouride");
    if (!isFile(binary)) throw new Error("the tarball has no `nouride` executable in it");
    const wrongMachine = foreignExecutable(await readHeadBytes(binary, 64), host);
    if (wrongMachine) throw new Error(wrongMachine);
    if (!setFileMode(binary, 0o755)) throw new Error("could not make the new `nouride` executable");

    const { replaced, backupDir } = await swap(input.installDir, tree, input.swap);
    return { replaced, backupDir, bytes, sha256 };
  } finally {
    removePath(tree);
  }
}

/**
 * The pauses before each try again of a release's checksum file or signature: four tries in about twelve seconds. GitHub's
 * release downloads answer a passing 500 or 504 now and then, for minutes and for other projects' releases too, and a
 * single try made an update whose download had finished fail at Install.
 */
const RETRY_WAITS_MS: readonly number[] = [1_000, 3_000, 8_000];

/** An answer worth asking again: the server, or one in front of it, failing for a moment, or asking to slow down. */
function passing(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchText(url: string, fetchImpl: typeof fetch, waits: readonly number[]): Promise<string> {
  for (let tries = 1; ; tries += 1) {
    const last = tries > waits.length;
    let response: Response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      if (last) throw error;
      await pause(waits[tries - 1]!);
      continue;
    }
    if (response.ok) return await response.text();
    if (last || !passing(response.status)) {
      throw new Error(`fetching checksums answered ${response.status} (${url})${tries > 1 ? `, ${tries} tries` : ""}`);
    }
    await pause(waits[tries - 1]!);
  }
}

/**
 * The line for this artifact in the release's `SHA256SUMS`.
 *
 * `sha256sum` writes `<hash>  ./<name>`, and the leading `./` is present in what this
 * project publishes — so the name is matched after stripping it rather than by equality,
 * which was the first version and matched nothing.
 *
 * Takes the text rather than a URL so the parsing is testable without a server, which is
 * where the `./` bug would have been caught.
 */
export function hasChecksumFor(text: string, artifact: string): boolean {
  try {
    return checksumFor(text, artifact).length > 0;
  } catch {
    return false;
  }
}

export function checksumFor(text: string, artifact: string): string {
  const wanted = `${artifact}.tar.gz`;
  for (const line of text.split("\n")) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    if (!hash || rest.length === 0) continue;
    const name = rest.join(" ").replace(/^\.\//, "");
    if (name === wanted) return hash;
  }
  throw new Error(`no checksum for ${wanted} in the release's checksum file`);
}

/**
 * `tar` from the system first, and the runtime's own reader when it fails.
 *
 * The system's because every platform this ships to has one — `install.sh` already depends on it.
 * The fallback because it can fail for a reason that has nothing to do with the tarball: newer GNU
 * tar creates files with `openat2()`, which systemd answers with `ENOSYS` under the unit's
 * `RestrictSUIDSGID=true`, and that tar does not fall back. So from inside the daemon every file
 * below the top level failed with "Function not implemented", while the same tarball unpacked from a
 * shell — which is why a fresh `install.sh` worked where `nouride update` did not. See
 * `@nouride/runtime`'s `tar.ts`.
 *
 * Any failure, not only that one: a box with no `tar` on the service's `PATH` deserves an update
 * too. When both fail, both reasons are reported.
 */
async function extract(tarball: string, into: string): Promise<void> {
  let systemError: string;
  try {
    // Two minutes: a 40 MB tarball on an SD card takes seconds, and one that takes minutes is stuck.
    // The system's `tar`, never one an agent put in `.nouride/bin` — it is about to write the binary.
    const result = await runCommand([systemProgram("tar"), "-xzf", tarball, "-C", into], {
      cwd: into,
      timeoutMs: 120_000,
      maxOutputBytes: 64_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    if (result.exitCode === 0) return;
    const why = result.timedOut ? "timed out" : `exited ${result.exitCode}`;
    systemError = `tar ${why}${result.stderr.trim() ? `: ${firstLines(result.stderr, 3)}` : ""}`;
  } catch (err) {
    systemError = `tar could not run: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    await extractTarGz(tarball, into);
  } catch (err) {
    throw new Error(`${systemError}; the built-in reader failed too: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function firstLines(text: string, count: number): string {
  const lines = text.trim().split("\n");
  return lines.length > count ? `${lines.slice(0, count).join("\n")} (+${lines.length - count} more lines)` : lines.join("\n");
}

/**
 * Move the new files in, keeping the old ones.
 *
 * Rolls back on the first failure. The window where an install is half-swapped is the
 * duration of one `rename`, and it can only be reached by a filesystem error — but a
 * daemon left with a new binary and the old dashboard beside it is a 404 nobody would
 * connect to an update, so it is worth the bookkeeping.
 */
async function swap(
  installDir: string,
  tree: string,
  names: readonly string[],
): Promise<{ replaced: string[]; backupDir: string }> {
  const backupDir = join(installDir, ".nouride-previous");
  removePath(backupDir);
  ensureDir(backupDir);

  const moved: { name: string; hadPrevious: boolean }[] = [];
  try {
    for (const name of names) {
      const staged = join(tree, name);
      if (!exists(staged)) continue;

      const live = join(installDir, name);
      const hadPrevious = exists(live);
      if (hadPrevious) renamePath(live, join(backupDir, name));
      renamePath(staged, live);
      moved.push({ name, hadPrevious });
    }
  } catch (err) {
    for (const { name, hadPrevious } of moved.reverse()) {
      const live = join(installDir, name);
      // Best effort, each on its own: a rollback that stops at the first failure strands the rest.
      try {
        removePath(live);
        if (hadPrevious) renamePath(join(backupDir, name), live);
      } catch {
        // The error being reported is the one that started this.
      }
    }
    throw new Error(`the swap failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { replaced: moved.map((entry) => entry.name), backupDir };
}

function exists(path: string): boolean {
  return statFile(path) !== null;
}

function isFile(path: string): boolean {
  const stat = statFile(path);
  return stat !== null && !stat.isDirectory;
}
