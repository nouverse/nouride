/**
 * The install a command runs in, as the binary's entry hands it over.
 *
 * The CLI imports nothing of the engine. What it needs of the install it is part of comes in here: the build's
 * version, where the daemon is, the daemon's own start, and the commands that work on the install itself — the ones
 * that read its files with the daemon down or before it boots, which are the engine's and are only dispatched from
 * here.
 */

import type { Locate } from "@nouride/cli-kit";
import type { InstallShared } from "./commands/agents-update.ts";

/** A command that works on the install itself, given the arguments after its name. */
type Local = (args: string[]) => Promise<void>;

export interface Install {
  /** The version of the build this is. */
  version: string;
  /** Where this install's daemon is, read from the config the daemon read. */
  daemonPlace: Locate;
  /** The secret store's key, which the launcher hands root's commands, out of the environment before a command runs. */
  keepStoreKeyAside(): void;
  /** `nouride start`: the daemon, in this process. */
  start(): Promise<void>;
  /** `nouride stop`: signal the running daemon and wait for it to go. */
  stop(): Promise<void>;
  /** A program installed for every agent, as `nouride tools run` does: what `agents update` installs a coding CLI with. */
  installShared: InstallShared;
  setup: Local;
  service: Local;
  doctor: Local;
  pkg: Local;
  tools: Local;
  config: Local;
  db: Local;
  users: Local;
  gatewayRename: Local;
  decryptSecrets: Local;
  restoreSecrets: Local;
  rollback: Local;
}
