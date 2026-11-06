/**
 * The build scripts refuse a flag they do not know.
 *
 * Added after a deploy went out with `--embed-wa-bridge`, renamed to `--bundle-wa-bridge` some time
 * earlier. Nothing rejected it: the build quietly produced the *default* shape — the WhatsApp bridge
 * as a separate process — against two hosts configured for `inproc`, and the difference first showed
 * up in production as a gateway that reconnected five times and died.
 *
 * A wrong flag does not make a broken build. It makes a *different working build*, which is why
 * this needs a check rather than care: the only clue at the console was a tarball that had grown
 * from 41MB to 72MB, and nobody reads that.
 */

import { describe, expect, test } from "bun:test";
import { runCommand } from "@nouride/runtime";
import { artifactName, EDITIONS, parseTargets, unknownFlags } from "../../../../scripts/targets.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editionLabel } from "@/commons/build.ts";
import { sleep } from "../wait.ts";

const KNOWN = ["--pro", "--router", "--no-smol"] as const;

describe("unknownFlags", () => {
  test("the renamed flag that caused this is caught", () => {
    expect(unknownFlags(["--target", "linux-x64", "--embed-wa-bridge"], KNOWN)).toEqual([
      "--embed-wa-bridge",
    ]);
  });

  test("known flags and no flags are both fine", () => {
    expect(unknownFlags(["--target", "linux-x64", "--pro", "--no-smol"], KNOWN)).toEqual([]);
    expect(unknownFlags([], KNOWN)).toEqual([]);
  });

  test("a `--target` value is not mistaken for a flag", () => {
    /**
     * The one positional that follows a flag. `linux-x64` has no leading dash so a naive scan would
     * pass today — but a target name with one would turn a correct command into an error, which is
     * a worse failure than the one this guards against.
     */
    expect(unknownFlags(["--target", "-weird-name"], KNOWN)).toEqual([]);
  });

  test("every unknown flag is listed, not only the first", () => {
    // Two typos in one command is somebody guessing at the interface, and naming one sends them
    // round again.
    expect(unknownFlags(["--nope", "--also-nope"], KNOWN)).toEqual(["--nope", "--also-nope"]);
  });

  test("a bad target is not this function's business", () => {
    // `unknownFlags` is about flags, `parseTargets` about one flag's value. Overlapping them would
    // give two different errors for one mistake.
    expect(unknownFlags(["--target", "not-a-target"], KNOWN)).toEqual([]);
  });
});

describe("the build script exits on one", () => {
  test("a renamed flag fails the build rather than changing its shape", async () => {
    /**
     * End to end, because the wiring is the half that failed: `unknownFlags` being right is no help
     * if the build never calls it (`assertKnownFlags`, from `scripts/build/core.ts`), and that is exactly the shape of the original bug — a

     * check that was not there rather than one that was wrong.
     *
     * Through `runCommand` rather than `Bun.spawn`: `Bun.*` belongs to `packages/runtime` and the
     * rule holds in tests too (TD-001).
     */
    const result = await runCommand(
      ["bun", "scripts/build-binary.ts", "--target", "linux-x64", "--embed-wa-bridge"],
      {
        cwd: new URL("../../../..", import.meta.url).pathname,
        timeoutMs: 25_000,
        maxOutputBytes: 64_000,
        // Inherited: the child is `bun`, which needs PATH and HOME to resolve itself at all.
        env: process.env as Record<string, string>,
      },
    );

    expect(result.exitCode).toBe(1);
    // Naming what *does* exist is the half that saves the next person a search.
    // The retired name is NAMED in the refusal, not merely reported as unknown:
    // a script that still passes it would otherwise build the free edition and
    // ship it as though it were the device one.
    expect(result.stderr).toMatch(/--(embed|bundle)-wa-bridge is gone/);
    // And it stopped before doing any work: a build that got as far as compiling would have said so.
    expect(result.stdout).not.toContain("compile");
  }, 30_000);

  test("--pro-router is refused by name, from either entry point", async () => {
    // Pro Router became Pro in 0.7.20: a script still passing the flag builds nothing rather than something else.
    const root = new URL("../../../..", import.meta.url).pathname;
    const entries = ["scripts/build-binary.ts", ...(existsSync(join(root, "internals/pro/build-pro/build.ts")) ? ["internals/pro/build-pro/build.ts"] : [])];
    for (const entry of entries) {
      const result = await runCommand(["bun", entry, "--target", "linux-x64", "--pro-router"], {
        cwd: root,
        timeoutMs: 25_000,
        maxOutputBytes: 64_000,
        env: process.env as Record<string, string>,
      });
      expect({ entry, exit: result.exitCode }).toEqual({ entry, exit: 1 });
      expect(result.stderr).toContain("--pro-router is gone.");
      expect(result.stdout).not.toContain("compile");
    }
  }, 60_000);
});

describe("parseTargets still works alongside it", () => {
  test("known targets pass through, `all` expands, nothing means the host", () => {
    expect(parseTargets(["--target", "linux-arm64"])).toEqual(["linux-arm64"]);
    expect(parseTargets(["--target", "all"]).length).toBeGreaterThan(1);
    expect(parseTargets([])).toEqual([]);
  });

  test("a release builds every Linux shape and macOS on Apple Silicon — not an Intel Mac", () => {
    // Owner's decision, 2026-10-19: darwin-arm64 is published, darwin-x64 stays buildable by name and is not.
    expect(parseTargets(["--target", "all"])).toEqual(["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-arm64"]);
    expect(parseTargets(["--target", "darwin-x64"])).toEqual(["darwin-x64"]);
  });
});

/**
 * What an edition is called when a person reads it.
 *
 * The ids are build flags, and `basic` is the one that must never be printed: it reads as "cut
 * down" for the edition nearly everybody runs, which the product calls Community everywhere else.
 */
describe("editionLabel", () => {
  test("every shipped edition has the name the product uses", () => {
    expect(editionLabel("basic")).toBe("Community");
    expect(editionLabel("router")).toBe("Router");
    expect(editionLabel("pro")).toBe("Pro");
  });

  test("a build flag is never the name", () => {
    // The failure this guards: a mapping gap falling through to the id, so `/status` prints
    // "v0.4.5 basic" — the one word the edition is never called.
    for (const edition of ["basic", "router", "pro"] as const) {
      expect(editionLabel(edition)).not.toBe(edition);
    }
  });

  test("an unstamped build has no name, rather than a wrong one", () => {
    // A source checkout is not an edition. `null` lets the caller say that instead of labelling it.
    expect(editionLabel("unknown")).toBeNull();
  });
});

/**
 * The release workflow checks the published assets by name, and that check had gone stale silently.
 *
 * `--device-nougate` became `--pro-router` on 2026-09-15 and the artefacts became
 * `nouride-pro-router-*`. The workflow went on grepping for `nouride-nougate-*` — a name the builder
 * has never produced under any scheme — so **every** tagged release finished by announcing "the
 * nougate variants are not on this release. They need SUBMODULE_TOKEN", while the job that needs
 * that secret had succeeded and its own log read "LLM gateway bundled in". Observed on v0.4.7.
 *
 * A warning that is always wrong is worse than no warning: it sends whoever reads it to re-run jobs
 * that worked, and it trains the next person to skip the annotations.
 */
describe("the release workflow looks for assets the build actually makes", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
  const AUDIT = join(import.meta.dir, "../../../../scripts/release/check-private-editions.sh");
  const LINUX = ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"];

  /** The workflow's plan, by row: the variant, and whether it is private (the fifth field). */
  const rows = [...workflow.matchAll(/^\s+\("([a-z-]*)",\s+"[^"]*",\s+(?:None|"[^"]*"),\s+(?:None|"[^"]*"),\s+(True|False),/gm)].map(
    (m) => ({ variant: m[1]!, private: m[2] === "True" }),
  );
  const privateVariants = rows.filter((row) => row.private).map((row) => row.variant);
  /** Every file a release of these editions carries, as the build and the `sign` job name them. */
  const assetsOf = (variants: readonly string[], { signed = true } = {}) =>
    EDITIONS.filter((edition) => variants.includes(edition === "basic" ? "" : edition)).flatMap((edition) => [
      ...LINUX.map((target) => `${artifactName(edition, target)}.tar.gz`),
      ...(edition === "basic" ? ["CHECKSUMS"] : [`CHECKSUMS-${edition}`]),
      ...(signed ? [edition === "basic" ? "CHECKSUMS.sig" : `CHECKSUMS-${edition}.sig`] : []),
    ]);
  const audit = (env: Record<string, string>) =>
    spawnSync("sh", [AUDIT], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PUBLISH_PRIVATE: "true", ...env } });

  test("the plan's private rows are the Pro editions the build makes", () => {
    // One since 0.7.20, when Pro Router became Pro.
    expect(privateVariants).toEqual(["pro"]);
    for (const variant of privateVariants) expect((EDITIONS as readonly string[]).includes(variant)).toBe(true);
  });

  test("a release carrying every planned Pro edition passes, by the names `artifactName` gives them", () => {
    const run = audit({ PRIVATE_VARIANTS: privateVariants.join(" "), ASSETS: assetsOf(["", "router", ...privateVariants]).join(" ") });
    expect(run.stdout).toContain("nouride-pro: on the release");
    expect(run.status).toBe(0);
  });

  test("a Pro edition whose checksum file has no signature beside it fails, and names the job that signs it", () => {
    // The sign job signed the private checksum files for the box channel and uploaded no `.sig` to the internal
    // release, so every Pro `--tarball` install from there, up to 0.7.9, was checked against a file nothing vouched for.
    const run = audit({ PRIVATE_VARIANTS: "pro", ASSETS: [...assetsOf([""]), ...assetsOf(["pro"], { signed: false })].join(" ") });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error::CHECKSUMS-pro has no signature beside it on this release: read the sign job");
    // And the sign job is what puts it there, on the internal release, with the token that may write it.
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    const sign = workflow.slice(workflow.indexOf("- name: Sign the private checksum files"), workflow.indexOf("- name: Publish for boxes"));
    expect(sign).toContain('gh release upload "${GITHUB_REF_NAME}" private/*.sig --repo "${GITHUB_REPOSITORY}" --clobber');
    expect(sign.indexOf("sign-checksums.sh")).toBeLessThan(sign.indexOf("private/*.sig --repo"));
    expect(workflow).toMatch(/\n {2}sign:\n(?:.*\n)*? {6}contents: write #/);
  });

  test("a missing Pro edition is named — and files under Pro Router's old name do not stand in for Pro's", () => {
    // `nouride-pro-router-linux-x64` starts with `nouride-pro-`: a pattern that stopped there would read Pro as present.
    const old = [...LINUX.map((target) => `nouride-pro-router-${target}.tar.gz`), "CHECKSUMS-pro-router", "CHECKSUMS-pro-router.sig"];
    const run = audit({ PRIVATE_VARIANTS: "pro", ASSETS: [...assetsOf([""]), ...old].join(" ") });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error::nouride-pro was planned and is not on this release");
    expect(run.stdout).toContain("binaries (pro)");
  });

  test("a tag that planned none fails, and names the variable that did it rather than a secret", () => {
    // The five releases with no Pro edition, 0.6.x to 0.7.1: RELEASE_VARIANTS was unset, and the only line in the run
    // said SUBMODULE_TOKEN.
    const run = audit({ PRIVATE_VARIANTS: "", ASSETS: assetsOf(["", "router"]).join(" "), RELEASE_VARIANTS: "public" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("RELEASE_VARIANTS is 'public'");
    expect(run.stdout).not.toContain("SUBMODULE_TOKEN");
  });

  test("[public-only] in the tag message is the one way to leave them out on purpose", () => {
    const run = audit({ PRIVATE_VARIANTS: "", ASSETS: assetsOf([""]).join(" "), PUBLIC_ONLY: "yes" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[public-only]");
  });

  test("a tag builds every edition unless told otherwise, and the audit is told what was planned", () => {
    // Was `… || vars.RELEASE_VARIANTS || 'public'`: the fleet's updates hung on a variable outside version control.
    expect(workflow).toContain(
      "WANT: ${{ github.event_name == 'workflow_dispatch' && inputs.variants || steps.quiet.outputs.public_only == 'yes' && 'public' || vars.RELEASE_VARIANTS || 'all' }}",
    );
    // A dispatch still defaults to the public rows: it is the run somebody uses to check the pipeline.
    expect(workflow).toMatch(/variants:\n(?:\s+.*\n)*?\s+default: public\n/);
    expect(workflow).toContain('print("private_variants=" + " ".join(r[0] for r in keep if r[4]))');
    expect(workflow).toContain("PRIVATE_VARIANTS: ${{ needs.guard-visibility.outputs.private_variants }}");
    expect(workflow).toContain("sh scripts/release/check-private-editions.sh");
  });

  test("the release page is not given a sentence that is true of every version", () => {
    /**
     * Both halves said nothing, and the public one said it identically every time.
     *
     * The private release asked GitHub to generate notes — which lists merged pull requests, and
     * this repository releases straight from `main`, so v0.4.7 got a bare compare link. The public
     * page, the one somebody installing Nouride actually reads, had it hardcoded: "Official release
     * v0.4.7 for Nouride Linux binaries." True of every release ever made, and therefore useless.
     *
     * Asserted as the absence of the boilerplate plus the presence of the thing that replaced it,
     * because only checking for `--notes-file` would pass on a file built from that same sentence.
     *
     * Two files now, one per release page. They carry the same commits and differ in where the
     * compare link points — the public page's has to reach `nouverse/nouride`, which is the
     * only repository somebody installing Nouride can open. Asserted separately rather than as
     * "contains `--notes-file`", so a change that drops one of the two pages back to a generated
     * note fails here instead of on the next release.
     */
    expect(workflow).not.toContain("Official release ${GITHUB_REF_NAME} for Nouride Linux binaries");
    expect(workflow).toContain("--notes-file /tmp/release-notes-internal.md");
    expect(workflow).toContain("--notes-file /tmp/release-notes-public.md");
    // What goes in those files — the release's own notes, or the commits since the last tag — is
    // `release-notes.test.ts`'s.
  });
});

/**
 * `router` — the free build plus the LLM gateway, and nothing else.
 *
 * It and `pro` carry the same gateway; `pro` adds multi-user on top. The distinction
 * matters because `router` is a public download and `pro` is not, so the line that decides
 * which plugins each one links is the line that decides what gets published.
 *
 * A nougate-only edition existed once and was removed. These assertions are what stop it being
 * quietly dropped a second time.
 */
describe("the router edition", () => {
  test("is a known edition with its own artefact name", () => {
    expect([...EDITIONS]).toContain("router");
    expect(artifactName("router", "linux-x64")).toBe("nouride-router-linux-x64");
    // `basic` is the only one without an infix; two public builds sharing a name would be
    // indistinguishable in a release listing.
    expect(artifactName("basic", "linux-x64")).toBe("nouride-linux-x64");
  });

  test("it bundles the gateway, and the public list is the only place that says so", () => {
    /**
     * Asserted as source because what it decides cannot be read back off a binary — and asserted
     * against `scripts/build/editions.ts` because that file is now the whole public recipe. The
     * five `BUNDLE_*` booleans it replaced had to be edited together and nothing made them agree.
     */
    const editions = readFileSync(join(import.meta.dir, "../../../../scripts/build/editions.ts"), "utf8");
    expect(editions).toContain('id: "router"');
    expect(editions).toContain("bundles: [NOUGATE]");
    // WhatsApp is in `ALWAYS`, not in an edition: it stopped being a switch on 2026-09-16.
    expect(readFileSync(join(import.meta.dir, "../../../../scripts/build/core.ts"), "utf8"))
      .not.toContain("BUNDLE_BRIDGE");
  });

  test("every edition leaves Baileys' optional peers out, and fails a build that carries sharp's loader", async () => {
    // Only the standalone bridge's build passed these, so every daemon carried sharp 0.33.5's loader — the version
    // linked beside Baileys because the site depended on it. A bump to 0.35's static requires would have compiled in
    // the loader whose missing `.node` file is a fatal, uncatchable exit (`bridge-externals.ts`).
    const { bundleFlags } = await import("../../../../scripts/build/core.ts");
    const { PUBLIC_EDITIONS } = await import("../../../../scripts/build/editions.ts");
    const { BRIDGE_EXTERNALS } = await import("../../../../scripts/bridge-externals.ts");
    const { OPTIONAL } = await import("../../../../scripts/build/edition.ts");
    // An edition that bundles every optional plugin, as Pro does: nothing of the edition's own is external.
    const everything = { id: "pro", flag: "--pro", bundles: OPTIONAL, banner: [], public: false };
    for (const edition of [...PUBLIC_EDITIONS, everything]) {
      const flags = bundleFlags(edition).join(" ");
      for (const peer of BRIDGE_EXTERNALS) expect({ edition: edition.id, peer, external: flags.includes(`--external ${peer}`) }).toEqual({ edition: edition.id, peer, external: true });
    }
    const core = readFileSync(join(import.meta.dir, "../../../../scripts/build/core.ts"), "utf8");
    const absent = core.slice(core.indexOf("async function assertAbsent"), core.indexOf("/** The artefact as text"));
    expect(absent).toContain("for (const marker of NATIVE_LOADER_MARKERS) {");
    // Before any early return: an edition that bundles every optional plugin is checked too.
    expect(absent).not.toContain("if (forbidden.length === 0) return;");
  });

  test("the binary reads nothing from the directory it runs in — a bunfig.toml preload there is code", () => {
    // Bun's defaults load a `.env` and a `bunfig.toml` from the cwd into a compiled binary. Measured on Bun 1.4.2: a
    // preload beside it ran, and the `.env`'s PORT moved the CLI; with these two flags, neither.
    const core = readFileSync(join(import.meta.dir, "../../../../scripts/build/core.ts"), "utf8");
    const flags = core.slice(core.indexOf("function compileFlags"), core.indexOf("function compileFlags") + 900);
    expect(flags).toContain('"--no-compile-autoload-dotenv"');
    expect(flags).toContain('"--no-compile-autoload-bunfig"');
  });

  test("it is public, so it is proven to carry no private plugin", () => {
    /**
     * `router` shares a bundle with `pro` and is still grouped with `basic`, because what
     * makes an edition publishable is what it does **not** carry.
     *
     * One field decides it. `bundles` drives the linking, the `--external` flags, and both artefact
     * checks — so a public edition that does not list `MULTI_USER` is externalised and verified
     * without anyone writing a second list. That second list existed for an hour and produced the
     * bug this asserts against: the private editions left it empty, and `--pro` shipped the
     * sign-in flow under a banner saying it had none.
     */
    const core = readFileSync(join(import.meta.dir, "../../../../scripts/build/core.ts"), "utf8");
    expect(core).toContain("OPTIONAL.filter((plugin) => !edition.bundles.includes(plugin))");
    expect(core).toContain("const forbidden = OPTIONAL.filter((plugin) => !edition.bundles.includes(plugin));");
    // And the list it filters is in the public tree, where a public clone can see it.
    //
    // Pinned as a literal on purpose: `forbidden` is derived from it, so a plugin quietly dropped
    // from this array stops being externalised AND stops being checked, in one edit, with nothing
    // else failing. Adding one here is meant to cost a line in this test.
    const spec = readFileSync(join(import.meta.dir, "../../../../scripts/build/edition.ts"), "utf8");
    expect(spec).toContain(
      "export const OPTIONAL: PluginSpec[] = [NOUGATE, OAUTH, MULTI_USER, APPLIANCE];",
    );
    // No public edition carries any private plugin. `APPLIANCE` is here from 2026-09-22: a Basic
    // download must not contain the pairing protocol, the fingerprint derivation or the licence
    // verifier, and this is the assertion that says so in the public tree.
    const editions = readFileSync(join(import.meta.dir, "../../../../scripts/build/editions.ts"), "utf8");
    expect(editions).not.toContain("MULTI_USER");
    expect(editions).not.toContain("OAUTH");
    expect(editions).not.toContain("APPLIANCE");
  });

  test("the public entry point cannot build a private edition", () => {
    // The whole point of the split. `--pro` is not in this list, so `assertKnownFlags`
    // refuses it by name rather than the build quietly producing something else.
    const entry = readFileSync(join(import.meta.dir, "../../../../scripts/build-binary.ts"), "utf8");
    expect(entry).toContain("PUBLIC_EDITIONS");
    expect(entry).not.toContain("--pro");
    expect(entry).not.toContain("--pro");
  });

  test("the release workflow publishes it, and decides that by a flag not by name", () => {
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    expect(workflow).toContain('("router", "--router", "nouride-router", "router", False, NOUGATE,');
    // `matrix.variant == ''` would have kept it private for a reason nobody could point at. The
    // flag was called `gpl` until 2026-09-16, when every edition started bundling WhatsApp and the
    // name stopped describing what it decides — which is whether the artefact may be published.
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/v') && !matrix.private");
    expect(workflow).not.toContain("matrix.gpl");
  });

  test("and it is the only public row that needs anything private", () => {
    /**
     * The last column names the private submodules a variant clones: `internals/pro` (everything the
     * private editions carry, one repository) and `internals/nougate`. A job that clones the wrong set
     * fails three minutes into a build; which features an edition carries is `edition.ts`'s decision.
     *
     * The public rows are the point of asserting it here. `basic` must name nothing, or somebody
     * without access to a private repository cannot build the free edition at all — and no public row
     * may clone `internals/pro`, or it would carry what the private editions sell.
     */
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    expect(workflow).toContain('("",       "",         "nouride",        "basic",  False, "",                 "all"),');
    expect(workflow).toContain('("router", "--router", "nouride-router", "router", False, NOUGATE,            "all"),');
    // Pro is one edition for every Box and pod (0.7.20): a tarball and the private `nouride-pro` image, with the
    // gateway in it. Every Linux target, which is what a Box and a pod are, and macOS on Apple Silicon from 0.8.3 — a
    // Pro server licensed by Nouverse may be a Mac. No Intel Mac, as for the public editions.
    expect(workflow).toContain('("pro",    "--pro",    "nouride-pro",    "pro",    True,  f"{PRO} {NOUGATE}", PRO_TARGETS),');
    const proTargets = /^\s+PRO_TARGETS = "([^"]+)"$/m.exec(workflow)?.[1]?.split(",");
    // An Intel Mac too, for Pro alone (0.8.4): a buyer's Mac was one. The public editions stay Apple Silicon only.
    expect(proTargets).toEqual(["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-arm64", "darwin-x64"]);
    expect(workflow).not.toContain('"pro-router"');
    expect(workflow).not.toContain('"cloud",');
    // Each image is pushed under its own package's name and no other: Pro went to `nouride-cloud` as well until 0.7.11.
    const images = /^ {10}images: \|\n((?: {12}.*\n)+)/m.exec(workflow)?.[1]?.split("\n").filter(Boolean).map((line) => line.trim());
    expect(images).toEqual(["ghcr.io/nouverse/${{ matrix.package }}"]);
    const rows = workflow.split("\n").filter((line) => /^\s+\("/.test(line) && line.includes("PRO"));
    expect(rows.every((line) => line.includes(" True, "))).toBe(true);
    // One step for all of them, driven by that column rather than by a variant name. The token rides
    // on that one command (`git -c`), never `git config --global`: the self-hosted runner keeps ~/.gitconfig.
    expect(workflow).toContain("submodule update --init --depth 1 ${PATHS}");
    expect(workflow).not.toMatch(/^\s*git config --global/m);
    // And the right entry point per row: the public script refuses `--pro-router`, so a row that
    // paired them would fail at the flag check rather than building the wrong thing.
    expect(workflow).toContain('"script": "build:pro" if g else "build:binary"');
    expect(workflow).toContain("bun run ${{ matrix.script }} --target ${{ matrix.targets }}");
  });

  test("a quiet release is a pre-release, never latest, and gets no :latest image", () => {
    /**
     * `nouride update` skips pre-releases and nothing else — a release that is merely "not latest" is
     * still offered to every free install. So quiet has to mean pre-release, on both repositories, and
     * the image's `latest` tag has to be held back too, or `docker pull` finds it.
     */
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("quiet: ${{ steps.quiet.outputs.quiet }}");
    expect(workflow).toContain(`if [ "\${QUIET}" = "yes" ]; then visibility="--prerelease --latest=false"; fi`);
    // The internal release with it; the public one is a draft with it, published by nouverse/nouride with
    // `quiet` passed on — `--prerelease --latest=false` there too.
    expect(workflow.match(/--title "\$\{GITHUB_REF_NAME\}"( --draft)? \$\{visibility\}/g)).toHaveLength(2);
    expect(workflow).toContain(`-f quiet="\${QUIET:-no}"`);
    // A long-term patch is not latest either (0.8.18, `release-lts.test.ts`).
    expect(workflow).toContain(
      "type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') && needs.guard-visibility.outputs.quiet != 'yes' && needs.guard-visibility.outputs.lts != 'yes' }}",
    );
    // And nothing else may add it: metadata-action's default `latest=auto` did, on v0.6.0.
    expect(workflow).toMatch(/flavor: \|\n\s+latest=false/);
  });

  test("a tag the code does not carry as its version is refused before anything is built", () => {
    // The binary reports apps/engine/package.json's version; a box that installs one saying another rolls it back.
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    const guard = workflow.indexOf("- name: The tag is the version the code says");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(workflow.indexOf("\n  binaries:\n"));
    const step = workflow.slice(guard, workflow.indexOf("\n\n", guard));
    for (const file of ["package.json apps/engine/package.json", "apps/site/src/consts.mjs"]) expect(step).toContain(file);
    expect(step).toContain('want="${GITHUB_REF_NAME#v}"');
  });

  test("CI runs on a release branch, on a runner image picked on purpose", () => {
    const ci = readFileSync(join(import.meta.dir, "../../../../.github/workflows/ci.yml"), "utf8");
    // And on a long-term line's maintenance branch (0.8.18, `release-lts.test.ts`).
    expect(ci).toContain('branches: ["main", "releases/**", "lts/**"]');
    for (const name of ["ci.yml", "ci-image.yml", "deploy-site.yml", "release.yml"]) {
      const workflow = readFileSync(join(import.meta.dir, `../../../../.github/workflows/${name}`), "utf8");
      expect(workflow).not.toContain(`'"ubuntu-latest"'`);
    }
  });

  test("only the private rows are signed and published for boxes — signed first, and with no R2 key", () => {
    /**
     * The licensed release channel. A public row reaching the update gate would be a free
     * build offered to boxes; publishing before signing would upload what no box can install. The
     * job uploads on presigned URLs, so no R2 credential may appear in it.
     */
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    const sign = workflow.indexOf("- name: Sign the private checksum files");
    const publish = workflow.indexOf("- name: Publish for boxes");
    expect(sign).toBeGreaterThan(-1);
    expect(sign).toBeLessThan(publish);
    // The private checksum files are the internal release's — never the public ones, which carry no edition suffix.
    expect(workflow.slice(sign, publish)).toContain("--repo \"${GITHUB_REPOSITORY}\" --pattern 'CHECKSUMS-*'");
    expect(workflow.slice(publish, publish + 300)).toContain("if: steps.private.outputs.signed == 'yes'");
    expect(workflow).not.toMatch(/R2_[A-Z_]*(ACCESS|SECRET)/);
  });

  test("the public half is started before the boxes are published — a box channel that refuses holds nothing back", () => {
    // v0.8.0's first full run: the update gate refused `CHECKSUMS-pro`, the step failed, and the step after it — the
    // one that starts nouverse/nouride — never ran, though nothing public depended on the boxes.
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    const signed = workflow.indexOf("- name: Sign the public checksum files");
    const start = workflow.indexOf("- name: Start the public half of the release");
    const publish = workflow.indexOf("- name: Publish for boxes");
    expect(signed).toBeGreaterThan(-1);
    expect(signed).toBeLessThan(start);
    expect(start).toBeLessThan(publish);
  });

  test("a private edition refuses early, and a failed build leaves nothing linked", () => {
    /**
     * Two properties of `withPluginsResolvable`, both found by running it.
     *
     * A missing private submodule used to surface as Bun's `Could not resolve: "nouride-oauth"`
     * after twenty seconds of compile retries — a package nobody mentioned, and advice (`bun
     * install`) that cannot help. It refuses before linking anything now, naming the path.
     *
     * And the links have to come back off on every exit. `scripts/build/core.ts:run` ends a failed compile with
     * `process.exit`, and the refusal above throws mid-loop; both skip a `finally`, and what
     * survived made `lint:types` follow into nougate's source and fail on a clean tree.
     */
    const build = readFileSync(join(import.meta.dir, "../../../../scripts/build/core.ts"), "utf8");
    expect(build).toContain('if (!existsSync(join(target, "package.json")))');
    expect(build).toContain('process.on("exit", cleanup);');
    // Before the linking loop, or the throw leaves whatever was linked before it.
    expect(build.indexOf('process.on("exit", cleanup);')).toBeLessThan(
      build.indexOf("links.push(await linkPlugin("),
    );
  });

  test.skipIf(!existsSync(join(import.meta.dir, "../../../../apps/dashboard/dist/index.html")))(
    "a build stopped by a signal takes its plugin links and its scratch directory with it, and ends with the signal's status",
    async () => {
      // An `exit` handler does not run on SIGINT, SIGTERM or SIGHUP: a Ctrl-C or a cancelled CI step left every plugin
      // linked into the shared node_modules. The compile is held open by a `bun` on PATH that only sleeps — the build
      // spawns `bun build` by name — so the links are certainly there when the signal arrives. So is the scratch
      // directory the image bundle is built in, which holds a source map once the build has run.
      const root = join(import.meta.dir, "../../../..");
      const bin = mkdtempSync(join(tmpdir(), "nouride-fake-bun-"));
      writeFileSync(join(bin, "bun"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
      const link = join(root, "node_modules", "nouride-update");
      const scratch = () => (existsSync(join(root, "dist")) ? readdirSync(join(root, "dist")).filter((name) => name.startsWith(".bundle-")) : []);
      const before = scratch();
      try {
        const build = spawn(process.execPath, ["scripts/build-binary.ts", "--bundle-only"], {
          cwd: root,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
          stdio: "ignore",
        });
        const started = () => existsSync(link) && scratch().length > before.length;
        for (const until = Date.now() + 15_000; !started() && Date.now() < until; ) await sleep(25);
        expect({ linked: existsSync(link), scratch: scratch().length > before.length }).toEqual({ linked: true, scratch: true });
        build.kill("SIGTERM");
        const code = await new Promise<number | null>((resolve) => build.on("exit", (status) => resolve(status)));
        expect({ code, linked: existsSync(link), scratch: scratch() }).toEqual({ code: 143, linked: false, scratch: before });
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("its image is linked to the public repository, not this one", () => {
    /**
     * `org.opencontainers.image.source` decides which repository GitHub attaches a GHCR package to,
     * and therefore who can see it. A public image has to point at `nouverse/nouride`, the public repository.
     *
     * This read `matrix.package == 'nouride'` and so sent `nouride-router` — equally public — to the
     * private repository, where it landed as a package nobody outside could reach. Keyed on
     * `matrix.private` now, which is the field every other public/private decision here uses, so
     * adding a public edition cannot get it wrong by omission.
     */
    const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");
    expect(workflow).toContain(
      "org.opencontainers.image.source=${{ matrix.private && format('https://github.com/{0}', github.repository) || 'https://github.com/nouverse/nouride' }}",
    );
    // The expression, not the prose: the comment above that line names the old form on purpose.
    expect(workflow).not.toContain("${{ matrix.package == 'nouride'");
  });

  test("the installer accepts it and says what it carries", () => {
    const installer = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
    expect(installer).toContain('""|router|pro)');
    // What it carries that the free build does not — WhatsApp is in both, so it is not the answer.
    expect(installer).toContain('router) say "bundled        LLM gateway"');
  });
});
