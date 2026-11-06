/**
 * `nouride update` installs a build for the machine it runs on and nothing else (finding 3 of issue #7 on
 * nouride-releases): a darwin-arm64 binary whose facts said `linux/x64` would have downloaded the Linux tarball, found
 * it genuinely signed, and swapped a Linux ELF over the Mac's binary. The swap now refuses it by the artefact's name
 * before anything is fetched, and by the executable's header before anything moves — against what the operating
 * system says at that moment.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { installStaged } from "../src/install.ts";
import { artifactTarget, executableTarget, foreignArtifact, foreignExecutable } from "../src/platform-guard.ts";

/** The first bytes of a 64-bit little-endian ELF for `machine` (0x3e x86-64, 0xb7 aarch64). */
function elf(machine: number): Uint8Array {
  const head = new Uint8Array(64);
  head.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  new DataView(head.buffer).setUint16(18, machine, true);
  return head;
}

/** The first bytes of a 64-bit Mach-O for `cpu` (0x01000007 x86-64, 0x0100000c arm64). */
function macho(cpu: number): Uint8Array {
  const head = new Uint8Array(64);
  const view = new DataView(head.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, cpu, true);
  return head;
}

describe("what an artefact's name says", () => {
  test("every edition's and target's name is read as its platform and arch", () => {
    expect(artifactTarget("nouride-linux-x64")).toEqual({ platform: "linux", arch: "x64" });
    expect(artifactTarget("nouride-pro-linux-arm64-musl")).toEqual({ platform: "linux", arch: "arm64" });
    expect(artifactTarget("nouride-darwin-arm64")).toEqual({ platform: "darwin", arch: "arm64" });
    expect(artifactTarget("nouride-router-darwin-x64")).toEqual({ platform: "darwin", arch: "x64" });
    expect(artifactTarget("nouride-windows-x64")).toBeNull();
  });

  test("a Linux build on a Mac is refused, and the Mac's own is not", () => {
    const mac = { platform: "darwin", arch: "arm64" };
    expect(foreignArtifact("nouride-linux-x64", mac)).toContain("is a build for linux/x64, and this machine is darwin/arm64");
    expect(foreignArtifact("nouride-darwin-x64", mac)).toContain("darwin/x64");
    expect(foreignArtifact("nouride-darwin-arm64", mac)).toBeNull();
    // musl or glibc is the check's and the plan's; both are this platform and arch.
    expect(foreignArtifact("nouride-linux-arm64-musl", { platform: "linux", arch: "arm64" })).toBeNull();
    expect(foreignArtifact("nouride", mac)).toContain("names no platform");
  });
});

describe("what an executable's header says", () => {
  test("ELF and Mach-O, x64 and arm64", () => {
    expect(executableTarget(elf(0x3e))).toEqual({ platform: "linux", arch: "x64" });
    expect(executableTarget(elf(0xb7))).toEqual({ platform: "linux", arch: "arm64" });
    expect(executableTarget(macho(0x01000007))).toEqual({ platform: "darwin", arch: "x64" });
    expect(executableTarget(macho(0x0100000c))).toEqual({ platform: "darwin", arch: "arm64" });
    expect(executableTarget(new TextEncoder().encode("#!/bin/sh\necho hello world\n"))).toBeNull();
  });

  test("the runtime running this test is an executable for the machine it runs on", () => {
    // A real file, read the way the swap reads one: the header parser agrees with the operating system.
    const head = new Uint8Array(readFileSync(process.execPath).subarray(0, 64));
    expect(executableTarget(head)).toEqual({ platform: platform(), arch: arch() });
    expect(foreignExecutable(head, { platform: platform(), arch: arch() })).toBeNull();
  });

  test("a Linux ELF is refused on a Mac, whatever its name said", () => {
    expect(foreignExecutable(elf(0x3e), { platform: "darwin", arch: "arm64" })).toContain("executable for linux/x64");
    expect(foreignExecutable(macho(0x01000007), { platform: "darwin", arch: "arm64" })).toContain("darwin/x64");
  });
});

describe("the swap", () => {
  let root: string;
  let installDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nouride-platform-guard-"));
    installDir = join(root, "install");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "nouride"), "OLD", { mode: 0o755 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A tarball whose `nouride` starts with `head`, and the checksum line for it under `artifact`. */
  function release(head: Uint8Array, artifact: string): { path: string; sums: string } {
    const stage = join(root, "stage");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "nouride"), head, { mode: 0o755 });
    const path = join(root, "release.tar.gz");
    spawnSync("tar", ["-czf", path, "-C", stage, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return { path, sums: `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ./${artifact}.tar.gz\n` };
  }

  const fetched: string[] = [];
  const serve = (sums: string) =>
    (async (url: string) => {
      fetched.push(String(url));
      return { ok: true, status: 200, text: async () => sums };
    }) as unknown as typeof fetch;

  const install = (artifact: string, path: string, sums: string, host?: { platform: string; arch: string }) =>
    installStaged({
      installDir,
      tarball: path,
      swap: ["nouride"],
      checksumUrl: "https://example.invalid/v9.9.9/SHA256SUMS",
      artifact,
      ...(host ? { host } : {}),
      fetchImpl: serve(sums),
    });

  test("refuses the Linux build on a Mac before fetching anything, and moves nothing", async () => {
    fetched.length = 0;
    const { path, sums } = release(elf(0x3e), "nouride-linux-x64");
    await expect(install("nouride-linux-x64", path, sums, { platform: "darwin", arch: "arm64" })).rejects.toThrow(
      "is a build for linux/x64, and this machine is darwin/arm64",
    );
    expect(fetched).toEqual([]);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toBe("OLD");
  });

  test("refuses a release named for the Mac whose executable is a Linux one, and moves nothing", async () => {
    const { path, sums } = release(elf(0x3e), "nouride-darwin-arm64");
    await expect(install("nouride-darwin-arm64", path, sums, { platform: "darwin", arch: "arm64" })).rejects.toThrow(
      "is an executable for linux/x64",
    );
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toBe("OLD");
  });

  test("installs the Mac's own build on a Mac", async () => {
    const { path, sums } = release(macho(0x0100000c), "nouride-darwin-arm64");
    await install("nouride-darwin-arm64", path, sums, { platform: "darwin", arch: "arm64" });
    expect(readFileSync(join(installDir, "nouride")).subarray(0, 4)).toEqual(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  });

  test("with no machine handed in, holds the build to the one the operating system reports", async () => {
    // The engine never passes `host`: this is the guard as it runs in the daemon. An artefact for some other machine
    // than this one — whichever this is — is refused.
    const other = platform() === "linux" && arch() === "x64" ? "nouride-darwin-arm64" : "nouride-linux-x64";
    const { path, sums } = release(elf(0x3e), other);
    await expect(install(other, path, sums)).rejects.toThrow(`and this machine is ${platform()}/${arch()}`);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toBe("OLD");
  });
});
