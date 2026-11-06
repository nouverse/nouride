/**
 * An external agent's profiles (0.8.1): each one sign-in of its CLI, kept in the agent's own folder
 * (`.cli/<cli>/<profile>`), one of them the one it answers with. The Brain tab lists them with whether each is signed in —
 * asked of the CLI, by a session it opens or refuses — so what exists and what each is shows after a restart too, when
 * the daemon has forgotten every sign-in it watched.
 */

import { join, listDir } from "@nouride/runtime";
import { PROFILE_NAME } from "@nouride/persona";

export interface CliProfile {
  name: string;
  /** The one the agent answers with. */
  inUse: boolean;
  /** Null where the CLI did not get as far as saying: not installed, failed to start. */
  signedIn: boolean | null;
  /** Why it cannot answer on this profile, in the words its status uses, or null. */
  reason: string | null;
}

/** The profiles an agent has for a CLI — its folders, and the one its pack names, folder or not — that one first. */
export function profileNames(privateDir: string, cli: string, inUse: string): string[] {
  const folders = listDir(join(privateDir, ".cli", cli))
    .filter((entry) => entry.isDirectory && PROFILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return [inUse, ...folders.filter((name) => name !== inUse)];
}
