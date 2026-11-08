/**
 * The secret store in the snapshots, sealed to a passphrase (0.8.18).
 *
 * The person sets a passphrase once (`nouride secret seal --stdin`); `[daemon] backup_seal` keeps the public half of
 * the key it derives and the salt, `nrseal1:<salt>:<public key>` in base64url, never the passphrase or the private half
 * (`@nouride/runtime`'s `sealToKey`). Each config snapshot then holds `secrets.sealed`, which only that passphrase
 * opens (`nouride secret unseal`). With no passphrase set, no secret goes into a snapshot, and `nouride secret` says so.
 *
 * The sealed copy is `data/secrets.sealed`, sealed again only when the store or the key changed: a seal is new bytes
 * every time, and a snapshot that saw a new file every week would never be "unchanged". Since 0.8.19 at each change of
 * the store too, not only with the weekly snapshot: it is also how a lost key is recovered (`nouride secret restore`),
 * and a week-old copy would bring back a week-old store. What it seals is the store as the daemon holds it, decrypted:
 * the file on disk is encrypted with a key the passphrase knows nothing of.
 */

import { base64Url, fileExistsSync, join, readTextFileSync, removePath, renamePath, sealKeyFromPassphrase, sealToKey, sha256Text, writeBytesSync } from "@nouride/runtime";
import { ConfigError } from "@nouride/shared";

const PREFIX = "nrseal1";

function fromBase64Url(text: string): Uint8Array {
  try {
    const plain = text.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(plain.padEnd(Math.ceil(plain.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

/** `[daemon] backup_seal` read: the salt and the public half, or null when it is not set. Throws on one that is set wrong. */
export function parseBackupSeal(value: string): { salt: Uint8Array; publicKey: Uint8Array } | null {
  if (!value.trim()) return null;
  const parts = value.trim().split(":");
  const salt = parts[1] ? fromBase64Url(parts[1]) : new Uint8Array();
  const publicKey = parts[2] ? fromBase64Url(parts[2]) : new Uint8Array();
  if (parts.length !== 3 || parts[0] !== PREFIX || salt.length !== 16 || publicKey.length !== 32) {
    throw new ConfigError("[daemon] backup_seal is not one `nouride secret seal` writes: set it again with that command, or remove the line to keep secrets out of snapshots");
  }
  return { salt, publicKey };
}

/** What `[daemon] backup_seal` is set to for a passphrase: a fresh salt and the public half of the key they derive. */
export function backupSealFor(passphrase: string): string {
  const key = sealKeyFromPassphrase(passphrase);
  return `${PREFIX}:${base64Url(key.salt)}:${base64Url(key.publicKey)}`;
}

/**
 * `data/secrets.sealed` as the snapshot takes it: sealed again when the store or the key changed since the last seal,
 * and removed with no key, so nothing sealed to an old passphrase lingers. Null when there is nothing to put in.
 * Synchronous, as the snapshot that takes it is.
 */
export function sealedSecretsCopy(dataDir: string, seal: string, storeText: string | null): string | null {
  const sealed = join(dataDir, "secrets.sealed");
  const marker = join(dataDir, "secrets.sealed.for");
  const key = parseBackupSeal(seal);
  const store = key ? storeText : null;
  if (!key || store === null) {
    removePath(sealed);
    removePath(marker);
    return null;
  }
  const wanted = sha256Text(`${seal}\n${store}`);
  if (fileExistsSync(marker) && readTextFileSync(marker).trim() === wanted && fileExistsSync(sealed)) return sealed;
  writeOwnerOnly(sealed, sealToKey(key, new TextEncoder().encode(store)));
  writeOwnerOnly(marker, new TextEncoder().encode(`${wanted}\n`));
  return sealed;
}

/** Through a temp name, so a write cut short is never left under the real one; 0600 from its creation, as the store. */
function writeOwnerOnly(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp`;
  removePath(temp);
  writeBytesSync(temp, bytes, 0o600);
  renamePath(temp, path);
}
