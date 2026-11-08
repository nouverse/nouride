/**
 * A free edition's source maps, kept (2026-11-08). This repository went public in 0.8.21, so its release's step for the
 * maps, guarded to a private repository, never ran, and the Pro half builds only Pro: a Community install's stack
 * trace had no map to be read with. From a public repository the maps go to the internal release, nouverse/nouride-pro's
 * for the tag (`scripts/release/to-internal-release.sh`), made there when missing just as the Pro half makes it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@nouride/runtime";

const ROOT = join(import.meta.dir, "../../../..");
const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
const SCRIPT = join(ROOT, "scripts/release/to-internal-release.sh");

/** Each step's text by its `name:`, from its `- ` to the next step's. */
function step(name: string): string {
  const at = release.indexOf(`- name: ${name}\n`);
  if (at < 0) throw new Error(`no step named "${name}"`);
  const next = release.indexOf("\n      - ", at + 1);
  return release.slice(at, next < 0 ? undefined : next);
}

describe("from a public repository, the free editions' maps go to the internal release", () => {
  for (const [name, files] of [
    ["The free editions' source maps, to the internal release", "dist/*.map"],
    ["The image's source map, to the internal release", "dist/*-image.map"],
  ] as const) {
    test(`${name}: on a tag, where the private step does not run, and a failure says so without stopping the release`, () => {
      const text = step(name);
      expect(text).toContain("startsWith(github.ref, 'refs/tags/v')");
      expect(text).toContain("needs.guard-visibility.outputs.publish_private_assets != 'true'");
      expect(text).toContain("GH_TOKEN: ${{ secrets.RELEASES_REPO_TOKEN }}");
      expect(text).toContain(`sh scripts/release/to-internal-release.sh "\${GITHUB_REF_NAME}" "$(git rev-parse HEAD:internals/pro)" ${files}`);
      expect(text).toContain("QUIET: ${{ needs.guard-visibility.outputs.quiet }}");
      expect(text).toContain("LTS: ${{ needs.guard-visibility.outputs.lts }}");
      expect(text).toContain("continue-on-error: true");
      // Said through `error`, as every step says one: written into the script, the runner would echo it on every run
      // that reaches the step (`release-log.test.ts`).
      expect(text).toContain(`error() { printf '::%s::%s\\n' error "$*"; }`);
      expect(text).toMatch(/\|\| \{ error "[^"]+"; exit 1; \}/);
      expect(text).not.toContain("::error::");
    });
  }
});

describe("to-internal-release.sh, against a stand-in gh", () => {
  let dir = "";
  let log = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nouride-free-maps-"));
    log = join(dir, "gh.log");
    // `release view` answers whether the release is there, from a file the test writes; `create` makes it unless told
    // another leg already did (it then fails, as gh does); every call is logged, one line each.
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        `echo "$*" >> "${log}"`,
        'if [ "$1 $2" = "release view" ]; then [ -f "$STANDIN/there" ] && exit 0; exit 1; fi',
        'if [ "$1 $2" = "release create" ]; then if [ -f "$STANDIN/race" ]; then touch "$STANDIN/there"; exit 1; fi; touch "$STANDIN/there"; exit 0; fi',
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(dir, "gh"), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function run(state: { there?: boolean; race?: boolean; env?: Record<string, string> }): Promise<{ code: number; calls: string[] }> {
    rmSync(log, { force: true });
    for (const [file, on] of [["there", state.there], ["race", state.race]] as const) {
      if (on) writeFileSync(join(dir, file), "");
      else rmSync(join(dir, file), { force: true });
    }
    const out = await runCommand(["sh", SCRIPT, "v0.8.23", "abc123", "dist/nouride-linux-x64.map", "dist/nouride-image.map"], {
      cwd: dir,
      env: { PATH: `${dir}:${process.env.PATH}`, STANDIN: dir, ...state.env },
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    return { code: out.exitCode ?? -1, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  }

  const NOTES = "The Pro editions of nouverse/nouride v0.8.23: tarballs, their signed checksum file and source maps.";
  const UPLOAD = "release upload v0.8.23 dist/nouride-linux-x64.map dist/nouride-image.map --repo nouverse/nouride-pro --clobber";

  test("missing: made at the Pro commit, then the maps added", async () => {
    const { code, calls } = await run({});
    expect(code).toBe(0);
    expect(calls).toEqual([
      "release view v0.8.23 --repo nouverse/nouride-pro",
      `release create v0.8.23 --repo nouverse/nouride-pro --target abc123 --title v0.8.23 --notes ${NOTES}`,
      UPLOAD,
    ]);
  });

  test("there already, made by the Pro half: the maps added, nothing made", async () => {
    const { code, calls } = await run({ there: true });
    expect(code).toBe(0);
    expect(calls).toEqual(["release view v0.8.23 --repo nouverse/nouride-pro", UPLOAD]);
  });

  test("made by another leg at the same moment: that one is used", async () => {
    const { code, calls } = await run({ race: true });
    expect(code).toBe(0);
    expect(calls.at(-1)).toBe(UPLOAD);
    expect(calls.filter((call) => call.startsWith("release view"))).toHaveLength(2);
  });

  test("a quiet release is a pre-release and not latest; a long-term patch is not latest", async () => {
    expect((await run({ env: { QUIET: "yes" } })).calls[1]).toContain("--prerelease --latest=false --notes");
    const lts = (await run({ env: { LTS: "yes" } })).calls[1]!;
    expect(lts).toContain("--latest=false --notes");
    expect(lts).not.toContain("--prerelease");
  });

  test("made as the Pro half makes it: the same words, the same visibility", () => {
    const pro = join(ROOT, "internals/pro/.github/workflows/release.yml");
    // Read where the private tree is there (`verify-private`); the public run has no Pro to compare with.
    if (!existsSync(pro)) return;
    const theirs = readFileSync(pro, "utf8");
    const script = readFileSync(SCRIPT, "utf8");
    expect(theirs).toContain('--notes "The Pro editions of nouverse/nouride ${TAG}: tarballs, their signed checksum file and source maps."');
    expect(script).toContain('--notes "The Pro editions of nouverse/nouride ${tag}: tarballs, their signed checksum file and source maps."');
    for (const flags of ['visibility="--prerelease --latest=false"', 'visibility="--latest=false"']) {
      expect(theirs).toContain(flags);
      expect(script).toContain(flags);
    }
  });
});
