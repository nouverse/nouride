/**
 * Router's names for Community's build: what a Router install already out there needs to keep updating.
 *
 * No Router build is made any more — the free one carries the LLM gateway — but a Router binary asks the public
 * release for its own files by name, and an install that finds none is told it is up to date for good. So every
 * release publishes Community's tarballs again under Router's names, with a checksum file of their own
 * (`scripts/release/router-alias.ts`). Proven here the way that binary takes a release: its updater's own code
 * (`packages/update`, unchanged since the last Router release) picks the release, plans it and installs it, signature,
 * floor and checksum checked; and `install.sh --variant router` verifies the same files the way it does.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { artifactName, checksumName } from "../../../../packages/update/src/edition.ts";
import { releaseFloor } from "../../../../packages/update/src/floor.ts";
import { installStaged } from "../../../../packages/update/src/install.ts";
import { planUpdate } from "../../../../packages/update/src/plan.ts";
import { newestCarrying, type Release } from "../../../../packages/update/src/release.ts";
import { routerChecksums } from "../../../../scripts/release/router-alias.ts";

const ROOT = join(import.meta.dir, "../../../..");
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";
const OPENSSL_3 = spawnSync(SH, ["-c", "openssl pkeyutl -help 2>&1 | grep -q -- -rawin"]).status === 0;
const TAG = "v0.8.29";
const TARGETS = ["linux-x64", "linux-arm64"];
const FLOOR = "0.8.0";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

let root: string;
let dist: string;

/** Community's tarballs and `CHECKSUMS` as the `binaries` job leaves them, its floor line written in; then the step. */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nr-router-alias-"));
  dist = join(root, "dist");
  mkdirSync(dist);
  const lines = [`# nouride-min-version: ${FLOOR}`];
  for (const target of TARGETS) {
    const stage = join(root, `stage-${target}`);
    mkdirSync(join(stage, "dashboard"), { recursive: true });
    writeFileSync(join(stage, "nouride"), `#!/bin/sh\necho community ${target}\n`, { mode: 0o755 });
    writeFileSync(join(stage, "dashboard", "index.html"), "community");
    const tarball = join(dist, `${artifactName("basic", target)}.tar.gz`);
    const packed = spawnSync("tar", ["-czf", tarball, "-C", stage, "nouride", "dashboard"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    expect(packed.status).toBe(0);
    lines.push(`${sha(readFileSync(tarball))}  ./${basename(tarball)}`);
  }
  writeFileSync(join(dist, "CHECKSUMS"), `${lines.join("\n")}\n`);

  // The step, as the workflow runs it.
  const step = spawnSync("bun", ["run", join(ROOT, "scripts/release/router-alias.ts"), dist], { cwd: ROOT, encoding: "utf8" });
  expect({ status: step.status, stderr: step.stderr }).toEqual({ status: 0, stderr: "" });

  // And `sign`, which signs every `CHECKSUMS*` on the release and puts its `.sig` beside it.
  for (const name of readdirSync(dist).filter((file) => file.startsWith("CHECKSUMS"))) {
    writeFileSync(join(dist, `${name}.sig`), `${sign(null, readFileSync(join(dist, name)), privateKey).toString("base64")}\n`);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const assets = () => readdirSync(dist);
const read = (name: string) => readFileSync(join(dist, name), "utf8");

describe("the files", () => {
  test("are Community's, byte for byte, under the names a Router install asks for", () => {
    for (const target of TARGETS) {
      const router = readFileSync(join(dist, `${artifactName("router", target)}.tar.gz`));
      expect(sha(router)).toBe(sha(readFileSync(join(dist, `${artifactName("basic", target)}.tar.gz`))));
    }
    expect(assets()).toContain(checksumName("router", TAG));
    expect(assets()).toContain(`${checksumName("router", TAG)}.sig`);
  });

  test("Router's checksum file is Community's with each name changed and its floor line as it is", () => {
    const router = read(checksumName("router", TAG));
    expect(releaseFloor(router)).toBe(FLOOR);
    expect(router).toBe(read("CHECKSUMS").replaceAll("./nouride-linux-", "./nouride-router-linux-"));
    // Community's own file is untouched: it lists Community's names alone.
    expect(read("CHECKSUMS")).not.toContain("router");
  });

  test("a line it does not know stops it, rather than vouching for an unknown file under another name", () => {
    expect(() => routerChecksums(`${"a".repeat(64)}  ./nouride-image-kit.tar.gz\n`)).toThrow("has a line this does not know");
  });
});

describe("a Router binary's own updater", () => {
  const release: Release = { tag: TAG, publishedAt: null, notesUrl: null, assets: [] };
  const facts = {
    version: "0.8.27",
    edition: "router" as const,
    installDir: "",
    installDirWritable: true,
    supervisor: "systemd",
    restartsOnExit: true,
    compiled: true,
    platform: "linux",
    arch: "x64",
    musl: false,
  };
  /** The release's files from `dist`, by the name at the end of the URL, as the download host serves them. */
  const serve = (async (url: string | URL) => {
    const file = join(dist, String(url).split("/").pop()!);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  test("picks this release: it carries the tarball and the checksum file it looks for", () => {
    const carrying = newestCarrying([{ ...release, assets: assets() }], artifactName("router", "linux-x64"), (tag) => checksumName("router", tag));
    expect(carrying?.tag).toBe(TAG);
    // Without Router's names it would carry nothing for this install — what the alias exists to prevent.
    const communityOnly = assets().filter((name) => !name.includes("router"));
    expect(newestCarrying([{ ...release, assets: communityOnly }], artifactName("router", "linux-x64"), (tag) => checksumName("router", tag))).toBeNull();
  });

  test("plans it with the signature its edition requires, and installs it: signed, past the floor, checksummed", async () => {
    const plan = planUpdate({ facts, tag: TAG, assets: assets() });
    if (!plan.can) throw new Error(`refused: ${plan.reason}`);
    expect(plan.checksumFile).toBe("CHECKSUMS-router");
    expect(plan.tarballUrl).toEndWith(`/${TAG}/nouride-router-linux-x64.tar.gz`);
    expect(plan.signatureUrl).toEndWith(`/${TAG}/CHECKSUMS-router.sig`);

    const installDir = join(root, "install");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "nouride"), "#!/bin/sh\necho router\n", { mode: 0o755 });
    const install = (from: string) =>
      installStaged({
        installDir,
        tarball: join(dist, `${plan.artifact}.tar.gz`),
        swap: ["nouride", "dashboard"],
        checksumUrl: plan.checksumUrl,
        artifact: plan.artifact,
        ...(plan.signatureUrl ? { signatureUrl: plan.signatureUrl } : {}),
        edition: "router",
        tag: TAG,
        from,
        trustedKeys: [PEM],
        host: { platform: "linux", arch: "x64" },
        fetchImpl: serve,
        retryWaitsMs: [0, 0, 0],
      });
    // Below the floor the signed file declares, it is refused before anything moves.
    await expect(install("0.7.29")).rejects.toThrow(`needs ${FLOOR} first`);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("router");
    await install(facts.version);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("community linux-x64");
  });
});

describe("install.sh --variant router", () => {
  const INSTALL = readFileSync(join(ROOT, "scripts/install.sh"), "utf8");
  const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
  const run = (body: string) => {
    const script = `die() { echo "DIE: $*"; exit 1; }\nwarn() { echo "WARN: $*"; }\nRELEASE_KEYS='${PEM.trim()}'\n${between("# >>> verify release\n", "# <<< verify release")}\n${between("# >>> upgrade floor\n", "# <<< upgrade floor")}\n${body}`;
    const result = spawnSync(SH, ["-c", script], { encoding: "utf8" });
    return (result.stdout + result.stderr).trim();
  };

  test.skipIf(!OPENSSL_3)("verifies Router's tarball against Router's checksum file and its signature, and reads its floor", () => {
    const tarball = join(dist, `${artifactName("router", "linux-x64")}.tar.gz`);
    const sums = join(dist, "CHECKSUMS-router");
    expect(run(`verify_release '${tarball}' '${sums}' '${sums}.sig' ${artifactName("router", "linux-x64")} && echo "OK $VERIFIED_SIGNATURE"`)).toBe("OK 1");
    expect(run(`release_floor '${sums}'`)).toBe(FLOOR);
  });
});

describe("the release workflow", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const at = (name: string) => workflow.indexOf(`- name: ${name}`);

  test("makes them for the free row, after its checksums and before the upload whose globs take them", () => {
    expect(workflow).toContain('"router_alias": e == "basic",');
    const step = workflow.slice(at("Router's names, for the Router installs out there"), at("Upload public Linux binaries to distribution repository"));
    expect(step).toContain("if: matrix.router_alias");
    expect(step).toContain("bun run scripts/release/router-alias.ts dist");
    expect(at("Checksums")).toBeLessThan(at("Router's names, for the Router installs out there"));
    expect(at("Router's names, for the Router installs out there")).toBeLessThan(at("Upload public Linux binaries to distribution repository"));
    expect(workflow).toContain('gh release upload "${GITHUB_REF_NAME}" dist/*.tar.gz dist/CHECKSUMS* \\\n            --repo "nouverse/nouride" --clobber');
    // Signed with every other public checksum file: `sign` takes them all.
    expect(workflow).toContain("--repo \"nouverse/nouride\" --pattern 'CHECKSUMS*' --dir public --clobber");
  });

  test("says that it goes at 0.9.0", () => {
    const step = workflow.slice(workflow.lastIndexOf("\n\n", at("Router's names, for the Router installs out there")), at("Router's names, for the Router installs out there"));
    expect(step).toContain("0.9.0 removes this step (v0.8.29_RFC).");
    expect(readFileSync(join(ROOT, "scripts/release/router-alias.ts"), "utf8")).toContain("0.9.0 removes this, with Router's other names (v0.8.29_RFC).");
  });
});
