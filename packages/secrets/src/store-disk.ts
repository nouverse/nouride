/**
 * What the secret store's folder holds, read (0.8.19): `secrets.enc` opened with the key its header names, or
 * `secrets.json` until it is moved, and the refusals that keep every secret rather than read a file as none. The
 * store (`store.ts`) holds what this reads and writes it back.
 */

import { fileExistsSync, join, readBytesSync, readTextFileSync, statFile } from "@nouride/runtime";
import { SecretError } from "./store-error.ts";
import { decodeStore, ENCRYPTED_FILE, fingerprintNeeded, PLAIN_FILE, secretsOf, type StoredSecret } from "./store-file.ts";
import type { StoreKey } from "./store-key.ts";

export type Format = "plain" | "encrypted";

export interface OnDisk {
  secrets: Record<string, StoredSecret>;
  format: Format;
  /** The key the file is encrypted with; null for `secrets.json` or no file. */
  lockedWith: StoreKey | null;
}

/**
 * What the data folder holds: `secrets.enc` opened with the key its header names (looked for again when none found so
 * far is it), else `secrets.json`, else nothing. A file that cannot be opened is refused, never read as no secrets.
 */
export function readDisk(dataDir: string, keys: StoreKey[], lookAgain: () => StoreKey[]): OnDisk {
  const enc = join(dataDir, ENCRYPTED_FILE);
  const plain = join(dataDir, PLAIN_FILE);
  // Both: the newer is what was written last. A `secrets.json` newer than `secrets.enc` is the way back's: written by
  // `nouride secret decrypt` for an older version, and changed there, perhaps. The move encrypts it again.
  const plainIsNewer = (statFile(plain)?.mtimeMs ?? -1) > (statFile(enc)?.mtimeMs ?? Number.POSITIVE_INFINITY);
  if (fileExistsSync(enc) && !plainIsNewer) {
    const bytes = readBytesSync(enc);
    const needed = fingerprintNeeded(bytes, enc);
    const key = keys.find((candidate) => candidate.fingerprint === needed) ?? lookAgain().find((candidate) => candidate.fingerprint === needed);
    if (!key) throw lockedOut(enc, needed, lookAgain());
    return { secrets: decodeStore(bytes, key, enc), format: "encrypted", lockedWith: key };
  }
  if (fileExistsSync(plain)) {
    const secrets = Object.fromEntries(Object.entries(parseStored(readTextFileSync(plain), plain)).map(([name, value]) => [name, { value, fields: {} }]));
    return { secrets, format: "plain", lockedWith: null };
  }
  return { secrets: {}, format: "encrypted", lockedWith: null };
}

/** The refusal for a store whose key is not here: which key it needs, where this looked, and the two ways out. */
function lockedOut(path: string, needed: string, found: StoreKey[]): SecretError {
  const looked = found.length ? ` The keys found here (${found.map((key) => `${key.where}, ${key.fingerprint}`).join("; ")}) are others.` : " No key was found here.";
  return new SecretError(
    `${path} is encrypted with a key this machine does not have (key ${needed}).${looked} Put back the key it was ` +
      "encrypted with (NOURIDE_ENCRYPTION_KEY, or the file it was kept in), or recover the secrets with the backup " +
      "password: nouride secret restore --stdin",
  );
}

/**
 * `secrets.json` as names and values. Refused, never read as empty, when it is not JSON: silently losing every stored
 * credential would look like an auth outage with no cause. Zero bytes are refused by name, for every read (`open`, and
 * `onDisk` under a write and `catchUp`): it is what a write cut off by a power cut leaves.
 */
export function parseStored(raw: string, path: string): Record<string, string> {
  if (raw.length === 0) {
    throw new SecretError(
      `${path} is empty, refused rather than read as holding no secrets: a write cut off by a power cut leaves it so. ` +
        "Put back a copy of it, or delete it and set the secrets again (nouride secret set).",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new SecretError(`${path} is not valid JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(secretsOf(parsed, path)).map(([name, entry]) => [name, entry.value]));
}

/** A file's time and size, or null where there is none — what tells this store another process wrote it. */
export function fileSignature(path: string): string | null {
  const stat = statFile(path);
  return stat ? `${stat.mtimeMs}:${stat.size}` : null;
}
