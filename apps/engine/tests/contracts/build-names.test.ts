/**
 * What a release binary gives away, and what it keeps.
 *
 * Since 0.7.10 the build mangles identifiers again (`bundleFlags`), so the shipped code is not a readable copy of
 * the source: function names and the original file paths are gone, and a frame is `/$bunfs/root/<binary>:L:C`
 * until `bun run symbolize` reads it against the private map. What it must keep is the error's name — the one
 * word a journal line is searched by. 0.7.8 lost it (`jm: [files] path escapes workspace`) because `NourideError`
 * read `new.target.name`; every error class now names itself with a literal (`error-names.test.ts`).
 *
 * Compiled here with the build's own `compileFlags`, so the check is on what ships rather than on the source,
 * where every name is always right.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@nouride/runtime";
import { compileFlags } from "../../../../scripts/build/core.ts";
import { PUBLIC_EDITIONS } from "../../../../scripts/build/editions.ts";

const ROOT = new URL("../../../..", import.meta.url).pathname;
const run = (argv: string[], cwd = ROOT) =>
  runCommand(argv, { cwd, timeoutMs: 90_000, maxOutputBytes: 64_000, env: process.env as Record<string, string> });

describe("a release build", () => {
  test("keeps an error's class name, and gives away no function name and no source path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nr-build-names-"));
    try {
      const entry = join(dir, "names-fixture-entry.ts");
      writeFileSync(
        entry,
        [
          `import { ConfigError, NourideError } from ${JSON.stringify(join(ROOT, "packages/shared/src/errors.ts"))};`,
          `class RefusedHere extends NourideError { override name = "RefusedHere"; }`,
          // Not exported: an entry's exports keep their names by definition, and the daemon's entry exports nothing.
          `function refuseTheRead(): never { throw new RefusedHere("refused", "path escapes workspace"); }`,
          `try { refuseTheRead(); } catch (err) { console.log(String(err)); console.log(String((err as Error).stack).split("\\n")[1] ?? ""); }`,
          `console.log(String(new ConfigError("bad value")));`,
        ].join("\n"),
      );
      const binary = join(dir, "fixture-bin");
      const built = await run(["bun", "build", ...compileFlags(PUBLIC_EDITIONS[0]!), "--outfile", binary, entry]);
      expect(built.exitCode).toBe(0);

      const ran = await run([binary], dir);
      const [refused, frame, config] = ran.stdout.trim().split("\n");
      expect(refused).toBe("RefusedHere: path escapes workspace");
      expect(config).toBe("ConfigError: bad value");
      // The frame is a position in the binary, not a name: `symbolize` is what reads it.
      expect(frame).toMatch(/\/\$bunfs\/root\/fixture-bin:\d+:\d+/);
      expect(frame).not.toContain("refuseTheRead");

      // Asked as booleans: a failed `toContain` on a 60 MB binary prints the binary.
      const shipped = readFileSync(binary).toString("latin1");
      const carries = (token: string) => ({ token, carried: shipped.includes(token) });
      expect(carries("RefusedHere")).toEqual({ token: "RefusedHere", carried: true }); // the literal, which is the point
      for (const token of ["refuseTheRead", "names-fixture-entry", "packages/shared/src/errors.ts", dir]) {
        expect(carries(token)).toEqual({ token, carried: false });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
