/**
 * The control token: the credential the CLI presents, and where it comes from.
 */

import { fileExists, join, randomHex, readTextFile, setFileMode, writeTextFileAtomic } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";

const log = createLogger("web.control");

const TOKEN_FILE = ".control-token";

/**
 * Read the control token, generating it if absent.
 *
 * Stored rather than derived so the CLI can read the same value without being handed a secret,
 * and regenerated only by deleting the file — a token that rotated on every boot would break a
 * long-running `nouride chat`.
 *
 * File mode is 0640: owner (nouride) can read/write, service group (nouride) can read,
 * other users have no access. This allows operators added to the service group to run
 * CLI commands without requiring sudo.
 */
export async function ensureControlToken(dataDir: string): Promise<string> {
  const path = join(dataDir, TOKEN_FILE);

  if (await fileExists(path)) {
    const existing = (await readTextFile(path)).trim();
    if (existing) {
      setFileMode(path, 0o640);
      return existing;
    }
  }

  const token = randomHex(32);
  // Created 0640 rather than written with the umask's mode and narrowed after (`writeTextFileAtomic`).
  await writeTextFileAtomic(path, `${token}\n`, { mode: 0o640 });
  if (!setFileMode(path, 0o640)) {
    log.warn("could not set 0640 on the control token", { path });
  }
  log.info("generated a control token", { path });
  return token;
}
