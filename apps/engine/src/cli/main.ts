#!/usr/bin/env bun
/**
 * `nouride` — the binary's entry.
 *
 * The CLI is its own package and imports nothing of the engine (`apps/cli`). This file is where the two meet: it
 * hands the CLI the install it runs in — the build's version, where the daemon is, the daemon's start, and the
 * commands that work on the install itself, which live in this folder because they read its files with the daemon
 * down or before it boots.
 *
 * It stays at this path: a daemon run from source is started as `bun …/apps/engine/src/cli/main.ts start`, and the
 * service unit of such an install names it.
 *
 * Shipped as one binary: `bun build --compile` (see `bun run build:binary`).
 */

import { runCli } from "@nouride/cli";
import { crashed, emit, fail, finish, GREEN, RESET, say } from "@nouride/cli-kit";
import {
  fileExistsSync,
  isProcessAlive,
  join,
  processCommandLine,
  readTextFileSync,
  removePath,
  signalProcess,
} from "@nouride/runtime";
import { keepStoreKeyAside } from "@/boot/secret-store.ts";
import { configCmd } from "@/cli/commands/config.ts";
import { db } from "@/cli/commands/db.ts";
import { doctor } from "@/cli/commands/doctor.ts";
import { gatewayRename } from "@/cli/commands/gateway-rename.ts";
import { pkg } from "@/cli/commands/pkg.ts";
import { rollback } from "@/cli/commands/rollback.ts";
import { decryptSecrets } from "@/cli/commands/secret-decrypt.ts";
import { restoreSecrets } from "@/cli/commands/secret-restore.ts";
import { service } from "@/cli/commands/service.ts";
import { runShared, tools } from "@/cli/commands/tools.ts";
import { users } from "@/cli/commands/users.ts";
import { daemonPlace } from "@/cli/connect.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { describeStop, stopDaemon } from "@/cli/stop.ts";
import { VERSION } from "@/commons/version.ts";
import { loadInstallEnv } from "@/modules/config/global/dotenv.ts";
import { executableRoot } from "@/modules/config/global/paths.ts";

/**
 * `nouride stop` — signal the running daemon and wait for it to go.
 *
 * Inline rather than in `commands/`, because it is the one command that reaches the daemon without
 * the control API: it reads the lock file and sends a signal, which is the path that still works
 * when the HTTP server is the thing that has wedged.
 */
async function stop(): Promise<void> {
  const { config } = await loadConfig();
  const lockPath = join(config.daemon.dataDir, "nouride.lock");
  const outcome = await stopDaemon(
    {
      readLock: () => (fileExistsSync(lockPath) ? readTextFileSync(lockPath) : null),
      // `removePath` is already best-effort — a lock that is gone is the outcome either way.
      removeLock: () => removePath(lockPath),
      lockExists: () => fileExistsSync(lockPath),
      isAlive: isProcessAlive,
      commandLine: processCommandLine,
      signal: signalProcess,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    config.daemon.shutdownTimeoutMs,
  );
  const { text, ok, hint } = describeStop(outcome);
  if (!ok) fail(text, hint);
  emit({ stopped: true, note: text });
  return say(`${GREEN}✓${RESET} ${text}`);
}

/** `nouride start` — the daemon, in this process. */
async function start(): Promise<void> {
  // The install's own `.env`, for the daemon only — the binary no longer reads one from wherever it runs
  // (`config/global/dotenv.ts`). Before the config is read, which it may point somewhere.
  loadInstallEnv(executableRoot());
  // Imported lazily so `nouride chat` does not open the database or bind a port. `index.ts`
  // guards its own auto-boot with `import.meta.main`, so this import does not start anything.
  const { runDaemon } = await import("@/index.ts");
  try {
    await runDaemon();
  } catch (err) {
    crashed(err);
  }
}

// Every way out prints the envelope under `--json`: a throw nothing above caught is a failure, said as one, rather
// than an empty stdout and a stack trace — what a script or an agent's tool cannot read.
await runCli({
  version: VERSION,
  daemonPlace,
  keepStoreKeyAside,
  start,
  stop,
  installShared: runShared,
  // Imported when asked for: it is the one command that makes the install the others read.
  setup: async (args) => (await import("@/cli/setup.ts")).setup(args),
  service,
  doctor,
  pkg,
  tools,
  config: configCmd,
  db,
  users,
  gatewayRename,
  decryptSecrets,
  restoreSecrets,
  rollback,
}).catch(crashed);
finish();
