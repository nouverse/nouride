/**
 * The client to this install's daemon.
 *
 * Where the daemon is comes from the config it read, which only the install's own code opens: the port, the data
 * directory with its control token, and the fingerprint its `/health` names.
 */

import { connectTo, type Client, type DaemonPlace } from "@nouride/cli-kit";
import { loadConfig } from "@/cli/load-config.ts";
import { installEnvPort } from "@/modules/config/global/dotenv.ts";
import { installFingerprint } from "@/modules/web/health.ts";
import { startHint } from "@/service/hints.ts";

/** Where this install's daemon is, as its config says. */
export async function daemonPlace(options: { soft?: boolean } = {}): Promise<DaemonPlace> {
  // As a client: `PORT` and `HOST` are the daemon's, and a web project's `.env` sets both (`applyEnvOverrides`).
  const { config } = await loadConfig({ client: true, ...(options.soft ? { soft: true } : {}) });
  // The port the daemon takes: `NOURIDE_PORT` when the caller names one, else its install's `.env` (`installEnvPort`),
  // else the config's.
  const port = process.env.NOURIDE_PORT ? config.dashboard.port : (installEnvPort(config.daemon.dataDir) ?? config.dashboard.port);
  return {
    port,
    dataDir: config.daemon.dataDir,
    install: installFingerprint(config.daemon.dataDir),
    controlEnabled: config.control.enabled,
    startHint: () => startHint(),
  };
}

/** Build a client against this install's running daemon. */
export function connect(options: { soft?: boolean } = {}): Promise<Client> {
  return connectTo(daemonPlace, options);
}
