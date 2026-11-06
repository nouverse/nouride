/**
 * A release's upgrade floor, from its notes to its signed checksum files.
 *
 * Declared as `min-version:` in the front matter of `docs/releases/<tag>.md`; the release workflow's Checksums step
 * writes `# nouride-min-version: <version>` into each checksum file `binaries` makes (`release-floor.ts`), and the
 * `sign` job signs the file with the line in it. Here a fake release tree — the script, a notes file, two tarballs — is
 * run through the step exactly as the workflow spells it, and the result is signed by `sign-checksums.sh` and verified
 * the way an update verifies it. The release pages never show the front matter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNotes, withFloorLine } from "../../../../scripts/release/release-floor.ts";
import { releaseBodies } from "../../../../scripts/release/release-notes.ts";
import { releaseFloor } from "../../../../packages/update/src/floor.ts";
import { verifyChecksums } from "../../../../packages/update/src/signing.ts";
import { UPGRADE_FLOOR } from "@/commons/upgrade-floor.ts";

const ROOT = join(import.meta.dir, "../../../..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

/** The `run:` of the binaries job's Checksums step, as the workflow has it. */
function checksumsStep(variant: string): string {
  const from = WORKFLOW.indexOf("      - name: Checksums\n");
  const run = WORKFLOW.slice(WORKFLOW.indexOf("run: |\n", from) + "run: |\n".length, WORKFLOW.indexOf("\n\n", from));
  return run
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
    .replace("${{ matrix.variant && format('-{0}', matrix.variant) || '' }}", variant ? `-${variant}` : "");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A release tree: the step's scripts where the workflow finds them, the tag's notes when given, and a dist/ of tarballs. */
function fakeRelease(notes: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "nouride-release-floor-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts/release"), { recursive: true });
  copyFileSync(join(ROOT, "scripts/release/release-floor.ts"), join(root, "scripts/release/release-floor.ts"));
  mkdirSync(join(root, "docs/releases"), { recursive: true });
  if (notes !== null) writeFileSync(join(root, "docs/releases/v9.9.0.md"), notes);
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/nouride-linux-x64.tar.gz"), "one");
  writeFileSync(join(root, "dist/nouride-linux-arm64.tar.gz"), "two");
  return root;
}

function runStep(root: string, ref: { type: string; name: string }, variant = ""): { status: number; out: string } {
  const result = spawnSync("sh", ["-ec", checksumsStep(variant)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_TYPE: ref.type, GITHUB_REF_NAME: ref.name },
  });
  return { status: result.status ?? -1, out: result.stdout + result.stderr };
}

const NOTES = "---\nmin-version: 0.7.14\n---\n\n**0.8.0 upgrades from 0.7.14 only.**\n";

describe("the notes' front matter", () => {
  test("declares the floor, and the body is what follows it", () => {
    expect(parseNotes(NOTES)).toEqual({ floor: "0.7.14", body: "**0.8.0 upgrades from 0.7.14 only.**\n" });
    expect(parseNotes("These notes cover everything since 0.7.10.\n")).toEqual({ floor: null, body: "These notes cover everything since 0.7.10.\n" });
  });

  test("refuses a key it does not read, and a floor that is not a release version", () => {
    expect(() => parseNotes("---\nmin_version: 0.7.14\n---\n")).toThrow("the one key it takes is `min-version`");
    expect(() => parseNotes("---\nmin-version: v0.7.14\n---\n")).toThrow("is not a release version");
  });

  test("of every release's notes in the tree reads, and 0.7.11 sets no floor", () => {
    for (const file of readdirSync(join(ROOT, "docs/releases"))) parseNotes(readFileSync(join(ROOT, "docs/releases", file), "utf8"));
    expect(parseNotes(readFileSync(join(ROOT, "docs/releases/v0.7.11.md"), "utf8")).floor).toBeNull();
  });

  /**
   * The floor the daemon refuses below (`commons/upgrade-floor.ts`) reaches an updater only through this line. Notes of
   * a release after the floor that left it out would publish that release with no floor: a 0.7.29 updater would take it
   * straight away, and the daemon would refuse the data it landed on.
   */
  test("of every release after the floor declares the floor the daemon enforces", () => {
    const numbers = (version: string) => version.split(".").map(Number);
    const after = (version: string) => {
      const [a, b] = [numbers(version), numbers(UPGRADE_FLOOR)];
      const i = a.findIndex((n, at) => n !== b[at]);
      return i !== -1 && a[i]! > b[i]!;
    };
    const releases = readdirSync(join(ROOT, "docs/releases"))
      .map((file) => /^v(\d+\.\d+\.\d+)\.md$/.exec(file)?.[1])
      .filter((version): version is string => version !== undefined && after(version));
    expect(releases).toContain("0.8.1");
    for (const version of releases) {
      const { floor } = parseNotes(readFileSync(join(ROOT, `docs/releases/v${version}.md`), "utf8"));
      expect({ version, floor }).toEqual({ version, floor: UPGRADE_FLOOR });
    }
  });

  test("is not on either release page", () => {
    const bodies = releaseBodies({ tag: "v9.9.0", previous: "v9.8.0", repo: "o/internal", publicRepo: "o/public", notes: NOTES, subjects: [] });
    for (const page of [bodies.internal, bodies.public]) {
      expect(page).not.toContain("min-version");
      expect(page).toStartWith("**0.8.0 upgrades from 0.7.14 only.**");
    }
  });
});

describe("the Checksums step, on a fake release", () => {
  test("writes the declared floor into the checksum file, above the checksums", () => {
    const root = fakeRelease(NOTES);
    expect(runStep(root, { type: "tag", name: "v9.9.0" }).status).toBe(0);
    const sums = readFileSync(join(root, "dist/CHECKSUMS"), "utf8").split("\n");
    expect(sums[0]).toBe("# nouride-min-version: 0.7.14");
    expect(sums.slice(1).filter(Boolean).map((line) => line.split(/\s+/)[1])).toEqual(["./nouride-linux-arm64.tar.gz", "./nouride-linux-x64.tar.gz"]);
  });

  test("and into an edition's own file", () => {
    const root = fakeRelease(NOTES);
    runStep(root, { type: "tag", name: "v9.9.0" }, "pro");
    expect(releaseFloor(readFileSync(join(root, "dist/CHECKSUMS-pro"), "utf8"))).toBe("0.7.14");
  });

  test("writes none for a release that declares none, or has no notes, or for a run that is not a tag", () => {
    for (const [notes, ref] of [
      ["Just notes.\n", { type: "tag", name: "v9.9.0" }],
      [null, { type: "tag", name: "v9.9.0" }],
      [NOTES, { type: "branch", name: "main" }],
    ] as const) {
      const root = fakeRelease(notes);
      expect(runStep(root, ref).status).toBe(0);
      expect(releaseFloor(readFileSync(join(root, "dist/CHECKSUMS"), "utf8"))).toBeNull();
    }
  });

  test("fails the build on a floor it cannot use, rather than publishing a release without it", () => {
    const root = fakeRelease("---\nmin-version: 0.8\n---\n");
    expect(runStep(root, { type: "tag", name: "v9.9.0" }).status).not.toBe(0);
  });

  test("never writes a second floor line", () => {
    expect(() => withFloorLine(withFloorLine("aa  ./x.tar.gz\n", "0.7.14"), "0.7.14")).toThrow("already declares a floor");
  });
});

const rawin = spawnSync("openssl", ["pkeyutl", "-help"], { encoding: "utf8" });
describe.skipIf(!`${rawin.stdout}${rawin.stderr}`.includes("-rawin"))("the sign job, on that file", () => {
  test("signs it with the line in it: the signature verifies, and stops verifying if the floor is changed or dropped", () => {
    const root = fakeRelease(NOTES);
    runStep(root, { type: "tag", name: "v9.9.0" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(join(root, "install.sh"), `#!/bin/sh\n# >>> release keys\nRELEASE_KEYS='${publicPem.trim()}'\n# <<< release keys\n`);
    const sums = join(root, "dist/CHECKSUMS");
    const signed = spawnSync("sh", [join(ROOT, "scripts/release/sign-checksums.sh"), sums], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), RELEASE_KEYS_FROM: join(root, "install.sh") },
    });
    expect(signed.status).toBe(0);
    const text = readFileSync(sums, "utf8");
    const sig = readFileSync(`${sums}.sig`, "utf8");
    expect(text).toStartWith("# nouride-min-version: 0.7.14\n");
    expect(verifyChecksums(text, sig, [publicPem])).toBe(true);
    expect(verifyChecksums(text.replace("0.7.14", "0.7.10"), sig, [publicPem])).toBe(false);
    expect(verifyChecksums(text.replace("# nouride-min-version: 0.7.14\n", ""), sig, [publicPem])).toBe(false);
  });
});
