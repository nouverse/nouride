/**
 * The swap, against a real filesystem and a real tarball.
 *
 * Mocked at the network and nowhere else. The parts that go wrong here are filesystem parts —
 * a half-swapped install, a truncated download that still untars, a rename over a file
 * something is still executing — and none of them are reachable with a fake `fs`.
 *
 * The tarball arrives on disk rather than over the wire, because downloading is a separate step
 * now: it is pausable and this is not. What is mocked is only the checksum fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStaged, checksumFor } from "../src/install.ts";
import { eventually, sleep } from "./wait.ts";

let root: string;
let installDir: string;
let releaseDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-update-"));
  installDir = join(root, "install");
  releaseDir = join(root, "release");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(join(releaseDir, "dashboard"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An install as it is on disk: a binary, a dashboard directory, a skills directory. */
function existingInstall(marker: string): void {
  writeFileSync(join(installDir, "nouride"), `#!/bin/sh\necho ${marker}\n`);
  chmodSync(join(installDir, "nouride"), 0o755);
  mkdirSync(join(installDir, "dashboard"), { recursive: true });
  writeFileSync(join(installDir, "dashboard", "index.html"), marker);
  mkdirSync(join(installDir, "skills"), { recursive: true });
  writeFileSync(join(installDir, "skills", "a.md"), marker);
}

/** A release tarball with the shape `build:binary` produces. Returns its bytes and hash. */
function buildTarball(marker: string): { path: string; sha256: string } {
  writeFileSync(join(releaseDir, "nouride"), `#!/bin/sh\necho ${marker}\n`);
  chmodSync(join(releaseDir, "nouride"), 0o755);
  writeFileSync(join(releaseDir, "dashboard", "index.html"), marker);
  const path = join(root, "release.tar.gz");
  const result = spawnSync("tar", ["-czf", path, "-C", releaseDir, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr?.toString()}`);
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

/** A `fetch` that serves only the checksum file. The tarball is already on disk. */
function serve(_tarball: string, checksums: string): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes("SHA256SUMS")) return { ok: true, status: 200, text: async () => checksums };
    return { ok: false, status: 404 };
  }) as unknown as typeof fetch;
}

/**
 * What the engine hands in as the names to swap — its `SWAPPED`. Written out rather than imported: a package's test does
 * not reach into the engine, and the point here is that the plugin swaps what it is told.
 */
const SWAP = ["nouride", "dashboard", "skills", "frontend", "config.example.toml"];

const URLS = {
  checksumUrl: "https://example.invalid/v9.9.9/SHA256SUMS",
  artifact: "nouride-linux-x64",
  swap: SWAP,
  // The machine the artefact is for, whichever one runs the suite: the platform guard is `platform-guard.test.ts`'s.
  host: { platform: "linux", arch: "x64" },
};

describe("the checksum file parser", () => {
  test("matches the `<hash>  ./<name>` shape the release publishes", () => {
    /**
     * The leading `./` is what `sha256sum` writes and what is in the published file.
     * Matching the name by equality found nothing, and the failure looked like a missing
     * checksum rather than a parser that did not know the format.
     */
    const text = [
      "437c35fd  ./nouride-linux-arm64.tar.gz",
      "eabc37d6  ./nouride-linux-x64.tar.gz",
    ].join("\n");
    expect(checksumFor(text, "nouride-linux-x64")).toBe("eabc37d6");
  });

  test("a missing artifact is an error, not an empty string", () => {
    expect(() => checksumFor("abc  ./nouride-linux-arm64.tar.gz", "nouride-linux-x64")).toThrow(
      /no checksum for nouride-linux-x64/,
    );
  });
});

describe("applying an update", () => {
  test("replaces the binary and the dashboard, and keeps the old ones", async () => {
    existingInstall("OLD");
    const { path, sha256 } = buildTarball("NEW");
    const report = await installStaged({
      installDir,
      tarball: path,
      ...URLS,
      fetchImpl: serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`),
    });

    expect(report.replaced.sort()).toEqual(["dashboard", "nouride"]);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("NEW");
    expect(readFileSync(join(installDir, "dashboard", "index.html"), "utf8")).toBe("NEW");

    // The previous version is still there, which is the only way back from a release
    // that boots into a daemon refusing its own config.
    expect(readFileSync(join(report.backupDir, "nouride"), "utf8")).toContain("OLD");
  });

  test("a Router release replaces the LLM gateway's dashboard too", async () => {
    // Left out once: every update moved the gateway's code inside the binary and left its dashboard
    // at the flashed version — a new gateway serving an old bundle under the daemon's LLM Gateway page.
    existingInstall("OLD");
    mkdirSync(join(installDir, "frontend"), { recursive: true });
    writeFileSync(join(installDir, "frontend", "index.html"), "OLD");
    mkdirSync(join(releaseDir, "frontend"), { recursive: true });
    writeFileSync(join(releaseDir, "frontend", "index.html"), "NEW");
    const { path, sha256 } = buildTarball("NEW");
    const report = await installStaged({
      installDir,
      tarball: path,
      ...URLS,
      fetchImpl: serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`),
    });

    expect(report.replaced).toContain("frontend");
    expect(readFileSync(join(installDir, "frontend", "index.html"), "utf8")).toBe("NEW");
    expect(readFileSync(join(report.backupDir, "frontend", "index.html"), "utf8")).toBe("OLD");
  });

  test("leaves alone what the tarball does not carry", async () => {
    // `skills/` is in this install and not in this release. Removing it because it was
    // not in the archive would delete a directory the daemon reads at boot.
    existingInstall("OLD");
    const { path, sha256 } = buildTarball("NEW");
    await installStaged({
      installDir,
      tarball: path,
      ...URLS,
      fetchImpl: serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`),
    });
    expect(readFileSync(join(installDir, "skills", "a.md"), "utf8")).toBe("OLD");
  });

  test("swaps the names it is handed and nothing else the tarball carries", async () => {
    // `pkg/` is in every release tarball and is installed by install.sh, as root, outside the install directory: an
    // update moving a copy in beside the binary would put the root helper where the service account can edit it.
    // `config.example.toml` stayed at the version first installed while every refusal pointed at it.
    existingInstall("OLD");
    writeFileSync(join(installDir, "config.example.toml"), "OLD");
    writeFileSync(join(releaseDir, "config.example.toml"), "NEW");
    mkdirSync(join(releaseDir, "pkg"), { recursive: true });
    writeFileSync(join(releaseDir, "pkg", "nouride-pkg"), "NEW");
    const { path, sha256 } = buildTarball("NEW");
    const report = await installStaged({ installDir, tarball: path, ...URLS, fetchImpl: serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`) });

    expect(report.replaced.sort()).toEqual(["config.example.toml", "dashboard", "nouride"]);
    expect(readFileSync(join(installDir, "config.example.toml"), "utf8")).toBe("NEW");
    expect(readFileSync(join(report.backupDir, "config.example.toml"), "utf8")).toBe("OLD");
    expect(existsSync(join(installDir, "pkg"))).toBe(false);
  });

  test("a name that is not an entry of the install directory is refused before anything moves", async () => {
    existingInstall("OLD");
    const { path, sha256 } = buildTarball("NEW");
    const fetchImpl = serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`);
    await expect(installStaged({ installDir, tarball: path, ...URLS, swap: ["nouride", "../escape"], fetchImpl })).rejects.toThrow(
      /"\.\.\/escape" is not an entry of the install directory/,
    );
    await expect(installStaged({ installDir, tarball: path, ...URLS, swap: ["dashboard"], fetchImpl })).rejects.toThrow(/do not include `nouride`/);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("OLD");
    expect(existsSync(join(installDir, ".nouride-previous"))).toBe(false);
  });

  /**
   * What `nouride update` hit inside the daemon's unit on Ubuntu (2026-10-06): newer GNU tar creates
   * files with `openat2()`, systemd answers it with ENOSYS under `RestrictSUIDSGID=true`, and every
   * file below the top level failed. A `tar` on `PATH` that fails the same way stands in for it.
   */
  test("a system tar refused with ENOSYS falls back to the built-in reader", async () => {
    existingInstall("OLD");
    const { path, sha256 } = buildTarball("NEW");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "tar"),
      "#!/bin/sh\necho 'tar: dashboard/index.html: Cannot open: Function not implemented' >&2\nexit 2\n",
    );
    chmodSync(join(bin, "tar"), 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${bin}:${original}`;
    try {
      const report = await installStaged({ installDir, tarball: path, ...URLS, fetchImpl: serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`) });
      expect(report.replaced.sort()).toEqual(["dashboard", "nouride"]);
    } finally {
      process.env.PATH = original;
    }
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("NEW");
    expect(readFileSync(join(installDir, "dashboard", "index.html"), "utf8")).toBe("NEW");
  });

  test("when the built-in reader fails too, both reasons are reported", async () => {
    const path = join(root, "broken.tar.gz");
    writeFileSync(path, "not a tarball");
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    await expect(
      installStaged({ installDir, tarball: path, ...URLS, fetchImpl: serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`) }),
    ).rejects.toThrow(/tar (exited|could not run).*built-in reader failed too/s);
  });

  test("a checksum mismatch refuses before anything is moved", async () => {
    /**
     * The ordering is the property. A truncated download still untars, and a binary that
     * does not run is only discovered after the old one is gone.
     */
    existingInstall("OLD");
    const { path } = buildTarball("NEW");
    const wrong = "0".repeat(64);

    await expect(
      installStaged({ installDir, tarball: path, ...URLS, fetchImpl: serve(path, `${wrong}  ./${URLS.artifact}.tar.gz`) }),
    ).rejects.toThrow(/checksum mismatch/);

    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("OLD");
    expect(existsSync(join(installDir, ".nouride-previous", "nouride"))).toBe(false);
  });

  test("a tarball with no executable in it is refused", async () => {
    existingInstall("OLD");
    rmSync(join(releaseDir, "nouride"), { force: true });
    const path = join(root, "empty.tar.gz");
    spawnSync("tar", ["-czf", path, "-C", releaseDir, "."]);
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");

    await expect(
      installStaged({ installDir, tarball: path, ...URLS, fetchImpl: serve(path, `${sha256}  ./${URLS.artifact}.tar.gz`) }),
    ).rejects.toThrow(/no `nouride` executable/);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("OLD");
  });

  test("checksums that cannot be fetched are a refusal, not a silent pass", async () => {
    // The verify step failing open would make every other guard here decoration.
    existingInstall("OLD");
    const { path } = buildTarball("NEW");
    const dead = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(installStaged({ installDir, tarball: path, ...URLS, fetchImpl: dead })).rejects.toThrow(/500/);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("OLD");
  });

  test("the unpack directory does not survive a failure", async () => {
    existingInstall("OLD");
    const { path } = buildTarball("NEW");
    const dead = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(installStaged({ installDir, tarball: path, ...URLS, fetchImpl: dead })).rejects.toThrow();
    expect(
      spawnSync("sh", ["-c", `ls -d ${installDir}/.nouride-unpack-* 2>/dev/null | wc -l`]).stdout.toString().trim(),
    ).toBe("0");
  });
});

describe("the assumption the whole design rests on", () => {
  test("a rename over a running executable does not disturb the running process", async () => {
    /**
     * This is why the swap is renames rather than copies. A copy opens the destination
     * for writing and Linux answers `ETXTBSY` for a file that is being executed; a
     * rename only unlinks a directory entry, and the running process keeps the inode it
     * already opened.
     *
     * Asserted rather than assumed because the entire update path is built on it, and it
     * is the kind of thing that is true until the platform it is true on changes.
     */
    const script = join(root, "long-runner");
    const running = join(root, "running");
    writeFileSync(script, `#!/bin/sh\necho up > "${running}"\nsleep 5\n`);
    chmodSync(script, 0o755);

    const child = spawn(script, [], { stdio: "ignore" });
    // Running the original, not merely spawned: on a loaded machine the exec can land after the rename below, and
    // then the child runs the replacement and exits — the property under test never came up. The script says so.
    await eventually(() => existsSync(running), 4_000, "the original script to start");
    expect(child.exitCode).toBeNull(); // still running

    const replacement = join(root, "replacement");
    writeFileSync(replacement, "#!/bin/sh\nexit 0\n");
    chmodSync(replacement, 0o755);
    const renamed = spawnSync("mv", [replacement, script]);
    expect(renamed.status).toBe(0);

    await sleep(150);
    // The rename did not end it — by exiting or by a signal, which leaves `exitCode` null as well.
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(readFileSync(script, "utf8")).toContain("exit 0"); // and the new file is in place

    child.kill("SIGKILL");
  });
});
