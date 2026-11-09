/**
 * Build the standalone `nouride` executable, for this machine or for a server.
 *
 * `bun build --compile` produces one file with the runtime inside it, so a server needs no Bun
 * install — but it also means the source tree is gone at runtime, and two things used to be read from
 * it. The migrations are now compiled in (`src/db/migrations.ts`); the dashboard is a directory of
 * assets with hashed names, which cannot be named as imports, so it ships *beside* the binary and the
 * server looks there. That is why this is a script and not a one-line `bun build`: the artifact is the
 * binary plus that directory, and a tarball of both is what actually gets copied to a server.
 *
 * Usage:
 *   bun run build:binary                          # this machine, → dist/nouride
 *   bun run build:binary --target linux-x64       # cross-compiled, → dist/nouride-linux-x64/
 *   bun run build:binary --target linux-x64,linux-arm64
 *   bun run build:binary --target all
 *
 * Cross-compiling works from any host: Bun downloads and caches the target runtime on first use, so
 * the first foreign target is slow and the rest are not.
 *
 * ## Editions
 *
 * An edition names who a build is for, not which switches it sets: the free build is free because the
 * code that would make it otherwise is not compiled into it, and a reader should be able to tell which
 * build they hold without reading a flag matrix. This script makes the published one — `basic` (no flag), which
 * carries the LLM gateway in this process when `internals/nougate` is checked out, and is built without it otherwise
 * unless `--require-gateway` says it must not be. `--router`, which used to add the gateway as an edition of its own,
 * is refused by name. The other, `--pro`, is `bun run build:pro`, whose recipe is private
 * (`internals/pro/packages/build-pro`) and imports this same core; it always carries the gateway. `--target` and
 * `--no-smol` are orthogonal to all of them.
 *
 * **WhatsApp is not an edition**: every build carries the bridge in this process, with no second
 * executable (`ALWAYS` in `edition.ts`). It was an edition switch until 2026-09-16.
 *
 * **A plugin an edition does not carry is absent, not switched off.** It is `--external`, so the
 * engine's dynamic `import()` of it cannot resolve, and a config that needs it is refused at boot
 * rather than ignored. `--define` was tried and does not remove the branch. The flags that described
 * mechanisms instead — `--bundle-wa-bridge` and the rest — are refused by name (`RETIRED_FLAGS`).
 */

import { mkdir, mkdtemp, rm, cp, stat, symlink } from "node:fs/promises";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { BRIDGE_EXTERNALS, NATIVE_LOADER_MARKERS } from "../bridge-externals.ts";
import { checkoutPathsIn, noBuildPathFlags } from "./build-path.ts";
import { nourideRunFor, rustTarget } from "./nouride-run.ts";
import { artifactName as name, assertKnownFlags, parseTargets, type Edition } from "../targets.ts";
import {
  ALWAYS,
  APPLIANCE,
  editionFlags,
  NOUGATE,
  OPTIONAL,
  resolveEdition,
  selectEdition,
  type EditionSpec,
  type PluginSpec,
} from "./edition.ts";
import {
  entryCode,
  IMAGE_TARGET,
  mapFileName,
  mapFitsBinary,
  mapFitsBundle,
  mapsInTarball,
  stampMap,
  type MapStamp,
  type RawSourceMap,
} from "./source-map.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const DASHBOARD_DIST = join(ROOT, "apps/dashboard/dist");
const NOUGATE_FRONTEND_DIST = join(ROOT, "internals/nougate/apps/frontend/dist");
/**
 * Skills that ship with the daemon — the `builtin` scope.
 *
 * Travels with the binary because `resolveBuiltinSkillsDir()` looks for `skills/` beside the
 * executable, and an install without it is not a broken daemon: it is a daemon that has quietly
 * forgotten how to do things, with nothing in the log to connect that to a missing directory. A
 * source checkout has it under `content/` and so never noticed. Staged as plain `skills/`: the
 * tarball has nothing to group it with, and the resolver looks for both names.
 */
const BUILTIN_SKILLS = join(ROOT, "content/skills");
const ENTRY = join(ROOT, "apps/engine/src/cli/main.ts");

async function run(
  cmd: string[],
  label: string,
  env?: Record<string, string>,
  cwd: string = ROOT,
  /**
   * Attempts, for a step whose failure can be the network rather than the code.
   *
   * Cross-compiling downloads the target's Bun runtime on first use, from Bun's
   * CDN, and that download is the one part of this script nothing local can fix.
   * `v0.1.1` lost a variant to `Failed to download 'bun-linux-x64-musl-v1.4.2':
   * ConnectionClosed` after three of its four targets had already compiled —
   * a release job red for a reason that had nothing to do with the release.
   *
   * Only compiles retry. A failing `tar` or a missing dashboard is a real
   * failure and repeating it wastes a minute to reach the same answer.
   */
  attempts = 1,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const code = await proc.exited;
    if (code === 0) return;

    if (attempt < attempts) {
      // Linear, not exponential: the thing being waited out is a dropped
      // connection to a CDN, which is over in seconds or is not transient.
      const waitMs = attempt * 5_000;
      console.error(`! ${label} failed (exit ${code}) — retrying in ${waitMs / 1000}s (${attempt}/${attempts - 1})`);
      await Bun.sleep(waitMs);
      continue;
    }
    console.error(`✗ ${label} failed (exit ${code})`);
    process.exit(code);
  }
}

/** How many times a compile may be attempted before the build gives up. */
const COMPILE_ATTEMPTS = 3;

async function bytes(path: string): Promise<string> {
  const { size } = await stat(path);
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Refuse to build a binary whose dashboard would 503.
 *
 * The whole failure this script exists to prevent was an artifact that looked complete and was not,
 * so an empty or missing `apps/dashboard/dist` is an error rather than a warning nobody reads.
 */
async function assertDashboardBuilt(): Promise<void> {
  const index = join(DASHBOARD_DIST, "index.html");
  if (!(await Bun.file(index).exists())) {
    console.error(`✗ no dashboard build at ${DASHBOARD_DIST}\n  run: bun run build:dashboard`);
    process.exit(1);
  }
}

/**
 * The Nouride Box setup console (`internals/pro/packages/appliance/src/ui`), rebuilt into the one HTML file the plugin
 * embeds — on every build of an edition that carries the plugin, so the binary never ships a page
 * older than its source. Skipped when the private checkout is absent; the committed file stands in.
 */
async function buildApplianceSetupUi(edition: EditionSpec): Promise<void> {
  const pro = join(ROOT, "internals/pro");
  const plugin = join(pro, "appliance");
  if (!edition.bundles.includes(APPLIANCE) || !existsSync(join(plugin, "package.json"))) return;
  // `internals/pro` is a workspace of its own: one install there covers the setup console's tools. Every build, not only
  // when node_modules is missing — which left a stale install from an older lockfile unrefreshed; frozen, a current one
  // is a link step.
  await run(["bun", "install", "--frozen-lockfile"], "internals/pro install", undefined, pro);
  await run(["bun", "run", "build:ui"], "setup-ui build", undefined, plugin);
}

/** The signals a build is stopped by, and the numbers that make its exit status. */
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * The scratch directories a build is using — a map's second compile, the image bundle's run — removed with the plugin
 * links on every way out, a signal and a failed step's `process.exit` included. `dist/` is never published, but what
 * one holds is a throwaway binary that embeds every source path, or a map: nothing to leave lying where a tarball is
 * made. Real paths, because Bun writes a map's sources relative to the real one (`/private/var` on macOS, not `/var`).
 */
const scratchDirs = new Set<string>();

async function scratchDir(prefix: string, under: string = DIST): Promise<string> {
  await mkdir(under, { recursive: true });
  const dir = realpathSync(await mkdtemp(join(under, prefix)));
  scratchDirs.add(dir);
  return dir;
}

function dropScratch(dir: string): void {
  scratchDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Run `run` with every plugin the edition carries resolvable, and only for as long as it runs.
 *
 * The engine declares each plugin's shape in a `.d.ts` and does not map it to the plugin's source, so
 * `tsc` needs nothing linked — but the *bundler* has to find real code, and it looks in
 * `node_modules`. The in-tree plugins are workspace members nothing depends on by name, and the private
 * ones are submodule directories, so `bun install` links none of them; a symlink says "this package is
 * that directory" for exactly as long as the build runs.
 *
 * Temporary on purpose: a permanent link would put every plugin on every build's resolution path,
 * which is what `--external` exists to keep them off.
 */
async function withPluginsResolvable<T>(edition: EditionSpec, run: () => Promise<T>): Promise<T> {
  const links: string[] = [];

  /**
   * Registered before the first link, and it has to be.
   *
   * Two ways out of this function skip a `finally`: `run` ends a failed compile with
   * `process.exit(code)`, and `linkPlugin` throws on a private submodule that is not checked out.
   * The links that had already been made survived both — and the next `lint:types` followed them
   * into nougate's source and failed with sixteen errors on a tree where nothing was wrong. The
   * same bug `dev-gateway.sh` documents at its own `trap`, reached from the other direction.
   *
   * Registering it after the linking loop fixed the first way out and not the second: the throw
   * happens mid-loop, so the handler was never installed and `packages/wa-bridge` stayed linked.
   *
   * Synchronous, because an `exit` handler is the last thing that runs and an awaited `rm` would
   * never finish. Idempotent, so the `finally` below and this can both fire.
   */
  const cleanup = (): void => {
    for (const link of links.splice(0)) rmSync(link, { recursive: true, force: true });
    for (const dir of [...scratchDirs]) dropScratch(dir);
  };
  process.on("exit", cleanup);
  /**
   * And on a signal, which an `exit` handler does not see: checked on Bun 1.4.2, Ctrl-C (130), a cancelled CI step
   * (SIGTERM, 143) and a closed terminal (SIGHUP, 129) all left every link in place. Removed, then the process ends
   * with the status the signal would have given it — a handler that only cleaned up would leave the build running.
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup();
    process.exit(128 + (SIGNAL_NUMBERS[signal] ?? 1));
  };
  for (const signal of CLEANUP_SIGNALS) process.on(signal, onSignal);

  for (const plugin of [...ALWAYS, ...edition.bundles]) {
    links.push(await linkPlugin(edition, plugin));
  }

  try {
    return await run();
  } finally {
    cleanup();
    process.off("exit", cleanup);
    for (const signal of CLEANUP_SIGNALS) process.off(signal, onSignal);
  }
}

/**
 * One `node_modules` entry pointing at a plugin directory. Scoped names need their parent made.
 *
 * Refuses an empty directory before linking it, because three of these are **private submodules**
 * and a public clone has the directory without the contents. Bun does not error on a dynamic
 * `import()` of a bare specifier it cannot resolve at *bundle* time — it errors at *compile* time,
 * with `Could not resolve: "nouride-oauth". Maybe you need to "bun install"?`, after the two-attempt
 * retry has spent twenty seconds on it. That message names a package nobody mentioned and suggests
 * a command that cannot help; this one names the flag, the path and the way to get it.
 */
async function linkPlugin(edition: EditionSpec, plugin: PluginSpec): Promise<string> {
  const target = join(ROOT, plugin.pkgDir ?? plugin.dir);
  const name = plugin.pkg;
  if (!checkedOut(plugin)) {
    // `relative`, not `slice(ROOT.length + 1)`. ROOT already ends in a separator, so that ate the
    // first character of the path and printed `lugins/oauth` — in an error whose only job is to
    // give somebody a command they can paste.
    const rel = relative(ROOT, target);
    throw new Error(
      `the ${edition.id} edition needs \`${rel}\`, and it is not checked out.\n` +
        `  git submodule update --init ${plugin.dir}\n` +
        `  (private — you need read access to it. The free build needs none of these: ` +
        `\`bun run build:binary\` works on a clone with no submodules at all.)`,
    );
  }
  const link = join(ROOT, "node_modules", name);
  await mkdir(join(link, ".."), { recursive: true });
  await rm(link, { recursive: true, force: true });
  await symlink(target, link);
  return link;
}

/** Whether a plugin's source is here to link: the test `linkPlugin` refuses on, and what `resolveEdition` asks. */
function checkedOut(plugin: PluginSpec): boolean {
  return existsSync(join(ROOT, plugin.pkgDir ?? plugin.dir, "package.json"));
}

/**
 * A bundle build that did not bundle anything is the failure this catches.
 *
 * Bun does not error on a dynamic `import()` of a bare specifier it cannot resolve — it leaves it
 * for runtime. So a missing symlink, an uninitialised submodule or a renamed export all produce a
 * binary that builds cleanly, says "WhatsApp bundled", and then cannot open a WhatsApp connection.
 * Checked by looking for the plugin's own marker in the artefact, because that is the claim being
 * made — see `PluginSpec.marker` for why it is a literal from the source and not a package name.
 */
async function assertEmbedded(edition: EditionSpec, binary: string): Promise<void> {
  const wanted = [...ALWAYS, ...edition.bundles];
  if (wanted.length === 0) return;

  const text = await readArtefact(binary);
  for (const plugin of wanted) {
    if (text.includes(plugin.marker)) continue;
    throw new Error(
      `${binary} was built as the ${edition.id} edition, which carries ${plugin.pkg}, and carries ` +
        `none of it. The plugin did not resolve — check that ${plugin.dir} is initialised ` +
        `(git submodule update --init ${plugin.dir}) and has its dependencies installed.`,
    );
  }
}

/**
 * The other direction, and the one that matters commercially.
 *
 * `assertEmbedded` proves a bundle contains what it claims. This proves it contains what it must
 * NOT: the whole point of `--external nouride-oauth` is that `NOURIDE_OAUTH_ISSUER` has no code to
 * read it, and a build that quietly linked the flow anyway would look identical from outside.
 *
 * Driven by the same `bundles` field as the `--external` flags, so the flag and its proof cannot
 * disagree. It runs for every edition, public or not: a private artefact whose banner says "no
 * external sign-in" while carrying the flow is still a lie, and it is how this check found the bug
 * that made it read one field instead of two.
 *
 * `OPTIONAL` lives in the public tree even though two of the three plugins it names are private
 * submodules. It has to: this is the public build's own guarantee, and it cannot depend on a
 * submodule a public clone does not have.
 */
async function assertAbsent(edition: EditionSpec, binary: string): Promise<void> {
  const forbidden = OPTIONAL.filter((plugin) => !edition.bundles.includes(plugin));

  const text = await readArtefact(binary);
  for (const plugin of forbidden) {
    if (!text.includes(plugin.marker)) continue;
    throw new Error(
      `${binary} was built as the ${edition.id} edition, which does not carry ${plugin.pkg}, and ` +
        `carries it. Something imports it statically, or its --external flag was dropped — either ` +
        `way this artefact is not the edition it claims to be.`,
    );
  }
  // And what no edition carries: a native module's loader, which the bundler embeds from whatever version of `sharp`
  // happens to be linked beside Baileys (`bridge-externals.ts` has the crash that makes this a build failure).
  for (const marker of NATIVE_LOADER_MARKERS) {
    if (!text.includes(marker)) continue;
    throw new Error(
      `${binary} carries \`${marker}\`, which is sharp's native loader: one of BRIDGE_EXTERNALS was compiled in. ` +
        `Check that bundleFlags still marks them --external.`,
    );
  }
  // Nor the path of the checkout it was built in, which would ship to every install and make the build differ by where
  // it ran (`build-path.ts`). Whatever wrote it — a dependency reading a name `noBuildPathFlags` does not define, a
  // newer Bun inlining something it did not — the artefact is not shipped with it.
  const paths = checkoutPathsIn(text, [ROOT, realpathSync(ROOT)]);
  if (paths.length > 0) {
    throw new Error(
      `${binary} names the checkout it was built in:\n  ${paths.slice(0, 3).join("\n  ")}\n` +
        `  Find what writes that path and define it away in noBuildPathFlags (scripts/build/build-path.ts).`,
    );
  }
}

/**
 * The private source map for the code inside `binary`, written to `dist/<artifact>.map` — beside the tarball,
 * never in it.
 *
 * Made by compiling a second time, with `compile`'s exact argv plus `--sourcemap=external`, into a scratch
 * directory: Bun writes `nouride.map` beside that binary, and the binary is thrown away, because it embeds the
 * map and with it every original path. The shipped binary was compiled without one.
 *
 * Only a compile's map will do. A plain `bun build` of the same entry is a different program: `--compile` folds
 * `process.platform` to the target's and turns each `with { type: "text" }` import into an embedded file, so the
 * code differs, and with `--minify-identifiers` every name after the first difference differs too. Compiling
 * from a pre-built bundle re-prints it — imports hoisted, declarations merged — so that map is wrong as well.
 * Both were measured on Bun 1.4.2; `mapFitsBinary` is the check that would catch either.
 *
 * The map is kept only if `mapFitsBinary` holds: the shipped binary's code is the scratch binary's, byte for
 * byte, and the map was written for that code. Otherwise the build fails — a map wrong by one column names the
 * wrong function, and nobody can tell from the output.
 *
 * Its sources are the private source, `sourcesContent` included, so it goes where the Pro checksum signatures go:
 * the internal release (`release.yml`), never the public one, and `lint:public` refuses one in the published tree.
 */
async function writePrivateMap(
  edition: EditionSpec,
  compile: string[],
  binary: string,
  target: string | null,
): Promise<string> {
  const scratch = await scratchDir(".map-");
  try {
    const { map, code } = await compileMap(compile, ENTRY, binary, scratch);
    // Bun names each source relative to the directory the build ran in, which is the root; kept with `/`.
    const stamped = stampMap(map, await stampFor(edition, target ?? "host", code), (source) => source.split("\\").join("/"));
    const out = join(DIST, mapFileName(target ? artifactName(edition, target) : null));
    await Bun.write(out, JSON.stringify(stamped));
    return out;
  } finally {
    dropScratch(scratch);
  }
}

/** The stamp a map carries: the version being built, the edition and target, and the hash of the code it maps. */
async function stampFor(edition: EditionSpec, target: string, code: Uint8Array): Promise<MapStamp> {
  const { version } = (await Bun.file(join(ROOT, "apps/engine/package.json")).json()) as { version: string };
  return { version, edition: edition.id, target, codeSha256: new Bun.CryptoHasher("sha256").update(code).digest("hex") };
}

/**
 * The image's bundle, `dist/nouride.bundle.js`, and its private source map, `dist/<artifact>-image.map`, stamped with
 * the version, the edition, `image` and the bundle's SHA-256 — the hash `release.yml` compares with the bundle in the
 * pushed image.
 *
 * One `bun build --sourcemap=external` into a scratch directory gives both: `mapFitsBundle` says why the output with
 * its `//# debugId=` line cut is exactly the map-less build, and refuses a map that does not fit. Nothing else from
 * that run is kept, so the bundle that reaches `out` names no map, and the map is never beside it under the name
 * Bun would read (`mapFileName`). The Dockerfile's `source-map` stage is how the map leaves the image build; the
 * runtime stages copy the bundle alone.
 *
 * The paths are options for the contract test, which runs this on a fixture; the build passes none.
 */
export async function writeImageBundle(
  edition: EditionSpec,
  { entry = ENTRY, out = join(DIST, "nouride.bundle.js"), mapDir = DIST, cwd = ROOT } = {},
): Promise<string> {
  const scratch = await scratchDir(".bundle-", mapDir);
  try {
    const { code, map } = await bundleWithMap(bundleFlags(edition), entry, scratch, cwd);
    await Bun.write(out, code);
    const path = join(mapDir, mapFileName(artifactName(edition, IMAGE_TARGET)));
    await Bun.write(path, JSON.stringify(stampMap(map, await stampFor(edition, IMAGE_TARGET, code), (source) => source)));
    return path;
  } finally {
    dropScratch(scratch);
  }
}

/**
 * A plain bundle of `entry` with `flags`, and the map written with it — returned only if `mapFitsBundle` holds, with
 * the code that may ship. Sources are made relative to `cwd`, where Bun writes them relative to `scratch` — both taken
 * as real paths, as Bun takes them. Throws, naming what is wrong, otherwise.
 */
async function bundleWithMap(
  flags: string[],
  entry: string,
  scratch: string,
  cwd: string = ROOT,
): Promise<{ code: Buffer; map: RawSourceMap }> {
  const argv = ["bun", "build", ...flags, "--sourcemap=external", "--outdir", scratch, "--entry-naming", "nouride.bundle.js", entry];
  await run(argv, "bundle", undefined, cwd, COMPILE_ATTEMPTS);
  const mapped = new Uint8Array(await Bun.file(join(scratch, "nouride.bundle.js")).arrayBuffer());
  const map = (await Bun.file(join(scratch, "nouride.bundle.js.map")).json()) as RawSourceMap;
  const fit = mapFitsBundle(map, mapped);
  if ("problem" in fit) throw new Error(`${relative(cwd, entry)}: no image bundle is written — ${fit.problem}`);
  const [from, base] = [realpathSync(scratch), realpathSync(cwd)];
  const sources = map.sources.map((source) => relative(base, resolve(from, source)).split("\\").join("/"));
  return { code: fit.code, map: { ...map, sources } };
}

/**
 * The source map of the code in `binary`, which `compile … --outfile binary entry` made: compiled again into
 * `scratch` with `--sourcemap=external`, and returned only if `mapFitsBinary` holds — with the shipped entry code,
 * which the stamp hashes. Throws, naming what differs, when it does not. Exported for the contract test, which
 * runs it on a fixture with the build's own flags.
 */
export async function compileMap(
  compile: string[],
  entry: string,
  binary: string,
  scratch: string,
  cwd: string = ROOT,
): Promise<{ map: RawSourceMap; code: Buffer }> {
  const mapped = join(scratch, "nouride");
  await run([...compile, "--sourcemap=external", "--outfile", mapped, entry], "private source map", undefined, cwd, COMPILE_ATTEMPTS);
  const map = (await Bun.file(`${mapped}.map`).json()) as RawSourceMap;
  const shipped = new Uint8Array(await Bun.file(binary).arrayBuffer());
  const problem = mapFitsBinary(map, shipped, new Uint8Array(await Bun.file(mapped).arrayBuffer()));
  if (problem) throw new Error(`${relative(ROOT, binary)}: no source map is written for it — ${problem}`);
  return { map, code: entryCode(shipped)! };
}

/**
 * A tarball that carries a source map, or a reference to one, fails the build.
 *
 * Read from the tarball itself — its entry names and every byte it unpacks to — rather than from the staging
 * directory, because the tarball is what is uploaded and the claim is about it.
 */
export async function assertTarballCarriesNoMap(tarball: string): Promise<void> {
  const read = async (args: string[]): Promise<Uint8Array> => {
    const proc = Bun.spawn(["tar", ...args, tarball], { stdout: "pipe", stderr: "inherit" });
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    if ((await proc.exited) !== 0) throw new Error(`tar ${args.join(" ")} ${tarball} failed`);
    return bytes;
  };
  const names = new TextDecoder().decode(await read(["-tzf"])).split("\n").filter(Boolean);
  const contents = new TextDecoder("latin1").decode(await read(["-xzOf"]));
  const found = mapsInTarball([...names.map((name) => ({ name, text: "" })), { name: "(contents)", text: contents }]);
  if (found.length > 0) {
    throw new Error(`${relative(ROOT, tarball)} carries a source map, which is private:\n  ${found.join("\n  ")}`);
  }
}

/** The artefact as text, so a marker can be looked for in it. Read once per check. */
async function readArtefact(binary: string): Promise<string> {
  const bytes = await Bun.file(binary).arrayBuffer();
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Flags that named a *mechanism* and are refused rather than ignored.
 *
 * A script or a habit that still passes one would otherwise silently build the free edition and ship
 * it as though it were the edition asked for — which is how `--embed-wa-bridge` reached two hosts. The
 * failure mode is what makes this worth a check: a wrong flag does not make a broken build, it makes
 * a *different working build*.
 *
 * `--device-nougate` is on the list for the same reason it was renamed on 2026-09-15: the bundle an
 * edition carries is expected to grow, and a flag called after one of its contents has to be renamed
 * again or lie.
 *
 * A flag whose edition went into another says where it went, in the sentence after "is gone".
 */
const RETIRED_FLAGS: Record<string, string> = {
  "--bundle-wa-bridge": "",
  "--bundle-nougate": "",
  "--embed-wa-bridge": "",
  "--embed-nougate": "",
  "--device-nougate": "",
  // Renamed 2026-09-30 when Device and Cloud became one edition: `--pro`, `--pro-router`.
  "--device": "",
  "--device-pro": "",
  "--cloud": "",
  // 0.7.20: Pro Router became Pro, which carries the gateway (owner, 2026-10-19).
  "--pro-router": "",
  // Router became part of Community (v0.8.28_RFC): the free build carries what `--router` added.
  "--router":
    "The LLM gateway is part of the free build since 0.8.28: `bun run build:binary` carries it, " +
    "and `[nougate] in_process = true` switches it on.",
};

function refuseRetiredFlags(argv: string[], editions: EditionSpec[]): void {
  for (const [gone, instead] of Object.entries(RETIRED_FLAGS)) {
    if (!argv.includes(gone)) continue;
    const offered = editions.map((e) => e.flag || "(none)").join(" | ");
    console.error(`✗ ${gone} is gone.${instead ? ` ${instead}` : ""} This build script makes: ${offered}\n  see docs/ARCHITECTURE.md §10`);
    process.exit(1);
  }
}

/**
 * What this build is called, so the editions can coexist in one `dist/`.
 *
 * They wrote **the same filenames** once — `dist/nouride-linux-x64.tar.gz`
 * whatever the flags were — so building two in one directory left the second
 * silently overwriting the first, and a release publishing all of them could
 * only ever publish one.
 *
 * The free edition keeps the bare name: `install.sh` fetches
 * `nouride-<target>.tar.gz`, and renaming the one build meant to be handed out
 * would break every documented install command to give the others a suffix.
 *
 * `nouride-linux-x64`, `nouride-pro-linux-arm64` — the name comes from `targets.ts`, which the
 * release workflow's asset check is pinned against.
 */
const artifactName = (edition: EditionSpec, target: string): string => name(edition.id as Edition, target);

/**
 * `--smol`, baked into the executable — and `--no-smol` to build without it.
 *
 * `--compile-exec-argv` prepends arguments to the standalone binary's own `execArgv`, so the flag is
 * a property of the build rather than something an operator has to remember at every start. There is
 * no other way to reach it: a compiled binary takes its runtime flags from here.
 *
 * ## The trade, measured rather than assumed
 *
 * Allocation-heavy loop in the shape a turn actually is — build a large prompt, serialise it, parse
 * the tool JSON back, four hundred times:
 *
 * |          | peak RSS | wall time |
 * |----------|----------|-----------|
 * | default  |  51.8 MB |    118 ms |
 * | `--smol` |  36.5 MB |    143 ms |
 *
 * **-29% memory for +21% CPU**, and an idle daemon measures 59.3 MB against 63.7 MB. So it is on by
 * default, because this daemon's design centre is a small box — the same 415 MB Pi and 2 GB LXC that
 * `check-types.ts` sizes its worker pool for — and because a turn's wall time is dominated by waiting
 * on a model, not by local allocation. Twenty percent of the small half of a turn is not felt; fifteen
 * megabytes on a box with 235 MB free is.
 *
 * `--no-smol` is for the opposite case: a build for a host with memory to spare, where the GC
 * frequency is the only thing that changes and it changes for the worse.
 */
const SMOL = !process.argv.includes("--no-smol");

/**
 * The compile flags every build shares.
 *
 * The bridge is never externalised: every edition carries it in-process, so the dynamic
 * `await import("nouride-wa-bridge")` is one the bundler is meant to follow. It costs about 480
 * modules and 14.7 MB against a build that leaves it out, which is what the second executable used
 * to cost on disk anyway — and it buys a tarball with one binary in it.
 */
export function bundleFlags(edition: EditionSpec): string[] {
  return [
    "--target=bun",
    /**
     * Fully minified, names included — so neither the binary nor the image's bundle is a readable copy of the source.
     *
     * 0.7.8 kept the names (`--minify-identifiers` off), because renaming classes renamed errors: a refusal was
     * logged as `jm: [files] path escapes workspace`. What made that true is gone: every error class names itself
     * with a literal (`error-names.test.ts`), and a frame — `/$bunfs/root/nouride:LINE:COL` from a binary,
     * `/app/nouride.bundle.js:LINE:COL` from an image — is turned back into `file:line` and its function by
     * `bun run symbolize`, from the private map written for exactly those bytes (`writePrivateMap`,
     * `writeImageBundle`). `--keep-names` was no middle way: Bun 1.4.2 ignores it beside `--minify-identifiers`.
     *
     * The image's bundle kept its names through the first cut of 0.7.10, until its map could leave the image build
     * (the `source-map` stage in the Dockerfile, read by `release.yml`). The 0.7.8 and 0.7.9 images are the readable
     * ones, and they are what this is for.
     */
    "--minify-syntax",
    "--minify-whitespace",
    "--minify-identifiers",
    /**
     * Everything this edition does **not** bundle, externalised by package name.
     *
     * Derived from `bundles`, not from `excludes`. `excludes` is the list a *public* edition is
     * proven not to contain, and the private editions leave it empty — so keying the flag on it
     * left `nouride-oauth` compiled into a private edition that did not carry it, under a banner
     * saying "no external sign-in".
     * What decides whether a plugin is in the artefact is whether the edition bundles it, and
     * nothing else.
     *
     * A relative path cannot be externalised — that was tried, along with a `--define` guard, and
     * neither prunes one — which is why `modules/users/oidc.ts` imports a package NAME.
     */
    ...OPTIONAL.filter((plugin) => !edition.bundles.includes(plugin)).flatMap((plugin) => [
      "--external",
      plugin.pkg,
    ]),
    /**
     * Baileys' optional peers, in every edition, because the bridge is in every edition. `sharp` is the one that
     * matters — a native module whose loader the bundler would embed — and `bridge-externals.ts` says why that is a
     * crash waiting for a version bump. Only the standalone bridge's build used to pass these, so every daemon carried
     * sharp 0.33.5's loader; `assertAbsent` now fails a build that carries one.
     */
    ...BRIDGE_EXTERNALS.flatMap((peer) => ["--external", peer]),
    /**
     * The edition, stamped into the binary so the running daemon can say which it is.
     *
     * Not an edition boundary — `packages/update` is linked into every edition — but the fact
     * an update needs: `nouride-linux-x64.tar.gz` and `nouride-pro-linux-x64.tar.gz`
     * are different files, and a daemon that guessed would silently replace a Pro
     * build with the free one and take multi-user off the box.
     *
     * `--define` substitutes; it does not prune. That distinction is the whole reason the
     * plugins above use `--external` instead, and it is also why this use of it is sound:
     * a string literal in place of an identifier is all that is being asked for.
     */
    "--define",
    `NOURIDE_BUILD_EDITION=${JSON.stringify(edition.id)}`,
    /**
     * Whether the LLM gateway is in this build, for the daemon to say so (`apps/engine/src/commons/build.ts`). The edition
     * stopped answering it once the free build carried the gateway only when its submodule is checked out: a Community
     * binary from a public clone has none. Defined only when it was linked — absent, the identifier is undeclared, as an
     * unstamped edition's is, and the reader's `typeof` says so.
     */
    ...(edition.bundles.includes(NOUGATE) ? ["--define", `NOURIDE_BUILD_GATEWAY=${JSON.stringify("bundled")}`] : []),
    /**
     * And no path of the checkout it was built in: `__dirname` and `__filename`, which Bun writes as a dependency's
     * absolute path, are defined to one that names no machine (`build-path.ts`). Without it every artefact named its
     * build directory and reproduced only there — a map rebuilt elsewhere was off on those lines.
     */
    ...noBuildPathFlags(),
  ];
}

export function compileFlags(edition: EditionSpec): string[] {
  return [
    "--compile",
    // Nothing from the directory it runs in: Bun reads a `.env` and a `bunfig.toml` from the cwd unless told not to,
    // and a `bunfig.toml` preload is code — one an agent wrote into the install directory ran inside the daemon at
    // its next start. `nouride start` reads the install's own `.env` itself (`config/global/dotenv.ts`).
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...(SMOL ? ["--compile-exec-argv=--smol"] : []),
    ...bundleFlags(edition),
  ];
}

/**
 * The edition as this checkout can build it (`resolveEdition`), or an exit naming what a required plugin lacks.
 *
 * Its frontend too, for the gateway: a tarball made without `internals/nougate/apps/frontend/dist` carries a gateway
 * whose page is a 404, and a release build (`--require-gateway`) is refused rather than shipped that way. The image's
 * kit says the same for the bundle (`scripts/release/image-kit.ts`).
 */
function editionToBuild(selected: EditionSpec, argv: string[], bundleOnly: boolean): EditionSpec {
  try {
    const { edition, notes, required } = resolveEdition(selected, argv, checkedOut);
    for (const note of notes) console.log(note);
    if (required.includes(NOUGATE) && !bundleOnly && !existsSync(NOUGATE_FRONTEND_DIST)) {
      throw new Error(
        `the LLM gateway's frontend is not built (${relative(ROOT, NOUGATE_FRONTEND_DIST)}), and this build must carry it.\n` +
          "  cd internals/nougate/apps/frontend && bun install --frozen-lockfile && bun run build",
      );
    }
    return edition;
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Run a build, given the editions this entry point is allowed to produce.
 *
 * The list is the only thing that differs between the public entry and the private one. Everything
 * here — compiling, staging, tarring, the two artefact checks — names no edition at all, which is
 * what lets the private recipe live in a submodule a public clone does not have.
 */
export async function runBuild(editions: EditionSpec[]): Promise<void> {
const argv = process.argv.slice(2);
refuseRetiredFlags(argv, editions);

/**
 * Every flag this entry point accepts. A typo or a renamed flag is refused rather than ignored — see
 * `assertKnownFlags`, which exists because ignoring one shipped the wrong build shape to two hosts.
 *
 * Built from the editions rather than written out, so the public script cannot accidentally accept
 * `--pro` and the private one cannot forget to.

 */
const KNOWN_FLAGS = [...editionFlags(editions), "--no-smol", "--bundle-only"];

assertKnownFlags(argv, KNOWN_FLAGS);
const targets = parseTargets(argv);
const BUNDLE_ONLY = argv.includes("--bundle-only");
const edition = editionToBuild(selectEdition(argv, editions), argv, BUNDLE_ONLY);

await assertDashboardBuilt();
await buildApplianceSetupUi(edition);
await mkdir(DIST, { recursive: true });

/** The lines under the artefact size, which are the edition's own. */
const banner = edition.banner.map((line) => `\n    ${line}`).join("");

if (BUNDLE_ONLY) {
  const out = join(DIST, "nouride.bundle.js");
  const map = await withPluginsResolvable(edition, () => writeImageBundle(edition, { out }));
  await assertEmbedded(edition, out);
  await assertAbsent(edition, out);
  console.log(
    `\n✓ dist/nouride.bundle.js (${await bytes(out)})\n    JavaScript bundle ready (tests excluded by dependency graph).` +
      `\n    private source map: ${relative(ROOT, map)} (${await bytes(map)}) — never in the image`,
  );
  return;
}

if (targets.length === 0) {
  // Host build: the binary and the dashboard directory side by side, which is the layout
  // `resolveDashboardDist()` looks for. Useful for testing the compiled shape locally.
  const out = join(DIST, "nouride");
  const compile = ["bun", "build", ...compileFlags(edition)];
  const map = await withPluginsResolvable(edition, async () => {
    await run([...compile, "--outfile", out, ENTRY], "compile", undefined, undefined, COMPILE_ATTEMPTS);
    return writePrivateMap(edition, compile, out, null);
  });
  await assertEmbedded(edition, out);
  await assertAbsent(edition, out);
  await rm(join(DIST, "dashboard"), { recursive: true, force: true });
  await cp(DASHBOARD_DIST, join(DIST, "dashboard"), { recursive: true });
  await rm(join(DIST, "skills"), { recursive: true, force: true });
  await cp(BUILTIN_SKILLS, join(DIST, "skills"), { recursive: true });
  const hasHostNougateFrontend = edition.bundles.includes(NOUGATE) && existsSync(NOUGATE_FRONTEND_DIST);
  if (hasHostNougateFrontend) {
    await rm(join(DIST, "frontend"), { recursive: true, force: true });
    await cp(NOUGATE_FRONTEND_DIST, join(DIST, "frontend"), { recursive: true });
  }
  console.log(
    `\n✓ dist/nouride (${await bytes(out)}) + dist/dashboard/ + dist/skills/${hasHostNougateFrontend ? " + dist/frontend/" : ""}` +
      `\n    private source map: ${relative(ROOT, map)} (${await bytes(map)}) — never published` +
      banner +
      (SMOL ? "\n    runs with --smol (lower memory, more GC)" : "\n    built --no-smol"),
  );
  return;
}

for (const target of targets) {
  const stage = join(DIST, artifactName(edition, target));
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const binary = join(stage, "nouride");
  const compile = ["bun", "build", ...compileFlags(edition), `--target=bun-${target}`];
  const map = await withPluginsResolvable(edition, async () => {
    await run([...compile, "--outfile", binary, ENTRY], `compile ${target}`, undefined, undefined, COMPILE_ATTEMPTS);
    return writePrivateMap(edition, compile, binary, target);
  });
  await assertEmbedded(edition, binary);
  await assertAbsent(edition, binary);
  await cp(DASHBOARD_DIST, join(stage, "dashboard"), { recursive: true });

  // The annotated config travels with the binary. Without it the operator has the daemon and no copy
  // of the file every setting is documented in — it lives in the repo, and the repo is not on the
  // server. The daemon boots without it (built-in defaults), so this is a reference, not a step.
  await cp(join(ROOT, "config.example.toml"), join(stage, "config.example.toml"));
  await cp(BUILTIN_SKILLS, join(stage, "skills"), { recursive: true });
  // `nouride-pkg` and its units — the root half of `packages/system-packages` — which `install.sh
  // --allow-packages` installs as root. Scripts, not compiled: they are what runs as root, so they
  // ship in a form an operator can read before running the installer.
  await cp(join(ROOT, "packages", "system-packages", "root"), join(stage, "pkg"), { recursive: true });
  // `nouride-run`, the helper that runs each agent's commands as its own user, which `install.sh` installs as root —
  // every Linux target, and a release without it is refused here rather than an install that quietly runs without it.
  const helper = rustTarget(target) ? await nourideRunFor(target) : null;
  if (helper) {
    await mkdir(join(stage, "run"), { recursive: true });
    await cp(helper, join(stage, "run", "nouride-run"));
  }
  const hasNougateFrontend = edition.bundles.includes(NOUGATE) && existsSync(NOUGATE_FRONTEND_DIST);
  if (hasNougateFrontend) {
    await cp(NOUGATE_FRONTEND_DIST, join(stage, "frontend"), { recursive: true });
  }


  // A tarball because the artifact is two paths, and "scp one file" should stay true. `-C` so the
  // archive contains `nouride` and `dashboard/` at its root rather than the staging path.
  //
  // The two macOS-only flags keep the archive clean when it is built on a laptop: bsdtar otherwise
  // writes Apple extended headers that GNU tar warns about on every entry, plus an AppleDouble `._`
  // file beside each real one. Harmless, and it means the first thing an operator sees on the server
  // is six lines of `tar: Ignoring unknown extended header keyword`, which reads like a broken
  // download. Both are no-ops for GNU tar in CI.
  const tarball = `${stage}.tar.gz`;
  const tarItems = ["nouride", "dashboard", "skills", "pkg", ...(helper ? ["run"] : []), "config.example.toml"];
  if (hasNougateFrontend) {
    tarItems.push("frontend");
  }
  await run(
    [
      "tar",
      "--no-xattrs",
      "-czf",
      tarball,
      "-C",
      stage,
      ...tarItems,
    ],
    `package ${target}`,
    { COPYFILE_DISABLE: "1" },
  );
  await assertTarballCarriesNoMap(tarball);

  // Says what is inside, because "did the bridge make it in" is the question a release build has to
  // answer without anyone unpacking the tarball to check.
  console.log(
    `✓ ${target}: dist/${artifactName(edition, target)}/ and .tar.gz (${await bytes(tarball)})` +
      `\n    binary + dashboard + skills + pkg${helper ? " + run (nouride-run)" : ""} + config.example.toml${hasNougateFrontend ? " + frontend" : ""}` +
      `\n    private source map: ${relative(ROOT, map)} (${await bytes(map)}) — beside the tarball, never in it` +
      // Which of the three this is, and what it means for the licence. A release that does not say
      // leaves somebody to answer it with `grep`, and the answer they need is on the front of it.
      banner +
      // Which memory profile this binary carries. It cannot be read back off the file, and the two
      // differ by 29% of RSS, so a release that does not say leaves it unanswerable later.
      (SMOL ? "\n    runs with --smol (lower memory, more GC)" : "\n    built --no-smol"),
  );
}
}
