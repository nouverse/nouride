/**
 * A private edition installs only a checksum file Nouverse signed.
 *
 * The chain is signature → checksum file → tarball, and nothing about where the files came from is
 * in it. So the cases that matter are the ones where the files are wrong and the source says
 * nothing: a checksum file edited to match a substituted tarball, a signature for another file, and
 * no signature at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStaged } from "../src/install.ts";
import { planUpdate, type InstallFacts } from "../src/plan.ts";
import { RELEASE_PUBLIC_KEYS, requiresSignature, verifyChecksums } from "../src/signing.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();
const signed = (text: string) => sign(null, Buffer.from(text), privateKey).toString("base64");

describe("verifying a checksum file", () => {
  const SUMS = "abcd  ./nouride-pro-linux-arm64.tar.gz\n";

  test("accepts a signature by a trusted key", () => {
    expect(verifyChecksums(SUMS, signed(SUMS), [PUBLIC])).toBe(true);
  });

  test("refuses a file changed after signing — one byte is enough", () => {
    expect(verifyChecksums(SUMS.replace("abcd", "abce"), signed(SUMS), [PUBLIC])).toBe(false);
  });

  test("refuses a signature by any other key, including a valid one", () => {
    const other = generateKeyPairSync("ed25519");
    const forged = sign(null, Buffer.from(SUMS), other.privateKey).toString("base64");
    expect(verifyChecksums(SUMS, forged, [PUBLIC])).toBe(false);
  });

  test("refuses anything malformed rather than throwing", () => {
    expect(verifyChecksums(SUMS, "", [PUBLIC])).toBe(false);
    expect(verifyChecksums(SUMS, "not base64 at all !!", [PUBLIC])).toBe(false);
    expect(verifyChecksums(SUMS, signed(SUMS), ["not a key"])).toBe(false);
  });

  test("the compiled-in key is an Ed25519 public key, and only the private editions require it", () => {
    expect(RELEASE_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const pem of RELEASE_PUBLIC_KEYS) expect(pem).toContain("BEGIN PUBLIC KEY");
    expect(requiresSignature("pro")).toBe(true);
    expect(requiresSignature("basic")).toBe(false);
    expect(requiresSignature("router")).toBe(false);
  });

  test("a public release requires one from 0.7.4 — the first signed — and a tag it cannot read is not let off", () => {
    expect(requiresSignature("basic", "v0.7.3")).toBe(false);
    expect(requiresSignature("basic", "v0.7.4")).toBe(true);
    expect(requiresSignature("router", "0.8.0")).toBe(true);
    expect(requiresSignature("basic", "v0.7.4-rc.1")).toBe(false);
    expect(requiresSignature("basic", "nightly")).toBe(true);
    expect(requiresSignature("pro", "v0.5.0")).toBe(true);
  });
});

describe("a private edition's plan", () => {
  const DEVICE: InstallFacts = {
    version: "0.5.11",
    edition: "pro",
    installDir: "/srv/nouride",
    installDirWritable: true,
    supervisor: "systemd",
    restartsOnExit: true,
    compiled: true,
    platform: "linux",
    arch: "arm64",
    musl: false,
  };
  const urls = {
    tarballUrl: (tag: string, artifact: string) => `https://r2.invalid/${tag}/${artifact}.tar.gz`,
    checksumUrl: (tag: string, sums: string) => `https://r2.invalid/${tag}/${sums}`,
  };

  test("is refused, before any download, by a source that publishes no signature", () => {
    const plan = planUpdate({ facts: DEVICE, tag: "v0.5.12", source: urls });
    expect(plan.can).toBe(false);
    expect(plan.can === false && plan.reason).toContain("installs only signed releases");
  });

  test("carries the signature's URL when the source has one", () => {
    const plan = planUpdate({
      facts: DEVICE,
      tag: "v0.5.12",
      source: { ...urls, signatureUrl: (tag, sums) => `https://r2.invalid/${tag}/${sums}.sig` },
    });
    expect(plan).toMatchObject({ can: true, signatureUrl: "https://r2.invalid/v0.5.12/SHA256SUMS-pro.sig" });
  });
});

describe("installing a private edition", () => {
  let root: string;
  let installDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nouride-signing-"));
    installDir = join(root, "install");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "nouride"), "#!/bin/sh\necho OLD\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function tarball(marker: string): { path: string; sha256: string } {
    const tree = join(root, `tree-${marker}`);
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "nouride"), `#!/bin/sh\necho ${marker}\n`);
    chmodSync(join(tree, "nouride"), 0o755);
    const path = join(root, `${marker}.tar.gz`);
    spawnSync("tar", ["-czf", path, "-C", tree, "."]);
    return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  }

  const serving = (sums: string, signature: string | null) =>
    (async (url: string | URL) =>
      String(url).endsWith(".sig")
        ? signature === null
          ? { ok: false, status: 404 }
          : { ok: true, status: 200, text: async () => signature }
        : { ok: true, status: 200, text: async () => sums }) as unknown as typeof fetch;

  const input = (path: string, sums: string, signature: string | null, withUrl = true) => ({
    installDir,
    tarball: path,
    swap: ["nouride"],
    checksumUrl: "https://r2.invalid/v0.5.12/SHA256SUMS-pro",
    ...(withUrl ? { signatureUrl: "https://r2.invalid/v0.5.12/SHA256SUMS-pro.sig" } : {}),
    artifact: "nouride-pro-linux-arm64",
    host: { platform: "linux", arch: "arm64" },
    edition: "pro" as const,
    trustedKeys: [PUBLIC],
    fetchImpl: serving(sums, signature),
  });

  test("a signed checksum file and a matching tarball install", async () => {
    const { path, sha256 } = tarball("NEW");
    const sums = `${sha256}  ./nouride-pro-linux-arm64.tar.gz\n`;
    await installStaged(input(path, sums, signed(sums)));
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("NEW");
  });

  test("a substituted tarball with a checksum file edited to match is refused, and nothing moves", async () => {
    const genuine = tarball("NEW");
    const evil = tarball("EVIL");
    const genuineSums = `${genuine.sha256}  ./nouride-pro-linux-arm64.tar.gz\n`;
    const editedSums = `${evil.sha256}  ./nouride-pro-linux-arm64.tar.gz\n`;
    await expect(installStaged(input(evil.path, editedSums, signed(genuineSums)))).rejects.toThrow(/not signed by Nouverse/);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("OLD");
  });

  test("no signature at all is refused for a public release from 0.7.4, and accepted for one before", async () => {
    const { path, sha256 } = tarball("NEW");
    const sums = `${sha256}  ./nouride-pro-linux-arm64.tar.gz\n`;
    const publicInput = (tag: string) => ({ ...input(path, sums, null, false), edition: "basic" as const, tag });
    await expect(installStaged(publicInput("v0.7.6"))).rejects.toThrow(/v0\.7\.6 must be signed, and came with no signature/);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("OLD");
    await installStaged(publicInput("v0.7.3"));
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("NEW");
  });

  test("no signature at all is refused for a private edition", async () => {
    const { path, sha256 } = tarball("NEW");
    const sums = `${sha256}  ./nouride-pro-linux-arm64.tar.gz\n`;
    await expect(installStaged(input(path, sums, null, false))).rejects.toThrow(/installs only signed releases/);
    expect(readFileSync(join(installDir, "nouride"), "utf8")).toContain("OLD");
  });
});
