/**
 * Crypto adapter (TD-001). Password hashing via `Bun.password`, symmetric
 * encryption via `node:crypto`.
 */

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, verify } from "node:crypto";

/** argon2id's memory (KiB) and passes. */
export interface PasswordCost {
  memoryCost: number;
  timeCost: number;
}

/**
 * What every password is hashed at: OWASP's argon2id recommendation — 19 MiB, two passes, one lane (Bun's argon2 always
 * runs one, `p=1`). The one place the cost is said; `hashPassword` makes it and `passwordNeedsRehash` checks for it.
 *
 * Not Bun's default, which is 64 MiB, and that 64 MiB was a first start's whole floor: the start that creates the
 * dashboard's account hashes its password at boot, and anonymous memory went from 29 to 95 MB in the 20 ms of that one
 * hash — a container under 112 MB was killed there on every restart, since the account never got made. Every sign-in
 * paid the 64 MiB again. At this cost a hash is about 20 ms instead of 75 (SYSTEM_REQUIREMENTS.md, the floor).
 */
const PASSWORD_COST: PasswordCost = { memoryCost: 19456, timeCost: 2 };

/**
 * argon2id at `PASSWORD_COST` — §17.1 SPEC.
 *
 * `cost` is for tests and nothing else. Password hashing was a fifth of the whole suite's time when the login
 * rate-limit tests made some forty hashes each at the real cost; at `{ memoryCost: 1024, timeCost: 1 }` one is half a
 * millisecond. The daemon never passes one — `UserStore` takes its hasher from its options, and boot gives it this
 * function as it is. A hash records its own parameters, so `verifyPassword` reads any of them.
 */
export async function hashPassword(password: string, cost: PasswordCost = PASSWORD_COST): Promise<string> {
  return await Bun.password.hash(password, { algorithm: "argon2id", ...cost });
}

/**
 * Whether a stored hash was made at anything other than `cost`, and should be made again at it the next time the
 * password is known — a sign-in that just verified it.
 *
 * Read from the hash, which carries its parameters (`$argon2id$v=19$m=65536,t=2,p=1$…`): Bun's old 64 MiB default, a
 * test's cheaper cost, another algorithm — all true. The version is not compared, so a hash from a newer argon2 at the
 * same cost is not made again on every sign-in. Only meaningful for a hash that verified: an unreadable value answers
 * true here, and `verifyPassword` has already refused it.
 */
export function passwordNeedsRehash(hash: string, cost: PasswordCost = PASSWORD_COST): boolean {
  const made = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!made) return true;
  return Number(made[1]) !== cost.memoryCost || Number(made[2]) !== cost.timeCost || made[3] !== "1";
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed stored hash must read as "wrong password", not as a crash that
    // tells an attacker their input reached the verifier.
    return false;
  }
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function randomToken(): string {
  return randomHex(32);
}

/**
 * sha256 of a string, hex.
 *
 * Used where a value has to be compared or grouped without being revealed — an install fingerprint on
 * the health endpoint, an attachment scope keyed by conversation. Truncate at the call site: the caller
 * knows how much collision resistance its keyspace needs.
 */
export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The `node:crypto` primitives that callers outside this package need directly.
 *
 * Re-exported rather than wrapped: a wrapper around `timingSafeEqual` would be the same function
 * with a different name, and the point of routing them through here is that a port has one file to
 * look at, not that the code changes.
 */
export { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A v4 UUID, for a name that only has to be unique. */
export { randomUUID as randomUuid } from "node:crypto";

/**
 * Bytes as base64url with no padding (RFC 4648 §5): `-` and `_` for `+` and `/`, and no trailing `=`. The alphabet a
 * value takes when it rides in a URL unescaped — an OAuth PKCE verifier and its challenge, a `state`.
 */
export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/**
 * Whether `signature` is a valid Ed25519 signature over `data` by the key in `publicKeyPem`.
 *
 * False for a malformed key or signature rather than throwing: to a caller checking a release,
 * "not signed by this key" is the one answer whatever shape the bad input took.
 */
export function verifyEd25519(data: Uint8Array, signature: Uint8Array, publicKeyPem: string): boolean {
  try {
    return verify(null, data, createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * AES-256-GCM with a fresh IV: `iv | tag | ciphertext`, fixed-width prefixes so reading back needs no
 * framing. The layout is what files already written with it hold — the WhatsApp session — so it
 * does not change.
 */
export function sealAesGcm(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

/** The reverse of `sealAesGcm`. Throws on a wrong key, a tampered blob or a truncated one. */
export function openAesGcm(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES) throw new Error("sealed data is truncated");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, GCM_IV_BYTES));
  decipher.setAuthTag(blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES));
  return new Uint8Array(Buffer.concat([decipher.update(blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)), decipher.final()]));
}

/**
 * A key for one use, derived from a key kept for several (HKDF-SHA256, no salt, `info` naming the use). The secret
 * store's key comes from `NOURIDE_ENCRYPTION_KEY` this way (0.8.19), so a later use of the same variable takes a key of
 * its own and the two never meet.
 */
export function deriveKey(secret: Uint8Array, info: string, bytes = 32): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), info, bytes));
}

/**
 * Sealing to a passphrase without keeping it (0.8.18, the owner's D5): the secrets go into snapshots, which may go to a
 * USB drive, sealed so that only the passphrase opens them. The daemon keeps the public half of a key pair derived
 * from it and never the passphrase or the private half, so it can seal every snapshot and open none.
 *
 * The key pair: scrypt (N 2^15, r 8, p 1) of the passphrase and a random salt, as an X25519 private key. A seal: a fresh
 * X25519 key pair, its agreement with the public key through HKDF-SHA256 to an AES-256-GCM key, `sealAesGcm`. The
 * file carries the salt, so opening needs the file and the passphrase only:
 * `NRSEAL1 | salt (16) | ephemeral public key (32) | iv | tag | ciphertext`.
 */
const SEAL_MAGIC = new TextEncoder().encode("NRSEAL1");
const SEAL_SALT_BYTES = 16;
const X25519_BYTES = 32;
/** DER prefixes of an X25519 key's raw 32 bytes: PKCS#8 for the private half, SPKI for the public. */
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

function x25519Seed(passphrase: string, salt: Uint8Array): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, X25519_BYTES, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function x25519Public(privateKey: ReturnType<typeof createPrivateKey>): Uint8Array {
  return new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-X25519_BYTES));
}

/** The public half of the key a passphrase derives, with the salt it used (a fresh one unless given): what is kept. */
export function sealKeyFromPassphrase(passphrase: string, salt: Uint8Array = randomBytes(SEAL_SALT_BYTES)): { salt: Uint8Array; publicKey: Uint8Array } {
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, x25519Seed(passphrase, salt)]), format: "der", type: "pkcs8" });
  return { salt: new Uint8Array(salt), publicKey: x25519Public(privateKey) };
}

/** `plaintext` sealed to a key `sealKeyFromPassphrase` made: anyone holding the public half seals, only the passphrase opens. */
export function sealToKey(key: { salt: Uint8Array; publicKey: Uint8Array }, plaintext: Uint8Array): Uint8Array {
  const ephemeral = generateKeyPairSync("x25519");
  const recipient = createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(key.publicKey)]), format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const ephemeralPublic = x25519Public(ephemeral.privateKey);
  const aesKey = new Uint8Array(hkdfSync("sha256", shared, Buffer.concat([ephemeralPublic, key.publicKey]), "nouride-seal-v1", 32));
  return new Uint8Array(Buffer.concat([SEAL_MAGIC, key.salt, ephemeralPublic, sealAesGcm(aesKey, plaintext)]));
}

/** What `sealToKey` sealed, opened with the passphrase. Throws on a wrong passphrase, or a file that is not a seal or was changed. */
export function openWithPassphrase(passphrase: string, sealed: Uint8Array): Uint8Array {
  const head = SEAL_MAGIC.length;
  if (sealed.length < head + SEAL_SALT_BYTES + X25519_BYTES || !Buffer.from(sealed.subarray(0, head)).equals(Buffer.from(SEAL_MAGIC))) {
    throw new Error("this is not a sealed file");
  }
  const salt = sealed.subarray(head, head + SEAL_SALT_BYTES);
  const ephemeralPublic = sealed.subarray(head + SEAL_SALT_BYTES, head + SEAL_SALT_BYTES + X25519_BYTES);
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, x25519Seed(passphrase, salt)]), format: "der", type: "pkcs8" });
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(ephemeralPublic)]), format: "der", type: "spki" }) });
  const aesKey = new Uint8Array(hkdfSync("sha256", shared, Buffer.concat([ephemeralPublic, x25519Public(privateKey)]), "nouride-seal-v1", 32));
  try {
    return openAesGcm(aesKey, sealed.subarray(head + SEAL_SALT_BYTES + X25519_BYTES));
  } catch {
    throw new Error("the passphrase does not open it, or the file was changed");
  }
}

