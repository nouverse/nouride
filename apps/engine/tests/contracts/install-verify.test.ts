/**
 * `install.sh` checks a release before it installs it, as `nouride update` does.
 *
 * It runs as root and installed whatever the download said it was, while the unprivileged update refused the same
 * file unsigned. The functions are taken from the script as written and run by `sh`, against a checksum file and a
 * signature made here with a key of the test's own — the script's keys are swapped for it, after the first test
 * holds the script's copy of them to the list compiled into Nouride.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEYS } from "../../../../packages/update/src/signing.ts";

const INSTALL = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const KEYS_BLOCK = between("# >>> release keys\n", "# <<< release keys");
const FUNCTIONS = between("# >>> verify release\n", "# <<< verify release");
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";
const OPENSSL_3 = spawnSync(SH, ["-c", "openssl pkeyutl -help 2>&1 | grep -q -- -rawin"]).status === 0;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString().trim();

/** Runs the script's functions with `body`, its keys swapped for this test's. Prints what `die` said, if it did. */
function run(body: string, keys = PEM): { out: string; status: number } {
  const script = `die() { echo "DIE: $*"; exit 1; }\nwarn() { echo "WARN: $*"; }\nRELEASE_KEYS='${keys}'\n${FUNCTIONS}\n${body}`;
  const result = spawnSync(SH, ["-c", script], { encoding: "utf8" });
  return { out: result.stdout + result.stderr, status: result.status ?? -1 };
}

/** A release: a tarball, its checksum file, and a signature over that file. */
function release(contents = "genuine") {
  const dir = mkdtempSync(join(tmpdir(), "nouride-verify-"));
  dirs.push(dir);
  const tarball = join(dir, "nouride-linux-x64.tar.gz");
  writeFileSync(tarball, contents);
  const sums = `${createHash("sha256").update(contents).digest("hex")}  ./nouride-linux-x64.tar.gz\n`;
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  writeFileSync(join(dir, "SHA256SUMS.sig"), `${sign(null, Buffer.from(sums), privateKey).toString("base64")}\n`);
  return { dir, tarball, sums: join(dir, "SHA256SUMS"), sig: join(dir, "SHA256SUMS.sig") };
}

describe("the release keys in install.sh", () => {
  test("are the ones compiled into Nouride — rotating one is changing both", () => {
    const pems = [...KEYS_BLOCK.matchAll(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g)].map((match) => match[0]);
    expect(pems).toEqual(RELEASE_PUBLIC_KEYS.map((pem) => pem.trim()));
  });
});

describe("verify_release", () => {
  test.skipIf(!OPENSSL_3)("passes a signed release whose tarball is the one its checksum file names", () => {
    const r = release();
    expect(run(`verify_release '${r.tarball}' '${r.sums}' '${r.sig}' nouride-linux-x64 && echo "OK $VERIFIED_SIGNATURE"`).out.trim()).toBe("OK 1");
  });

  test.skipIf(!OPENSSL_3)("refuses a substituted tarball with its checksum file edited to match", () => {
    const r = release();
    writeFileSync(r.tarball, "evil");
    writeFileSync(r.sums, `${createHash("sha256").update("evil").digest("hex")}  ./nouride-linux-x64.tar.gz\n`);
    const result = run(`verify_release '${r.tarball}' '${r.sums}' '${r.sig}' nouride-linux-x64`);
    expect(result.status).toBe(1);
    expect(result.out).toContain("not signed by Nouverse");
  });

  test.skipIf(!OPENSSL_3)("refuses a release signed by a key that is not one of Nouride's", () => {
    const r = release();
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString().trim();
    expect(run(`verify_release '${r.tarball}' '${r.sums}' '${r.sig}' nouride-linux-x64`, other).out).toContain("not signed by Nouverse");
  });

  test("refuses a tarball that is not the one the checksum file names, or one it does not name", () => {
    const r = release();
    writeFileSync(r.tarball, "truncated");
    expect(run(`verify_release '${r.tarball}' '${r.sums}' '' nouride-linux-x64`).out).toContain("checksum mismatch for nouride-linux-x64.tar.gz");
    expect(run(`verify_release '${r.tarball}' '${r.sums}' '' nouride-router-linux-x64`).out).toContain("is not in the release's checksum file");
  });

  test("with no signature to check, passes on the checksum alone and says it checked no signature", () => {
    const r = release();
    expect(run(`verify_release '${r.tarball}' '${r.sums}' '' nouride-linux-x64 && echo "OK $VERIFIED_SIGNATURE"`).out.trim()).toBe("OK 0");
  });
});

describe("a --tarball's checksum file", () => {
  /** A Pro release as the internal repository serves it, downloaded into one directory with a public checksum file. */
  function proRelease() {
    const dir = mkdtempSync(join(tmpdir(), "nouride-beside-"));
    dirs.push(dir);
    const tarball = join(dir, "nouride-pro-linux-x64.tar.gz");
    writeFileSync(tarball, "pro build");
    const sums = `${createHash("sha256").update("pro build").digest("hex")}  ./nouride-pro-linux-x64.tar.gz\n`;
    writeFileSync(join(dir, "SHA256SUMS"), "0123abcd  ./nouride-linux-x64.tar.gz\n");
    writeFileSync(join(dir, "SHA256SUMS-pro"), sums);
    writeFileSync(join(dir, "SHA256SUMS-pro.sig"), `${sign(null, Buffer.from(sums), privateKey).toString("base64")}\n`);
    return { dir, tarball };
  }

  test("is the one beside it that lists it, whatever --variant said — not the public one", () => {
    // `--tarball nouride-pro-….tar.gz` without `--variant pro` looked for `SHA256SUMS`, found none, and checked nothing.
    const r = proRelease();
    expect(run(`sums_listing '${r.dir}' nouride-pro-linux-x64.tar.gz`).out).toBe(join(r.dir, "SHA256SUMS-pro"));
  });

  test.skipIf(!OPENSSL_3)("and is checked with the signature beside it", () => {
    const r = proRelease();
    const script = `s="$(sums_listing '${r.dir}' nouride-pro-linux-x64.tar.gz)" && verify_release '${r.tarball}' "$s" "$s.sig" nouride-pro-linux-x64 && echo "OK $VERIFIED_SIGNATURE"`;
    expect(run(script).out.trim()).toBe("OK 1");
  });

  test("none, when no checksum file there lists it — a build of one's own", () => {
    const r = proRelease();
    expect(run(`sums_listing '${r.dir}' nouride-pro-linux-arm64.tar.gz || echo none`).out).toBe("none\n");
  });

  test("an install says so when it found the file and no signature beside it", () => {
    const flow = INSTALL.slice(INSTALL.indexOf('if [ -n "$TARBALL" ]; then\n  [ -f "$TARBALL" ]'));
    expect(flow).toContain('if sums="$(sums_listing "$(dirname "$TARBALL")" "$(basename "$TARBALL")")"; then');
    expect(flow).toContain('[ -f "$sums.sig" ] && sig="$sums.sig"');
    expect(flow).toContain('warn "checked against $sums alone: no $(basename "$sums").sig beside it');
  });
});

describe("must_be_signed", () => {
  test("latest and every tag from v0.7.4 — the first one signed — and a tag it cannot read", () => {
    const signed = (tag: string) => run(`must_be_signed '${tag}' && echo yes || echo no`).out.trim();
    expect(["latest", "v0.7.4", "v0.7.6", "0.8.0", "v1.0.0", "nightly"].map(signed)).toEqual(["yes", "yes", "yes", "yes", "yes", "yes"]);
    expect(["v0.7.3", "v0.6.12", "0.5.0"].map(signed)).toEqual(["no", "no", "no"]);
  });
});
