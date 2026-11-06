/**
 * The secret store on disk (0.8.19): `data/secrets.enc`, and what it holds.
 *
 * `NRSTORE1` | the key's fingerprint (8 bytes) | AES-256-GCM over the whole store as JSON (`sealAesGcm`: a fresh IV and
 * its tag in front, as the WhatsApp session's files). Written whole, so one write is one version, as `secrets.json`
 * was. The fingerprint names the key a file needs: without it a wrong key and a damaged file are the same failure, and
 * "your store is corrupt" is the wrong thing to tell a person whose key is in another file.
 *
 * Inside, format 2: each secret's value with what is said about it, its fields (a name and a text each, never
 * secret) and when and by whom it was added and changed. `secrets.json`'s map of names to values is format 1, read as
 * values with nothing said about them.
 */

import { openAesGcm, sealAesGcm } from "@nouride/runtime";
import { SecretError } from "./store-error.ts";
import type { StoreKey } from "./store-key.ts";

export const ENCRYPTED_FILE = "secrets.enc";
export const PLAIN_FILE = "secrets.json";

const MAGIC = new TextEncoder().encode("NRSTORE1");
const FINGERPRINT_BYTES = 8;

/** One secret: its value, and what is said about it. */
export interface StoredSecret {
  value: string;
  /** Free fields, a name and a text each (`domain`, `username`, …): shown to people and agents, so never secret. */
  fields: Record<string, string>;
  addedBy?: string;
  addedAt?: string;
  changedAt?: string;
}

export interface StoreDocument {
  version: 2;
  secrets: Record<string, StoredSecret>;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The file's bytes for `secrets`, under `key`. */
export function encodeStore(secrets: Record<string, StoredSecret>, key: StoreKey): Uint8Array {
  const document: StoreDocument = { version: 2, secrets };
  const fingerprint = Uint8Array.from(key.fingerprint.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const body = sealAesGcm(key.key, new TextEncoder().encode(JSON.stringify(document)));
  const out = new Uint8Array(MAGIC.length + FINGERPRINT_BYTES + body.length);
  out.set(MAGIC, 0);
  out.set(fingerprint, MAGIC.length);
  out.set(body, MAGIC.length + FINGERPRINT_BYTES);
  return out;
}

/**
 * The fingerprint of the key a file needs, read from its header. Refused by name when it is not one of these files: zero
 * bytes are what a write cut off by a power cut leaves, and anything else is not ours.
 */
export function fingerprintNeeded(bytes: Uint8Array, path: string): string {
  if (bytes.length === 0) {
    throw new SecretError(
      `${path} is empty, refused rather than read as holding no secrets: a write cut off by a power cut leaves it so. ` +
        "Put back a copy of it, or recover the secrets with the backup password (nouride secret restore --stdin).",
    );
  }
  const head = bytes.subarray(0, MAGIC.length);
  if (bytes.length < MAGIC.length + FINGERPRINT_BYTES || !head.every((byte, index) => byte === MAGIC[index])) {
    throw new SecretError(`${path} is not a secret store Nouride wrote: refused rather than read as holding no secrets`);
  }
  return hex(bytes.subarray(MAGIC.length, MAGIC.length + FINGERPRINT_BYTES));
}

/** What the file holds, opened with the key its header names. A changed or cut file is refused, never half read. */
export function decodeStore(bytes: Uint8Array, key: StoreKey, path: string): Record<string, StoredSecret> {
  let text: string;
  try {
    text = new TextDecoder().decode(openAesGcm(key.key, bytes.subarray(MAGIC.length + FINGERPRINT_BYTES)));
  } catch {
    throw new SecretError(
      `${path} could not be opened with its key (${key.where}): the file was changed or cut short. Put back a copy of it, ` +
        "or recover the secrets with the backup password (nouride secret restore --stdin).",
    );
  }
  return secretsOf(JSON.parse(text) as unknown, path);
}

/**
 * Format 2's secrets, or format 1's map read as values with nothing said about them: what a sealed copy holds too, from
 * 0.8.18 (format 1) and on.
 */
export function secretsOf(parsed: unknown, path: string): Record<string, StoredSecret> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SecretError(`${path} does not hold a secret store`);
  const record = parsed as Record<string, unknown>;
  if (record.version === 2 && record.secrets && typeof record.secrets === "object") {
    const out: Record<string, StoredSecret> = {};
    for (const [name, raw] of Object.entries(record.secrets as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.value !== "string") continue;
      const fields = entry.fields && typeof entry.fields === "object" && !Array.isArray(entry.fields)
        ? Object.fromEntries(Object.entries(entry.fields as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
        : {};
      out[name] = {
        value: entry.value,
        fields,
        ...(typeof entry.addedBy === "string" ? { addedBy: entry.addedBy } : {}),
        ...(typeof entry.addedAt === "string" ? { addedAt: entry.addedAt } : {}),
        ...(typeof entry.changedAt === "string" ? { changedAt: entry.changedAt } : {}),
      };
    }
    return out;
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter((pair): pair is [string, string] => typeof pair[1] === "string")
      .map(([name, value]) => [name, { value, fields: {} }]),
  );
}

/** Format 1, the map an older version reads: names to values, nothing else. What the way back writes. */
export function valuesOnly(secrets: Record<string, StoredSecret>): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).map(([name, entry]) => [name, entry.value]));
}
