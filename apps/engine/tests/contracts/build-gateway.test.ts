/**
 * The free build carries the LLM gateway, as the Router edition did — when its source is checked out.
 *
 * `internals/nougate` is a private submodule, and a public clone must still build Community: there it is built without
 * the gateway, and says so in one line. A release must never ship without it, so `--require-gateway` turns the missing
 * checkout into a failure, and the release workflow passes it. Whether the gateway was linked is stamped into the
 * artefact (`NOURIDE_BUILD_GATEWAY`), since the edition no longer answers it, and `--router` is refused by name.
 *
 * The entry point is run end to end in a scratch tree that holds only the build scripts, so what is checked out there
 * is the test's to decide; each run stops at the dashboard check, before anything is compiled.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@nouride/runtime";
import { bundleFlags, compileFlags } from "../../../../scripts/build/core.ts";
import { NOUGATE, OAUTH, OPTIONAL, resolveEdition, type PluginSpec } from "../../../../scripts/build/edition.ts";
import { PUBLIC_EDITIONS } from "../../../../scripts/build/editions.ts";

const ROOT = join(import.meta.dir, "../../../..");
const BASIC = PUBLIC_EDITIONS.find((edition) => edition.id === "basic")!;
const present = (...plugins: PluginSpec[]) => (plugin: PluginSpec) => plugins.includes(plugin);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("which build the free edition is", () => {
  test("with the gateway checked out it is carried, bannered first, and nothing is said", () => {
    const built = resolveEdition(BASIC, [], present(NOUGATE));
    expect(built.edition.bundles).toEqual([NOUGATE]);
    expect(built.edition.banner[0]).toBe("LLM gateway bundled in — set `[nougate] in_process = true` to use it");
    expect(built.notes).toEqual([]);
    // Resolved, so nothing after it can read the conditional list and decide a second way.
    expect("ifCheckedOut" in built.edition).toBe(false);
  });

  test("without it the edition is built without it, and says so in one plain line", () => {
    const built = resolveEdition(BASIC, [], present());
    expect(built.edition.bundles).toEqual([]);
    expect(built.edition.banner[0]).toStartWith("no LLM gateway — internals/nougate is not checked out");
    expect(built.notes).toEqual([
      "! no LLM gateway — internals/nougate is not checked out; point a provider at one on the network (`git submodule update --init internals/nougate` carries it)",
    ]);
  });

  test("--require-gateway makes the missing checkout fatal, and only that", () => {
    expect(() => resolveEdition(BASIC, ["--require-gateway"], present())).toThrow(
      "--require-gateway: internals/nougate is not checked out, and this build must carry @nouverse/nougate-backend.",
    );
    // Checked out, the flag passes and names what it required.
    expect(resolveEdition(BASIC, ["--require-gateway"], present(NOUGATE)).required).toEqual([NOUGATE]);
    // Another plugin being there is no stand-in for the gateway.
    expect(() => resolveEdition(BASIC, ["--require-gateway"], present(OAUTH))).toThrow("is not checked out");
  });

  test("whether it was linked is what the artefact's flags say: carried and stamped, or external and unstamped", () => {
    const withGateway = bundleFlags(resolveEdition(BASIC, [], present(NOUGATE)).edition).join(" ");
    expect(withGateway).toContain('--define NOURIDE_BUILD_GATEWAY="bundled"');
    expect(withGateway).not.toContain(`--external ${NOUGATE.pkg}`);
    const without = bundleFlags(resolveEdition(BASIC, [], present()).edition).join(" ");
    expect(without).not.toContain("NOURIDE_BUILD_GATEWAY");
    expect(without).toContain(`--external ${NOUGATE.pkg}`);
    // Pro, built by its own entry point through the same core, bundles every optional plugin and is stamped the same.
    const pro = { id: "pro", flag: "--pro", bundles: OPTIONAL, banner: [], public: false };
    expect(bundleFlags(resolveEdition(pro, ["--pro"], present()).edition).join(" ")).toContain('--define NOURIDE_BUILD_GATEWAY="bundled"');
  });
});

describe("the stamp, in a compiled artefact", () => {
  /** A program that says what the stamp is, compiled with the build's own flags for `edition`. */
  async function stampOf(withGateway: boolean): Promise<string> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nr-gateway-stamp-")));
    dirs.push(dir);
    writeFileSync(
      join(dir, "main.ts"),
      'declare const NOURIDE_BUILD_GATEWAY: string;\nconsole.log(typeof NOURIDE_BUILD_GATEWAY === "string" ? NOURIDE_BUILD_GATEWAY : "absent");\n',
    );
    const edition = resolveEdition(BASIC, [], withGateway ? present(NOUGATE) : present()).edition;
    const run = (argv: string[]) => runCommand(argv, { cwd: dir, timeoutMs: 90_000, maxOutputBytes: 64_000, env: process.env as Record<string, string> });
    const built = await run(["bun", "build", ...compileFlags(edition), "--outfile", "stamped", "main.ts"]);
    expect(built.exitCode).toBe(0);
    return (await run([join(dir, "stamped")])).stdout.trim();
  }

  test("is `bundled` in a build that linked the gateway, and absent in one that did not", async () => {
    expect(await stampOf(true)).toBe("bundled");
    expect(await stampOf(false)).toBe("absent");
  }, 180_000);
});

describe("the entry point, in a tree where the test decides what is checked out", () => {
  /** The build scripts alone, with `internals/nougate` empty as a public clone has it, or holding what `with` names. */
  function tree(withBackend = false, withFrontend = false): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nr-gateway-tree-")));
    dirs.push(dir);
    mkdirSync(join(dir, "scripts"));
    for (const path of ["build-binary.ts", "build", "bridge-externals.ts", "targets.ts"]) {
      cpSync(join(ROOT, "scripts", path), join(dir, "scripts", path), { recursive: true });
    }
    mkdirSync(join(dir, "internals/nougate"), { recursive: true });
    if (withBackend) {
      mkdirSync(join(dir, "internals/nougate/apps/backend"), { recursive: true });
      writeFileSync(join(dir, "internals/nougate/apps/backend/package.json"), '{"name":"@nouverse/nougate-backend"}');
    }
    if (withFrontend) mkdirSync(join(dir, "internals/nougate/apps/frontend/dist"), { recursive: true });
    return dir;
  }

  const build = (dir: string, ...flags: string[]) =>
    runCommand(["bun", join(dir, "scripts/build-binary.ts"), ...flags], {
      cwd: dir,
      timeoutMs: 25_000,
      maxOutputBytes: 64_000,
      env: process.env as Record<string, string>,
    });

  test("a public clone builds Community without the gateway: one line, then on to the build", async () => {
    const result = await build(tree());
    expect(result.stdout).toContain("! no LLM gateway — internals/nougate is not checked out");
    // It went past the gateway: what stops it is the scratch tree having no dashboard, the next check.
    expect(result.stderr).toContain("no dashboard build");
    expect(result.exitCode).toBe(1);
  }, 30_000);

  test("--require-gateway stops it before anything else, naming the command that fetches the source", async () => {
    const result = await build(tree(), "--require-gateway");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("✗ --require-gateway: internals/nougate is not checked out");
    expect(result.stderr).toContain("git submodule update --init internals/nougate");
    expect(result.stderr).not.toContain("no dashboard build");
  }, 30_000);

  test("--require-gateway wants the gateway's frontend too, and passes once both are there", async () => {
    const noFrontend = await build(tree(true), "--require-gateway");
    expect(noFrontend.stderr).toContain("the LLM gateway's frontend is not built");
    expect(noFrontend.stderr).not.toContain("no dashboard build");
    const both = await build(tree(true, true), "--require-gateway");
    expect(both.stderr).not.toContain("LLM gateway");
    expect(both.stdout).not.toContain("! no LLM gateway");
    expect(both.stderr).toContain("no dashboard build");
  }, 60_000);

  test("--router is refused by name, saying the gateway is part of the free build — from either entry point", async () => {
    const dir = tree();
    const entries = ["scripts/build-binary.ts"];
    // The private entry point, where it is checked out, beside the scripts its relative import reaches in this tree.
    const pro = join(ROOT, "internals/pro/packages/build-pro");
    if (existsSync(join(pro, "build.ts"))) {
      mkdirSync(join(dir, "internals/pro/packages/build-pro"), { recursive: true });
      for (const file of ["build.ts", "editions.ts"]) cpSync(join(pro, file), join(dir, "internals/pro/packages/build-pro", file));
      entries.push("internals/pro/packages/build-pro/build.ts");
    }
    for (const entry of entries) {
      const result = await runCommand(["bun", join(dir, entry), "--target", "linux-x64", "--router"], {
        cwd: dir,
        timeoutMs: 25_000,
        maxOutputBytes: 64_000,
        env: process.env as Record<string, string>,
      });
      expect({ entry, exit: result.exitCode }).toEqual({ entry, exit: 1 });
      expect(result.stderr).toContain("✗ --router is gone. The LLM gateway is part of the free build since 0.8.28");
      expect(result.stderr).toContain("`[nougate] in_process = true` switches it on");
    }
  }, 60_000);
});
