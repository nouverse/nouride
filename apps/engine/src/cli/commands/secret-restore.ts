/**
 * `nouride secret restore [<file>] --stdin` (0.8.19): the secrets back from a copy sealed to the backup password, the
 * passphrase on stdin, stored under this install's key. For when the daemon cannot open its store: a lost key, an
 * install moved to another machine without it. The copy by default is the one beside the store, made again at each
 * change (`data/secrets.sealed`); a snapshot's is named.
 *
 * Refused while the daemon runs: it opens its store, so there is nothing to recover, and two writers of one store are
 * how secrets get lost. A store this command cannot open is set aside under another name, never written over.
 */

import { fileExistsSync, join, openWithPassphrase, readBytesSync, readStdin } from "@nouride/runtime";
import { SecretError, SecretStore, secretsOf } from "@nouride/secrets";
import { hasFlag, BOLD, DIM, GREEN, RESET, YELLOW, fail, say, usageError } from "@nouride/cli-kit";
import { runningDaemon } from "@/cli/daemon-lock.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { commandKeyLayout, commandStoreEnv } from "@/boot/secret-store.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";

export async function restoreSecrets(args: string[]): Promise<void> {
  if (!hasFlag(args, "--stdin")) return usageError("The backup password, on stdin?", "nouride secret restore [<file>] --stdin");
  const { config, source } = await loadConfig();
  const dataDir = config.daemon.dataDir;
  const file = args.find((arg) => !arg.startsWith("--")) ?? join(dataDir, "secrets.sealed");
  if (!fileExistsSync(file)) {
    return fail(`${file} is not there.`, "Name a snapshot's copy: <backups>/config/<date>/secrets.sealed, as `nouride secret list` says where the backups are.");
  }
  if (runningDaemon(dataDir) !== null) {
    return fail("Nouride is running, so it opens its secrets: restore is for when it cannot.", "To put back an older copy anyway, stop Nouride first.");
  }
  const passphrase = (await readStdin()).trim();
  if (!passphrase) return fail("--stdin was given but nothing arrived on stdin");

  let secrets: ReturnType<typeof secretsOf>;
  try {
    secrets = secretsOf(JSON.parse(new TextDecoder().decode(openWithPassphrase(passphrase, readBytesSync(file)))) as unknown, file);
  } catch (err) {
    return fail(`${file} did not open: ${err instanceof Error ? err.message : String(err)}.`, "It opens with the backup password set before that copy was made.");
  }
  try {
    const layout = commandKeyLayout({ dataDir, configPath: source ?? defaultConfigPath() });
    const done = await SecretStore.restore(dataDir, secrets, commandStoreEnv(), { layout });
    const store = await SecretStore.open(dataDir, commandStoreEnv(), { layout });
    const key = store.lock().key;
    say(`${GREEN}✓${RESET} ${BOLD}${Object.keys(secrets).length}${RESET} secret(s) restored, encrypted with the key in ${key?.where ?? "this install"} ${DIM}(values not shown)${RESET}`);
    if (done.setAside) say(`${YELLOW}!${RESET} the store this could not open is kept as ${done.setAside}: remove it once you no longer need it.`);
  } catch (err) {
    if (err instanceof SecretError) return fail(err.message);
    throw err;
  }
}
