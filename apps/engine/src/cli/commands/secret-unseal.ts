/**
 * `nouride secret unseal <file> --stdin --out <path>`: a snapshot's `secrets.sealed` (0.8.18) opened with the
 * backup passphrase into a file of its own, at 0600. Local, with no daemon: it is for the box being rebuilt.
 *
 * Never to the screen, for the reason `secret` has no read verb (`commands/secret.ts`); and never over a file that is
 * there, so a slip of the path cannot replace the live store with last week's.
 */

import { fileExistsSync, openWithPassphrase, readBytesSync, readStdin, writeBytesSync } from "@nouride/runtime";
import { flagValue, hasFlag } from "@/cli/args.ts";
import { BOLD, DIM, GREEN, RESET, fail, say, usageError } from "@/cli/ui.ts";

export async function unsealSecrets(args: string[]): Promise<void> {
  const out = flagValue(args, "--out");
  const file = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--out");
  if (!file || !out || !hasFlag(args, "--stdin")) {
    return usageError("Which file, and where to?", "nouride secret unseal <snapshot>/secrets.sealed --stdin --out <path>, the passphrase on stdin");
  }
  if (!fileExistsSync(file)) return fail(`${file} is not there.`);
  if (fileExistsSync(out)) return fail(`${out} is already there.`, "Move it aside first: unseal never writes over a file.");
  const passphrase = (await readStdin()).trim();
  if (!passphrase) return fail("--stdin was given but nothing arrived on stdin");

  let store: Uint8Array;
  try {
    store = openWithPassphrase(passphrase, readBytesSync(file));
  } catch (err) {
    return fail(`${file} did not open: ${err instanceof Error ? err.message : String(err)}.`, "It opens with the passphrase `nouride secret seal` was given before that snapshot was taken.");
  }
  writeBytesSync(out, store, 0o600);
  say(`${GREEN}✓${RESET} opened into ${BOLD}${out}${RESET} ${DIM}(0600, values not shown)${RESET}`);
  say(`${DIM}  To put the secrets back in the store, use restore instead: nouride secret restore ${file} --stdin${RESET}`);
}
