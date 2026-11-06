/**
 * Every shell script we ship parses.
 *
 * Added after `install.sh` went out in v0.5.10 and v0.5.11 with two lines duplicated at its end — a
 * stray `fi` that `dash` rejects. Nothing caught it because the error is at the *last* block: the
 * install itself had already finished, so a box came up fine and `curl … | sh` still ended on
 * `Syntax error: "fi" unexpected` and a non-zero exit, which reads as a failed install. Found
 * deploying 0.5.12 to the live box.
 *
 * `sh -n` reads without running. On Linux CI `sh` is `dash`, the strictest shell these scripts meet
 * in the field; on macOS it is bash in POSIX mode, which catches the same class.
 */

import { describe, expect, test } from "bun:test";
import { runCommand } from "@nouride/runtime";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = join(import.meta.dir, "../../../../scripts");

/**
 * Top-level scripts, and `nouride-pkg` with its backends and its container service — the scripts that run as root,
 * shipped from `packages/system-packages/root`. The backends are sourced, never run, and `sh -n` reads them the same.
 */
const PKG_ROOT = "../packages/system-packages/root";
const shellScripts = [
  ...readdirSync(SCRIPTS).filter((name) => name.endsWith(".sh")),
  `${PKG_ROOT}/nouride-pkg`,
  `${PKG_ROOT}/container/nouride-pkg-container`,
  ...readdirSync(join(SCRIPTS, PKG_ROOT, "backends"))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => `${PKG_ROOT}/backends/${name}`),
];

describe("shell scripts", () => {
  test("there are some to check", () => {
    // A glob that silently matches nothing would pass every script by checking none.
    expect(shellScripts).toContain("install.sh");
    expect(shellScripts).toContain(`${PKG_ROOT}/backends/apt.sh`);
  });

  for (const name of shellScripts) {
    test(`${name} parses`, async () => {
      const result = await runCommand(["sh", "-n", join(SCRIPTS, name)], {
        cwd: SCRIPTS,
        timeoutMs: 10_000,
        maxOutputBytes: 16_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});

describe("what install.sh tells a person to run", () => {
  test("names commands the CLI has: it said `./nouride run` until 0.8.18, which answers Unknown command", async () => {
    const { GRAMMAR } = await import("@/cli/grammar.ts");
    const text = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
    const named = [...text.matchAll(/\.\/nouride ([a-z][a-z-]*)/g)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((command) => !(command in GRAMMAR))).toEqual([]);
  });
});

describe("install.sh, run whole at every release (0.8.18)", () => {
  test("the release workflow runs it twice on Debian, Ubuntu arm64 and Alpine, and asks the download host", () => {
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    expect(workflow).toContain('sh scripts/release/install-run.sh install-run/nouride-linux-x64.tar.gz debian:13 linux/amd64 "$v"');
    expect(workflow).toContain('sh scripts/release/install-run.sh install-run/nouride-linux-arm64.tar.gz ubuntu:24.04 linux/arm64 "$v"');
    expect(workflow).toContain('sh scripts/release/install-run.sh install-run/nouride-linux-x64-musl.tar.gz alpine:3.20 linux/amd64 "$v"');
    expect(workflow).toContain("https://get.nouride.com/latest/nouride-linux-x64.tar.gz");
  });

  test("on Alpine without shadow the account is made with busybox's adduser, not refused at useradd", () => {
    const text = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
    expect(text).toContain('adduser -S -D -H -h "$INSTALL_DIR/.nouride/home" -s /sbin/nologin -G "$SERVICE_USER" "$SERVICE_USER"');
    expect(text).toMatch(/if command -v useradd >\/dev\/null 2>&1; then\n\s+useradd --system/);
  });
});

