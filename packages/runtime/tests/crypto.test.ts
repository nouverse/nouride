/**
 * Password hashing, and the one assumption the user store leans on.
 *
 * `UserStore` writes `!` into `password_hash` for an account that signs in
 * through an identity provider and nothing else. That is not a hash, so what
 * `verifyPassword` does when handed it decides whether such an account is safe:
 * false is correct, a throw would be a 500 on the login route, and **true would
 * be an account that anything signs into.**
 *
 * The store refuses the sentinel itself before ever calling this — but that
 * guard is belt and braces, and this is the brace. Removing the guard breaks no
 * test today precisely because the behaviour below holds; if it ever stops
 * holding, this is what says so.
 */

import { describe, expect, test } from "bun:test";
import { base64Url, createHash, hashPassword, openWithPassphrase, passwordNeedsRehash, sealKeyFromPassphrase, sealToKey, verifyPassword } from "../src/crypto.ts";

describe("a real password", () => {
  test("round-trips, and a wrong one does not", async () => {
    const hash = await hashPassword("a-real-password-1");
    expect(hash).not.toBe("a-real-password-1");
    expect(await verifyPassword("a-real-password-1", hash)).toBe(true);
    expect(await verifyPassword("a-real-password-2", hash)).toBe(false);
  });

  test("hashes differ for the same input, so the salt is doing its job", async () => {
    expect(await hashPassword("same-password-1")).not.toBe(await hashPassword("same-password-1"));
  });

  test("is hashed at OWASP's argon2id cost unless one is given — and a cheaper one, for tests, still verifies", async () => {
    // The daemon never passes a cost. 19 MiB, two passes, one lane: Bun's own 64 MiB was a first start's whole memory
    // floor. A default that slipped to the tests' cost would be a hash an offline guess beats a hundred times faster,
    // and nothing else here would notice.
    expect(await hashPassword("a-real-password-1")).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const cheap = await hashPassword("a-real-password-1", { memoryCost: 1024, timeCost: 1 });
    expect(cheap).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,/);
    expect(await verifyPassword("a-real-password-1", cheap)).toBe(true);
    expect(await verifyPassword("a-real-password-2", cheap)).toBe(false);
  });
});

describe("a password hashed at an older cost", () => {
  // What every account made before 0.7.11 holds: Bun's default, which a stored hash records as its own.
  const BUN_DEFAULT = { memoryCost: 65536, timeCost: 2 };

  test("still verifies, and a wrong password against it still fails", async () => {
    const old = await hashPassword("a-real-password-1", BUN_DEFAULT);
    expect(old).toMatch(/^\$argon2id\$v=19\$m=65536,t=2,p=1\$/);
    expect(await verifyPassword("a-real-password-1", old)).toBe(true);
    expect(await verifyPassword("a-real-password-2", old)).toBe(false);
  });

  test("needs hashing again, where a hash at today's cost does not", async () => {
    expect(passwordNeedsRehash(await hashPassword("a-real-password-1", BUN_DEFAULT))).toBe(true);
    // The one that matters most: what `hashPassword` makes must never need it, or every sign-in would write a hash.
    expect(passwordNeedsRehash(await hashPassword("a-real-password-1"))).toBe(false);
    // Each parameter is compared, not only the memory.
    expect(passwordNeedsRehash("$argon2id$v=19$m=19456,t=3,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(passwordNeedsRehash("$argon2id$v=19$m=19456,t=2,p=4$c2FsdA$aGFzaA")).toBe(true);
    expect(passwordNeedsRehash("$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(true);
    // The version is not: a newer argon2 at the same cost is current, not made again at every sign-in.
    expect(passwordNeedsRehash("$argon2id$v=20$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(false);
    // Against a cost of its own — the tests' — a hash at that cost is current.
    const cheapCost = { memoryCost: 1024, timeCost: 1 };
    expect(passwordNeedsRehash(await hashPassword("a-real-password-1", cheapCost), cheapCost)).toBe(false);
  });
});

describe("an unparseable stored hash", () => {
  test("reads as a wrong password, never as a match and never as a throw", async () => {
    for (const stored of ["!", "", "not-a-hash", "$argon2id$v=19$bogus", "*"]) {
      expect(await verifyPassword("anything", stored), JSON.stringify(stored)).toBe(false);
      // The case that would matter most: the stored value offered as the password.
      expect(await verifyPassword(stored, stored), `self:${JSON.stringify(stored)}`).toBe(false);
    }
  });
});

describe("base64url", () => {
  test("encodes RFC 7636's own example: the verifier's octets, and the S256 challenge made of it", () => {
    // Appendix B of RFC 7636 — the PKCE pair an authorization server checks, spelled out byte for byte.
    const octets = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
      91, 88, 5, 88, 83, 132, 141, 121,
    ]);
    const verifier = base64Url(octets);
    expect(verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(base64Url(createHash("sha256").update(verifier).digest())).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("uses - and _ and no padding, and encodes only the bytes of a view, not the buffer under it", () => {
    // 0xfb 0xff is "+/8=" in plain base64: each of the three characters a URL would mangle.
    const view = new Uint8Array([0, 0xfb, 0xff, 0]).subarray(1, 3);
    expect(base64Url(view)).toBe("-_8");
  });
});

describe("sealed to a passphrase (0.8.18, D5)", () => {
  const text = new TextEncoder().encode('{"a_token":"stand-in"}');

  test("anyone with the public half seals; only the passphrase opens, and a fresh seal each time", () => {
    const key = sealKeyFromPassphrase("a long walk to the river");
    const one = sealToKey(key, text);
    const two = sealToKey(key, text);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
    expect(new TextDecoder().decode(openWithPassphrase("a long walk to the river", one))).toBe('{"a_token":"stand-in"}');
    expect(() => openWithPassphrase("a long walk to the rivers", one)).toThrow("the passphrase does not open it");
  });

  test("the same passphrase and salt make the same key; another salt another", () => {
    const key = sealKeyFromPassphrase("a long walk to the river");
    expect(Buffer.from(sealKeyFromPassphrase("a long walk to the river", key.salt).publicKey).equals(Buffer.from(key.publicKey))).toBe(true);
    expect(Buffer.from(sealKeyFromPassphrase("a long walk to the river").publicKey).equals(Buffer.from(key.publicKey))).toBe(false);
  });

  test("a changed byte, or a file that is no seal, is refused rather than opened to something else", () => {
    const sealed = sealToKey(sealKeyFromPassphrase("a long walk to the river"), text);
    const changed = new Uint8Array(sealed);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(() => openWithPassphrase("a long walk to the river", changed)).toThrow();
    expect(() => openWithPassphrase("a long walk to the river", new TextEncoder().encode('{"a_token":"stand-in"}'))).toThrow("this is not a sealed file");
  });
});
