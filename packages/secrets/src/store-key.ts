/**
 * The key the secret store is encrypted with (0.8.19): where it is found, and where one is made when there is none.
 *
 * One key per install, `NOURIDE_ENCRYPTION_KEY`: 32 random bytes, in base64 (or 64 hex digits). The store is not
 * encrypted with it directly but with a key derived from it for this one use, so a later use of the same variable gets
 * a key of its own.
 *
 * What protects the store is how far the key is from it. A key beside the store protects no copy of the folder (the
 * backlog line this replaced), so where it was found is kept with it and said: outside the install (root's
 * `/etc/nouride/nouride.env`, a container's environment, a file the operator named), in the install's own `.env` beside
 * `.nouride/`, or in the data folder itself. `doctor` and the Secrets page say which.
 *
 * Found, in order: the environment variable; `NOURIDE_ENCRYPTION_KEY_FILE`; the env files a command run outside the
 * service reads (it does not have the service's environment); the key the daemon keeps itself. Made only by
 * `makeStoreKey`, which `SecretStore` calls only when no store exists that needs another key: a new key over a store
 * encrypted with an old one would lose every secret in it.
 */

import {
  canReadWrite,
  createHash,
  deriveKey,
  dirname,
  ensureDir,
  escapes,
  fileExistsSync,
  join,
  normalize,
  randomBytes,
  readTextFileSync,
  relative,
  removePath,
  statFile,
  writeTextFileAtomic,
} from "@nouride/runtime";
import { SecretError } from "./store-error.ts";

export const KEY_VARIABLE = "NOURIDE_ENCRYPTION_KEY";
export const KEY_FILE_VARIABLE = "NOURIDE_ENCRYPTION_KEY_FILE";
/** Where `install.sh` keeps it on a Linux box with systemd: root's, read by systemd before it starts the service. */
export const SYSTEM_KEY_FILE = "/etc/nouride/nouride.env";
/** What the store's key is derived for: changing it is changing every store's key. */
const STORE_KEY_INFO = "nouride-secret-store-v1";

/**
 * How far the key is from the data: `outside` the install (the place it belongs), in the `install`'s own `.env` beside
 * the data folder (what an install that only updated gets; `install.sh` moves it out), or in the `data` folder itself
 * (a container given no key).
 */
export type KeyLevel = "outside" | "install" | "data";

export interface StoreKey {
  /** The store's own key, derived from the one found. */
  key: Uint8Array;
  /** Sixteen hex digits of its SHA-256: what the file's header names, so a wrong key is said, not taken for damage. */
  fingerprint: string;
  /** Where it was found, said to a person: a path, or the variable. Never the value. */
  where: string;
  level: KeyLevel;
  /** The text as found, so what leaves the daemon is masked of it. */
  text: string;
}

export interface KeyLayout {
  /** Where the daemon keeps a key it made with nowhere better (the `data` level, or `install` when inside it). */
  keptKey: string;
  /** The install's `.env`: where the daemon adds a key line when the file exists and it can write it. */
  installEnv?: string;
  /** The install's folder and its data folder, to tell how far a file is from the data. */
  installDir?: string;
  nourideDir?: string;
  /** Env files a command outside the service reads for the key, in order. */
  envFiles?: readonly string[];
  /**
   * Root's file, for a key made by a process that is root (a Box's daemon, `sudo nouride setup`): the place `install.sh`
   * would have put it. Set only for root, which alone can write there.
   */
  systemKeyFile?: string;
}

/** The value of `NOURIDE_ENCRYPTION_KEY=` in an env file's text, or null. `export` and quotes as a shell writes them. */
export function keyLineValue(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?NOURIDE_ENCRYPTION_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/^(["'])(.*)\1$/, "$2").trim();
    if (value) return value;
  }
  return null;
}

/** The 32 bytes a key's text holds: base64 (plain or URL-safe) or hex. Refused by where it was found, never shown. */
export function keyBytes(text: string, where: string): Uint8Array {
  const value = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    try {
      const plain = value.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(plain.padEnd(44, "=")), (char) => char.charCodeAt(0));
      if (bytes.length === 32) return bytes;
    } catch {
      // Not base64 after all: refused below like any other text.
    }
  }
  throw new SecretError(
    `The ${KEY_VARIABLE} in ${where} is not a key Nouride can use: 32 random bytes in base64 ` +
      "(`openssl rand -base64 32`) or as 64 hex digits",
  );
}

function storeKeyFrom(text: string, where: string, level: KeyLevel): StoreKey {
  const key = deriveKey(keyBytes(text, where), STORE_KEY_INFO);
  return { key, fingerprint: fingerprintOf(key), where, level, text: text.trim() };
}

function fingerprintOf(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function inside(dir: string | undefined, path: string): boolean {
  if (!dir) return false;
  const rel = relative(normalize(dir), normalize(path));
  return rel !== "" && !escapes(rel);
}

/** How far a file is from the data: in the data folder, in the install, or outside both. */
function levelOf(path: string, layout: KeyLayout): KeyLevel {
  if (inside(layout.nourideDir, path) || normalize(path) === normalize(layout.keptKey)) return "data";
  if (inside(layout.installDir, path)) return "install";
  return "outside";
}

function readable(path: string): string | null {
  try {
    return fileExistsSync(path) ? readTextFileSync(path) : null;
  } catch {
    // Root's file, read by a command that is not root: not this one's to find.
    return null;
  }
}

/**
 * Every key this process can find, the one to write with first, each once. An error only for a key that is there and
 * is not one: a typo in the variable is said, not passed over for a weaker key.
 */
export function findStoreKeys(env: Record<string, string | undefined>, layout: KeyLayout): StoreKey[] {
  const found: StoreKey[] = [];
  const add = (key: StoreKey) => {
    if (!found.some((other) => other.fingerprint === key.fingerprint)) found.push(key);
  };
  const installLine = layout.installEnv ? keyLineValue(readable(layout.installEnv) ?? "") : null;

  const fromEnv = env[KEY_VARIABLE]?.trim();
  if (fromEnv) {
    // Where systemd or the shell took it from, as near as can be told: the install's `.env` when it holds this value,
    // root's file when it is there, the environment otherwise.
    if (installLine?.trim() === fromEnv && layout.installEnv) add(storeKeyFrom(fromEnv, layout.installEnv, levelOf(layout.installEnv, layout)));
    else if (statFile(SYSTEM_KEY_FILE)) add(storeKeyFrom(fromEnv, SYSTEM_KEY_FILE, "outside"));
    else add(storeKeyFrom(fromEnv, "the environment", "outside"));
  }
  const file = env[KEY_FILE_VARIABLE]?.trim();
  if (file) {
    const text = readable(file);
    if (text === null) throw new SecretError(`${KEY_FILE_VARIABLE} names ${file}, which cannot be read`);
    add(storeKeyFrom(keyLineValue(text) ?? text, file, levelOf(file, layout)));
  }
  for (const path of [...(layout.envFiles ?? []), ...(layout.installEnv ? [layout.installEnv] : [])]) {
    const value = keyLineValue(readable(path) ?? "");
    if (value) add(storeKeyFrom(value, path, levelOf(path, layout)));
  }
  const kept = readable(layout.keptKey)?.trim();
  if (kept) add(storeKeyFrom(kept, layout.keptKey, levelOf(layout.keptKey, layout)));
  return found;
}

/**
 * A new key, where the daemon can put one: a line in the install's `.env` when that file exists and can be written
 * (systemd reads it at the next start, and the next `install.sh` moves it to root's file), else its own file. Never a
 * new `.env`: in a container the install's folder is the image's, and a file there is gone at the next pull.
 */
export async function makeStoreKey(layout: KeyLayout): Promise<StoreKey> {
  const text = btoa(String.fromCharCode(...randomBytes(32)));
  if (layout.systemKeyFile) {
    ensureDir(dirname(layout.systemKeyFile), 0o755);
    await writeTextFileAtomic(layout.systemKeyFile, `# The secret store's key (Nouride). Keep it: without it, or the backup password, the store cannot be opened.\n${KEY_VARIABLE}=${text}\n`, { mode: 0o600 });
    return storeKeyFrom(text, layout.systemKeyFile, "outside");
  }
  const env = layout.installEnv;
  if (env && fileExistsSync(env) && canReadWrite(env)) {
    const before = readTextFileSync(env);
    const line = `${KEY_VARIABLE}=${text}`;
    await writeTextFileAtomic(env, `${before}${before && !before.endsWith("\n") ? "\n" : ""}# The secret store's key (Nouride 0.8.19). Keep it: without it, or the backup password, the store cannot be opened.\n${line}\n`);
    return storeKeyFrom(text, env, levelOf(env, layout));
  }
  await writeTextFileAtomic(layout.keptKey, `${text}\n`, { mode: 0o600 });
  return storeKeyFrom(text, layout.keptKey, levelOf(layout.keptKey, layout));
}

/**
 * A key this daemon made, gone once the store is encrypted with a better one: its own file, or its line in the
 * install's `.env` (with the comment it wrote above it). A key anyone else put anywhere is theirs, and stays.
 */
export async function forgetMadeKey(key: StoreKey, layout: KeyLayout): Promise<void> {
  if (normalize(key.where) === normalize(layout.keptKey)) {
    removePath(layout.keptKey);
    return;
  }
  if (!layout.installEnv || normalize(key.where) !== normalize(layout.installEnv)) return;
  const text = readable(layout.installEnv);
  if (text === null) return;
  const lines = text.split("\n");
  const kept = lines.filter((line, index) => {
    if (keyLineValue(line)?.trim() === key.text) return false;
    const next = lines[index + 1] ?? "";
    return !(line.startsWith("# The secret store's key (Nouride") && keyLineValue(next)?.trim() === key.text);
  });
  if (kept.length !== lines.length) await writeTextFileAtomic(layout.installEnv, kept.join("\n"));
}

/** The layout of an install whose data folder is `dataDir`, under the default `<install>/.nouride/data`. */
export function installKeyLayout(paths: { dataDir: string; nourideDir: string; installDir: string; home?: string; root?: boolean }): KeyLayout {
  return {
    ...(paths.root ? { systemKeyFile: SYSTEM_KEY_FILE } : {}),
    keptKey: join(paths.nourideDir, "encryption.key"),
    installEnv: join(paths.installDir, ".env"),
    installDir: paths.installDir,
    nourideDir: paths.nourideDir,
    envFiles: [SYSTEM_KEY_FILE, ...(paths.home ? [join(paths.home, ".config", "nouride", "nouride.env")] : [])],
  };
}
