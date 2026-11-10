/**
 * `nouride secret decrypt --out <path>` (0.8.19): the store as a version before 0.8.19 reads it, `secrets.json`'s names
 * and values, for the way back. Local, with no daemon, by the user the key is readable by: root, where `install.sh`
 * keeps it in `/etc/nouride/nouride.env`.
 *
 * Never to the screen, for the reason `secret` has no read verb (`commands/secret.ts`); never over a file that is
 * there; and written 0600 from its creation. Back on 0.8.19 later, a `secrets.json` newer than the encrypted store is
 * what is read and encrypted again, so what the older version changed comes along.
 */

import { fileExistsSync, writeBytesSync } from "@nouride/runtime";
import { SecretError } from "@nouride/secrets";
import { flagValue, BOLD, DIM, GREEN, RESET, fail, say, usageError } from "@nouride/cli-kit";
import { loadConfig } from "@/cli/load-config.ts";
import { openCommandSecretStore } from "@/boot/secret-store.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";

export async function decryptSecrets(args: string[]): Promise<void> {
  const out = flagValue(args, "--out");
  if (!out) return usageError("Where to?", "nouride secret decrypt --out <path>");
  if (fileExistsSync(out)) return fail(`${out} is already there.`, "Move it aside first: decrypt never writes over a file.");
  const { config, source } = await loadConfig();
  let text: string;
  try {
    const store = await openCommandSecretStore({ dataDir: config.daemon.dataDir, configPath: source ?? defaultConfigPath() });
    text = store.plainCopy();
  } catch (err) {
    if (err instanceof SecretError) return fail(err.message);
    throw err;
  }
  writeBytesSync(out, new TextEncoder().encode(text), 0o600);
  say(`${GREEN}✓${RESET} written to ${BOLD}${out}${RESET} ${DIM}(0600, values not shown)${RESET}`);
  say(`${DIM}  For a version before 0.8.19: stop Nouride, put it at .nouride/data/secrets.json, then install that version.${RESET}`);
}
