/**
 * The compile targets, and how a `--target` flag turns into them.
 *
 * Its own module because a script that runs a build on import cannot also be a library: the build,
 * the release checks and the tests all read it. Nothing here does I/O.
 */

/**
 * The targets worth naming — Bun's own ids without the `bun-` prefix the callers add back.
 *
 * The `linux-*` builds are **glibc**: `file` reports `interpreter /lib64/ld-linux-x86-64.so.2`, so
 * they run on Debian, Ubuntu, RHEL and their relatives, and fail on Alpine with a "not found" that
 * looks like a missing binary rather than a missing loader. `-musl` is the Alpine build. Getting this
 * wrong is silent until the first run on the server, which is why both are listed rather than
 * assuming glibc.
 *
 * `all` is what a release publishes of the public editions: every Linux server shape, and macOS on Apple
 * Silicon (owner's decision, 2026-10-19). Not literally every target: `darwin-x64` is published for Pro alone
 * (0.8.4, a buyer's Intel Mac; `PRO_TARGETS` in the release workflow) — a Community install on an Intel Mac
 * builds its own (`install.sh` says so).
 *
 * Each target is compiled on its own, so `process.platform` and `process.arch` are folded to that
 * target's — which is right for that binary, and is why one compiled binary's embedded code is never
 * re-compiled for another. The platform-neutral artefact is `--bundle-only`'s `dist/nouride.bundle.js`,
 * which reads both at runtime (`build-flags.test.ts` holds it to that).
 */
export const KNOWN_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
] as const;

export const ALL_TARGETS = ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-arm64"];

/**
 * The editions, and the name each one's artefact carries.
 *
 * Here rather than inside the build because two other things need to agree with it and
 * neither can import a module that reads `process.argv` at load time: the release workflow greps the
 * published assets by name to check a variant made it, and a test ties that grep to this function.
 *
 * That check had gone stale and nobody could see it. `--device-nougate` became `--pro-router` on
 * 2026-09-15, the artefacts became `nouride-pro-router-*`, and the workflow went on looking for
 * `nouride-nougate-*` — a name the builder has never produced. So every tagged release ended with
 * "the nougate variants are not on this release. They need SUBMODULE_TOKEN", while the job that
 * builds them had succeeded and its log said "LLM gateway bundled in".
 *
 * Three since 0.7.20: Pro Router became Pro (owner, 2026-10-19). Every Pro build carries the LLM gateway, off until
 * `[nougate] in_process = true`, so a Box and a pod run one edition, and `--pro-router` is refused by name
 * (`scripts/build/core.ts`).
 */
export const EDITIONS = ["basic", "router", "pro"] as const;

export type Edition = (typeof EDITIONS)[number];

/**
 * `nouride-linux-x64`, `nouride-router-linux-arm64` — the free edition carries no infix.
 *
 * `basic` has none because its names are the ones on the public download page and they predate the
 * other editions. `router` takes an infix like the rest, even though it is published alongside
 * `basic`: two public artefacts that differed only by what is inside them and not by name would be
 * indistinguishable in a release listing and in a download directory.
 */
export function artifactName(edition: Edition, target: string): string {
  return edition === "basic" ? `nouride-${target}` : `nouride-${edition}-${target}`;
}

/**
 * The targets `--target` names — `all` is `ALL_TARGETS`, which is what a release ships.
 *
 * `[]` means "this machine" — the host build, not an error. Both callers treat it that way.
 */
export function parseTargets(argv: string[]): string[] {

  const flag = argv.indexOf("--target");
  if (flag === -1) return [];

  const value = argv[flag + 1];
  if (!value) {
    console.error(`--target needs a value: ${KNOWN_TARGETS.join(", ")}, or all`);
    process.exit(1);
  }
  if (value === "all") return [...ALL_TARGETS];

  const requested = value.split(",").map((t) => t.trim());
  const unknown = requested.filter((t) => !KNOWN_TARGETS.includes(t as (typeof KNOWN_TARGETS)[number]));
  if (unknown.length > 0) {
    console.error(`unknown target(s): ${unknown.join(", ")}\nknown: ${KNOWN_TARGETS.join(", ")}, all`);
    process.exit(1);
  }
  return requested;
}

/**
 * Refuse a flag this script does not know.
 *
 * Added after a deploy went out with `--embed-wa-bridge`, a flag renamed to `--bundle-wa-bridge`
 * some time earlier. Nothing rejected it: the build quietly produced the *default* shape — bridge
 * as a separate process — against a host configured for `inproc`, and the difference first showed
 * up in production as a WhatsApp gateway that reconnected five times and died.
 *
 * The failure mode is the reason this is worth a check rather than a habit. A wrong flag does not
 * make a broken build, it makes a *different working build*, and the only clue at the console was
 * a tarball that had grown from 41MB to 72MB — which nobody reads.
 *
 * Exits rather than throws, matching `parseTargets` above: these run as scripts, and a stack trace
 * is a worse answer than a sentence naming the flags that exist.
 */
export function assertKnownFlags(argv: string[], known: readonly string[]): void {
  const unknown = unknownFlags(argv, known);
  if (unknown.length === 0) return;

  console.error(
    `unknown flag(s): ${unknown.join(", ")}\nknown: ${[...known, "--target <name>"].join(", ")}`,
  );
  process.exit(1);
}

/**
 * The decision, without the exit — which is the part worth testing.
 *
 * Split out because `bun -e` discards trailing arguments, so a subprocess harness cannot pass the
 * very thing under test. One subprocess still covers the exit code; everything about *which* flags
 * are wrong is answered here, in a function that returns.
 */
export function unknownFlags(argv: string[], known: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // `--target`'s value is the one positional that follows a flag, so it is skipped rather than
    // examined. Everything else beginning with a dash is meant to be a flag.
    if (arg === "--target") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && !known.includes(arg)) out.push(arg);
  }
  return out;
}
