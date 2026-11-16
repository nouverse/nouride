/**
 * The system under the daemon (`system.ts`), as an agent is told it: read from files and programs of the test's making,
 * so each part said is one that was read, and a part that could not be read is left out.
 */

import { describe, expect, test } from "bun:test";
import { readSystem, type SystemSource } from "../src/system.ts";

function source(os: string, cpu: string, files: Record<string, string> = {}, programs: Record<string, string> = {}): SystemSource {
  return { platform: () => os, arch: () => cpu, read: (path) => files[path] ?? null, run: (program) => (programs[program] === undefined ? null : { text: programs[program]! }) };
}

describe("the system's name, architecture and place", () => {
  test("a Linux names itself from os-release, and its architecture is uname's word", () => {
    const debian = { "/etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\n' };
    expect(readSystem(source("linux", "x64", debian))).toEqual({ name: "Debian GNU/Linux 12 (bookworm)", arch: "x86_64", container: false, androidKernel: false });
    // No PRETTY_NAME: the name and its version; the other place os-release is kept.
    expect(readSystem(source("linux", "arm64", { "/usr/lib/os-release": "NAME=Alpine Linux\nVERSION_ID=3.20.3\n" })).name).toBe("Alpine Linux 3.20.3");
  });

  test("what cannot be read is not filled in: a Linux with no os-release is Linux", () => {
    expect(readSystem(source("linux", "riscv64")).name).toBe("Linux");
    expect(readSystem(source("linux", "riscv64")).arch).toBe("riscv64");
  });

  test("a Mac by its own program, and without it still a Mac", () => {
    expect(readSystem(source("darwin", "arm64", {}, { sw_vers: "15.1\n" })).name).toBe("macOS 15.1");
    expect(readSystem(source("darwin", "arm64")).name).toBe("macOS");
  });

  test("a container by its own marker, Docker's or Podman's, an empty file counted", () => {
    expect(readSystem(source("linux", "x64", { "/.dockerenv": "" })).container).toBe(true);
    expect(readSystem(source("linux", "x64", { "/run/.containerenv": "engine=\"podman\"\n" })).container).toBe(true);
  });

  test("an Android phone's kernel, as Nouride Home's Debian sees it", () => {
    const proot = { "/etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n', "/proc/version": "Linux version 5.10.209-android12-9-o-g4f2e7b8 (build-user@build-host)\n" };
    expect(readSystem(source("linux", "arm64", proot))).toEqual({ name: "Debian GNU/Linux 12 (bookworm)", arch: "arm64", container: false, androidKernel: true });
  });

  test("the real one is read, never assumed", () => {
    const real = readSystem();
    expect(real.name.length).toBeGreaterThan(0);
    expect(real.arch.length).toBeGreaterThan(0);
  });
});
