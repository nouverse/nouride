/**
 * Large files a piece at a time, and a release signature checked — what `packages/update` reaches the
 * host through.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { digestFile, makeTempDir, openFileWriter } from "../src/file-stream.ts";
import { verifyEd25519 } from "../src/crypto.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("files a piece at a time", () => {
  test("a writer writes, appends on request, and the digest matches the whole", async () => {
    dir = mkdtempSync(join(tmpdir(), "nr-stream-"));
    const path = join(dir, "part");
    const first = openFileWriter(path);
    await first.write(new TextEncoder().encode("hello "));
    await first.close();
    const second = openFileWriter(path, { append: true });
    await second.write(new TextEncoder().encode("world"));
    await second.close();

    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(await digestFile(path)).toEqual({ bytes: 11, sha256: createHash("sha256").update("hello world").digest("hex") });

    const fresh = openFileWriter(path);
    await fresh.close();
    expect(statSync(path).size).toBe(0);
  });

  test("a temporary directory is new, inside its parent, with the prefix", () => {
    dir = mkdtempSync(join(tmpdir(), "nr-stream-"));
    const made = makeTempDir(dir, ".unpack-");
    expect(existsSync(made)).toBe(true);
    expect(made.startsWith(dir)).toBe(true);
    expect(basename(made)).toStartWith(".unpack-");
    expect(makeTempDir(dir, ".unpack-")).not.toBe(made);
  });
});

describe("verifyEd25519", () => {
  test("true for the key that signed, false for another key, altered data, or junk", () => {
    const signer = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const pem = (key: typeof signer.publicKey) => key.export({ type: "spki", format: "pem" }).toString();
    const data = new TextEncoder().encode("sha256  nouride-linux-x64.tar.gz");
    const signature = sign(null, data, signer.privateKey);

    expect(verifyEd25519(data, signature, pem(signer.publicKey))).toBe(true);
    expect(verifyEd25519(data, signature, pem(other.publicKey))).toBe(false);
    expect(verifyEd25519(new TextEncoder().encode("altered"), signature, pem(signer.publicKey))).toBe(false);
    expect(verifyEd25519(data, signature, "not a key")).toBe(false);
  });
});
