/**
 * What a build carries of the machine it ran on: nothing.
 *
 * Bun writes a CommonJS dependency's `__dirname` into the bundle as that dependency's absolute directory, so every
 * binary and image bundle named the checkout it was built in and reproduced only from there — three of the daemon's
 * dependencies read it (`scripts/build/build-path.ts`). A fixture with such a dependency is built here with the build's
 * own flags, from two directories: the output is the same bytes, names neither directory, and the dependency reads the
 * path the build defines. Then the build's own check, which fails an artefact that names its checkout.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@nouride/runtime";
import { BUNDLED_DIR, checkoutPathsIn } from "../../../../scripts/build/build-path.ts";
import { bundleFlags, compileFlags } from "../../../../scripts/build/core.ts";
import { isSkillFile } from "../../../../scripts/build/skills.ts";
import { PUBLIC_EDITIONS } from "../../../../scripts/build/editions.ts";

const run = (argv: string[], cwd: string) =>
  runCommand(argv, { cwd, timeoutMs: 90_000, maxOutputBytes: 64_000, env: process.env as Record<string, string> });

/** A dependency that reads both names, the way pino's transport and discord's worker sharding read `__dirname`. */
const DEPENDENCY = "module.exports = { dir: () => __dirname, file: () => __filename };\n";
const MAIN = 'import dep from "reads-its-dirname";\nconsole.log(JSON.stringify({ dir: dep.dir(), file: dep.file() }));\n';

/** The same fixture in a directory of its own — real paths, as Bun writes them. */
function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nr-build-path-")));
  mkdirSync(join(dir, "node_modules", "reads-its-dirname"), { recursive: true });
  writeFileSync(join(dir, "node_modules/reads-its-dirname/package.json"), JSON.stringify({ name: "reads-its-dirname", main: "index.js" }));
  writeFileSync(join(dir, "node_modules/reads-its-dirname/index.js"), DEPENDENCY);
  writeFileSync(join(dir, "main.ts"), MAIN);
  return dir;
}

const dirs: string[] = [];
/** Asked as booleans: a failed `toContain` on a compiled binary prints the binary. */
const names = (bytes: Buffer, dir: string) => ({ dir, named: bytes.toString("latin1").includes(dir) });
const said = { dir: BUNDLED_DIR, file: `${BUNDLED_DIR}/nouride` };

beforeAll(() => {
  dirs.push(checkout(), checkout());
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("a build from two directories", () => {
  test("bundles to the same bytes, naming neither, and the dependency reads the path the build gives it", async () => {
    const bundles: Buffer[] = [];
    for (const dir of dirs) {
      const built = await run(["bun", "build", ...bundleFlags(PUBLIC_EDITIONS[0]!), "--outdir", "out", "--entry-naming", "x.js", "main.ts"], dir);
      expect(built.exitCode).toBe(0);
      const bundle = readFileSync(join(dir, "out", "x.js"));
      expect(names(bundle, dir)).toEqual({ dir, named: false });
      expect(JSON.parse((await run(["bun", "--no-install", join(dir, "out", "x.js")], dir)).stdout)).toEqual(said);
      bundles.push(bundle);
    }
    expect(bundles[0]!.equals(bundles[1]!)).toBe(true);
  }, 120_000);

  test("compiles to the same binary, naming neither", async () => {
    const binaries: Buffer[] = [];
    for (const dir of dirs) {
      const built = await run(["bun", "build", ...compileFlags(PUBLIC_EDITIONS[0]!), "--outfile", "fixture-bin", "main.ts"], dir);
      expect(built.exitCode).toBe(0);
      const binary = readFileSync(join(dir, "fixture-bin"));
      expect(names(binary, dir)).toEqual({ dir, named: false });
      expect(JSON.parse((await run([join(dir, "fixture-bin")], dir)).stdout)).toEqual(said);
      binaries.push(binary);
    }
    expect(binaries[0]!.equals(binaries[1]!)).toBe(true);
  }, 180_000);
});

describe("the build's check for a checkout path", () => {
  test("finds a path into the checkout, as given or as its real path", () => {
    const text = 'var __dirname="/home/runner/work/nouride/nouride/node_modules/.bun/pino@9/node_modules/pino/lib",x=1;"/srv/real/apps/engine/src/a.ts"';
    expect(checkoutPathsIn(text, ["/home/runner/work/nouride/nouride/", "/srv/real"])).toEqual([
      "/home/runner/work/nouride/nouride/node_modules/.bun/pino@9/node_modules/pino/lib",
      "/srv/real/apps/engine/src/a.ts",
    ]);
  });

  test("finds nothing in an artefact that names none — and the image's own /app/data is not its checkout", () => {
    expect(checkoutPathsIn('const legacy=["/app/data"];const root="/$bunfs/root";', ["/app/"])).toEqual([]);
    expect(checkoutPathsIn("plain code", ["/srv/checkout/nouride"])).toEqual([]);
  });
});

describe("the skills a build carries", () => {
  test("are the tracked ones: Python's cache beside a script stays behind", () => {
    const skills = "/checkout/content/skills";
    expect(isSkillFile(skills)).toBe(true);
    expect(isSkillFile(`${skills}/data-sheets/scripts`)).toBe(true);
    expect(isSkillFile(`${skills}/data-sheets/scripts/chart.py`)).toBe(true);
    expect(isSkillFile(`${skills}/data-sheets/scripts/__pycache__`)).toBe(false);
    expect(isSkillFile(`${skills}/data-sheets/scripts/__pycache__/chart.cpython-312.pyc`)).toBe(false);
    expect(isSkillFile(`${skills}/diagrams/scripts/diagram.pyc`)).toBe(false);
  });
});
