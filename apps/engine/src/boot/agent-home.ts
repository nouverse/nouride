/**
 * Where the agents' programs live, and what HOME they run with.
 *
 * - `.nouride/bin` first on PATH, and named `NOURIDE_BIN` so a shell script whose login profile resets
 *   PATH gets it back (`withBinFirst` in the runtime).
 * - HOME is `.nouride/home` for a service. The unit says so since 0.6, but an install upgraded with
 *   `nouride update` keeps the unit it had — HOME the install directory itself — and a daemon cannot
 *   rewrite `/etc`. So when HOME is still the install directory, the agents get `.nouride/home` all the
 *   same. What they had built in the old one was copied across by every 0.7.x start, and the upgrade
 *   floor makes sure one ran. A person's own home — a Mac, a plain `nouride start` — is left alone.
 */

import { dirname, ensureDir, join, passwdHome, resolve } from "@nouride/runtime";
import { settleSsh } from "@/boot/ssh-config.ts";
import { createLogger, type GlobalConfig } from "@nouride/shared";

const log = createLogger("daemon");

/** `account` is the home /etc/passwd gives the service user — named so a test can give its own. */
export function settleAgentHome(config: GlobalConfig, account: string | null = passwdHome()): void {
  const nouride = dirname(config.daemon.dataDir);
  const bin = join(nouride, "bin");
  ensureDir(bin);
  process.env.PATH = `${(process.env.NOURIDE_BIN = bin)}:${process.env.PATH ?? ""}`;
  homeInsideInstall(nouride);
  // ssh reads /etc/passwd's home, not this HOME: bridged here, on every start, whatever the install came from.
  settleSsh({ home: process.env.HOME, passwdHome: account, bin, path: process.env.PATH });
}

function homeInsideInstall(nouride: string): void {
  const home = process.env.HOME;
  if (!home || resolve(home) !== resolve(dirname(nouride))) return;
  const agentHome = join(nouride, "home");
  ensureDir(join(agentHome, ".ssh"));
  process.env.HOME = agentHome;
  log.info("the agents' HOME is .nouride/home", { home: agentHome });
}
