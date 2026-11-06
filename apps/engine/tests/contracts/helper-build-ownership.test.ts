/**
 * The root helper built in a container leaves nothing the next build cannot remove (0.8.0's release run, 2026-10-25).
 *
 * The self-hosted runner keeps its working copy between jobs. The first job built `nouride-run` in a root container;
 * Docker made `dist/nouride-run/` for the bind mount as root, the hand-back covered only the mount, and every later
 * job's checkout failed on `EACCES` before it ran a step. Two rules hold it now: the output directory is made by whoever
 * builds, and the container hands `/out` back whether the build passed or not, keeping the build's exit code.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerScript } from "../../../../scripts/build/nouride-run.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `script` under `sh`, with `rustup`, `cargo` and `chown` replaced by stubs; what chown was asked, and the exit code. */
function run(script: string, cargoExit: number): { status: number | null; chown: string } {
  const bin = mkdtempSync(join(tmpdir(), "helper-build-"));
  dirs.push(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("rustup", "exit 0");
  stub("cargo", `exit ${cargoExit}`);
  stub("chown", `echo "$@" > "${join(bin, "chowned")}"`);
  const result = spawnSync("sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
  let chown = "";
  try {
    chown = readFileSync(join(bin, "chowned"), "utf8").trim();
  } catch {
    // Not called.
  }
  return { status: result.status, chown };
}

describe("the container's script", () => {
  test("hands /out back to the builder after a build that passed", () => {
    const { status, chown } = run(containerScript("x86_64-unknown-linux-musl", 1001, 1001), 0);
    expect(status).toBe(0);
    expect(chown).toBe("-R 1001:1001 /out");
  });

  test("hands it back after a build that failed too, and still fails", () => {
    const { status, chown } = run(containerScript("aarch64-unknown-linux-musl", 1001, 1002), 101);
    expect(status).toBe(101);
    expect(chown).toBe("-R 1001:1002 /out");
  });
});

test("the output directory is made before the container mounts it", () => {
  const source = readFileSync(join(import.meta.dir, "../../../../scripts/build/nouride-run.ts"), "utf8");
  const made = source.indexOf("mkdirSync(out, { recursive: true })");
  const mounted = source.indexOf('"docker", "run"');
  expect(made).toBeGreaterThan(0);
  expect(made).toBeLessThan(mounted);
});
