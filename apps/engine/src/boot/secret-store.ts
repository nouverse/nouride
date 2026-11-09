/**
 * The secret store as the daemon holds it (0.8.19): encrypted at rest, its key found where the install keeps it.
 *
 * Opened with a copy of the environment, after which the key's two variables leave the daemon's own: whatever it starts
 * afterwards (a command, an MCP server, a coding CLI) inherits nothing of the key, whatever environment it is given.
 * The daemon's store, and only it, encrypts the file again with a better key found since (`rekey`): a container given
 * `NOURIDE_ENCRYPTION_KEY`, root's file the next `install.sh` made.
 *
 * `secrets.json` is moved into `secrets.enc` once no update is pending: while one is, the guard may yet put the
 * previous version back, and that version reads `secrets.json` (`service/update-guard.ts`). And the copy sealed to the
 * backup password is made again at each change of the store, so the way to recover a lost key is never a week behind.
 */

import { dirname, join, readTextFileSync } from "@nouride/runtime";
import { installKeyLayout, KEY_FILE_VARIABLE, KEY_VARIABLE, SecretStore } from "@nouride/secrets";
import { contained, createLogger } from "@nouride/shared";
import { sealedSecretsCopy } from "@/modules/config/sealed-secrets.ts";
import { PENDING_FILE } from "@/service/update-guard.ts";

const log = createLogger("secrets");

/** How often a pending update is looked at again, until it is confirmed or rolled back. */
const PENDING_CHECK_MS = 60_000;

/**
 * Whether an update to the version running waits to be confirmed, as the guard's marker beside the binary says: only
 * then can the guard still put the previous version back. A marker for another version is stale (put back by hand, or
 * a test's): `confirm.ts` removes it, and it holds nothing here. One with no `to` is this version's, as there.
 */
function updatePending(installDir: string, version: string): boolean {
  let marked: { to?: unknown };
  try {
    marked = JSON.parse(readTextFileSync(join(installDir, PENDING_FILE))) as { to?: unknown };
  } catch (err) {
    // No marker is no update; a marker that cannot be read is one being written: waited for.
    return (err as { code?: string }).code !== "ENOENT";
  }
  const to = typeof marked?.to === "string" ? marked.to.replace(/^v/, "") : null;
  return to === null || to === version.replace(/^v/, "");
}

/** The install's folders, from where its config is: `<install>/.nouride/config.toml`. */
function installFolders(configPath: string): { nourideDir: string; installDir: string } {
  const nourideDir = dirname(configPath);
  return { nourideDir, installDir: dirname(nourideDir) };
}

export async function openSecretStore(paths: { dataDir: string; configPath: string; home?: string }): Promise<SecretStore> {
  const env = { ...process.env };
  delete process.env[KEY_VARIABLE];
  delete process.env[KEY_FILE_VARIABLE];
  // Root (a Box's daemon) makes a key in root's file, where `install.sh` would have.
  const layout = installKeyLayout({ dataDir: paths.dataDir, ...installFolders(paths.configPath), ...(paths.home ? { home: paths.home } : {}), root: process.getuid?.() === 0 });
  return await SecretStore.open(paths.dataDir, env, { layout, rekey: true });
}

/**
 * The store as a command run outside the service opens it: the same places for its key (root's file, read by root;
 * the install's `.env`; the key the daemon keeps), and never a key changed. A command with a stray key in its shell must
 * not lock the daemon out.
 */
export async function openCommandSecretStore(paths: { dataDir: string; configPath: string }): Promise<SecretStore> {
  return await SecretStore.open(paths.dataDir, commandStoreEnv(), { layout: commandKeyLayout(paths) });
}

/**
 * Whether a secret name holds a value, for a command's checks of the config — never the value. Nothing when the store
 * will not open here (its key is root's, say): a check that cannot see the store says nothing rather than call a key
 * that is there missing.
 */
export async function commandSecretLookup(paths: { dataDir: string; configPath: string }): Promise<((name: string) => boolean) | undefined> {
  try {
    const store = await openCommandSecretStore(paths);
    return (name) => store.has(name);
  } catch {
    return undefined;
  }
}

/** The key's variables as this command was started with them, out of its environment since (`keepStoreKeyAside`). */
let keptKey: Record<string, string> = {};

/**
 * As a command starts, every one but `start` (whose daemon does the same as it opens its store): the key's variables
 * out of the process's environment, kept here for the commands that open the store. The launcher hands root's key to
 * whatever root runs through it, and what a command starts (`tools run`'s installer and its package scripts, a coding
 * CLI's sign-in, `doctor`'s probes) must inherit nothing of it.
 */
export function keepStoreKeyAside(): void {
  keptKey = {};
  for (const name of [KEY_VARIABLE, KEY_FILE_VARIABLE]) {
    const value = process.env[name];
    if (value !== undefined) keptKey[name] = value;
    delete process.env[name];
  }
}

/** The environment a command opens the store with: its own, and the key it was started with. */
export function commandStoreEnv(): Record<string, string | undefined> {
  return { ...process.env, ...keptKey };
}

/** The key's places for a command run outside the service, as `openCommandSecretStore` uses them. */
export function commandKeyLayout(paths: { dataDir: string; configPath: string }): ReturnType<typeof installKeyLayout> {
  const home = process.env.HOME;
  return installKeyLayout({ dataDir: paths.dataDir, ...installFolders(paths.configPath), ...(home ? { home } : {}), root: process.getuid?.() === 0 });
}

/**
 * After boot: the sealed copy kept current, and `secrets.json` moved once no update is pending. The timer that waits
 * for a pending update to settle, for the daemon to stop at shutdown; null when there is none to wait for.
 */
export function settleSecretStore(
  secrets: SecretStore,
  deps: { dataDir: string; installDir: string; version: string; seal: () => string; pending?: () => boolean; checkEveryMs?: number },
): ReturnType<typeof setInterval> | null {
  secrets.onChange(contained(log, "could not seal the secret store's copy for the backup password", () => {
    sealedSecretsCopy(deps.dataDir, deps.seal(), secrets.sealedCopyText());
  }));
  const pending = deps.pending ?? (() => updatePending(deps.installDir, deps.version));
  const move = async (): Promise<void> => {
    try {
      await secrets.encryptAtRest();
    } catch (err) {
      // Kept as it was: `secrets.json`, which every version reads. Said, and tried again at the next start.
      log.error("could not encrypt the secret store; it stays as it was", { error: String(err) });
    }
  };
  if (!secrets.lock().encrypted && !pending()) {
    void move();
    return null;
  }
  if (secrets.lock().encrypted) return null;
  log.info("the secret store is encrypted once this update is confirmed: until then the previous version can still read it");
  const timer = setInterval(
    contained(log, "the wait for a pending update before encrypting the secret store failed", () => {
      if (pending()) return;
      clearInterval(timer);
      void move();
    }),
    deps.checkEveryMs ?? PENDING_CHECK_MS,
  );
  timer.unref?.();
  return timer;
}
