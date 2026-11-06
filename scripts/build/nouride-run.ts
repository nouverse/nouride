/**
 * `nouride-run`, the root helper (`packages/isolation/root/nouride-run`), built for a Linux release's tarball as `run/`.
 *
 * Static and musl, one per architecture: the same file runs on a glibc box and on Alpine, and loads nothing at run
 * time — it starts as root, and a dynamic loader is one more thing a root process trusts. Cross-compiled with the
 * toolchain's own linker (`rust-lld`), so neither architecture needs the other's C toolchain or an emulator. With
 * `cargo` here when it has both targets; in a `rust` container otherwise — a laptop with Docker builds a release the
 * way the runner does.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const CRATE = join(ROOT, "packages/isolation/root/nouride-run");
const OUT = join(ROOT, "dist/nouride-run");
/** Pinned, so two builds of one commit compile with one compiler. */
const RUST_IMAGE = "rust:1.99-bookworm";
const RUSTFLAGS = "-C linker=rust-lld -C target-feature=+crt-static";

/** The Rust target for a release target's architecture; null for one that is not Linux. */
export function rustTarget(target: string): string | null {
  if (!target.startsWith("linux-")) return null;
  return target.includes("arm64") ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
}

async function exec(cmd: string[], env: Record<string, string> = {}): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd: CRATE, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  return proc.exited;
}

async function hasTargets(targets: readonly string[]): Promise<boolean> {
  if (!Bun.which("cargo") || !Bun.which("rustup")) return false;
  const proc = Bun.spawn(["rustup", "target", "list", "--installed"], { stdout: "pipe", stderr: "ignore" });
  const installed = (await new Response(proc.stdout).text()).split("\n");
  return targets.every((target) => installed.includes(target));
}

const built = new Map<string, Promise<string>>();

/** The helper for `target`'s architecture, built once per run; its path. Throws when it cannot be built. */
export function nourideRunFor(target: string): Promise<string> {
  const rust = rustTarget(target);
  if (!rust) throw new Error(`nouride-run is for Linux; ${target} has none`);
  let pending = built.get(rust);
  if (!pending) {
    pending = build(rust);
    built.set(rust, pending);
  }
  return pending;
}

/**
 * What the container runs: the build, then the output handed to whoever started it — **whether or not the build
 * passed**, and keeping its exit code. `/out` was left root's after a failed build, since `&&` skipped the hand-back.
 */
export function containerScript(rust: string, uid: number, gid: number): string {
  return `rustup target add ${rust} >/dev/null && cargo build --release --locked --target ${rust}; status=$?; chown -R ${uid}:${gid} /out; exit $status`;
}

async function build(rust: string): Promise<string> {
  const out = join(OUT, rust);
  // Made here, as whoever builds: a directory Docker makes for a bind mount is root's, and so is the parent it makes on
  // the way. The self-hosted runner keeps its working copy, so the next job's checkout could not clean
  // `dist/nouride-run/` and failed — every job after the first in 0.8.0's release run (2026-10-25).
  mkdirSync(out, { recursive: true });
  const binary = join(out, rust, "release", "nouride-run");
  const code = (await hasTargets([rust]))
    ? await exec(["cargo", "build", "--release", "--locked", "--target", rust], { CARGO_TARGET_DIR: out, RUSTFLAGS })
    : await exec([
        "docker", "run", "--rm",
        "-v", `${CRATE}:/src:ro`,
        "-v", `${out}:/out`,
        "-e", "CARGO_TARGET_DIR=/out",
        "-e", `RUSTFLAGS=${RUSTFLAGS}`,
        "-w", "/src",
        RUST_IMAGE,
        "sh", "-c", containerScript(rust, process.getuid?.() ?? 0, process.getgid?.() ?? 0),
      ]);
  if (code !== 0 || !existsSync(binary)) {
    throw new Error(`nouride-run did not build for ${rust} (exit ${code}) — install rustup with the ${rust} target, or Docker`);
  }
  return binary;
}
