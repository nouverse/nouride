/**
 * Where agents' installs land, and the one PATH every command gets — settled once, right after the
 * agents' HOME (`agent-home.ts`). The why is in `modules/toolchain/env.ts`.
 *
 * Only where HOME is the agents' own: a unit or the container image. On a person's own machine a
 * `nouride start` must not repoint their npm and pip, so there the PATH is what it always was.
 *
 * A value already in the daemon's environment wins, and is what the agents get — unless it names a
 * directory this process cannot write, which no install could use. The container image is the case:
 * its base sets `BUN_INSTALL_BIN=/usr/local/bin`, root's, so every `bun add -g` failed with EACCES and
 * an "operator's value wins" rule would have kept it failing. `NOURIDE_PATH` is the composed PATH under
 * its own name, because a login shell's profile resets `PATH` and the runtime puts this one back after
 * it (`withBinFirst`).
 */

import { createLogger, type GlobalConfig } from "@nouride/shared";
import { dirExists, dirname, isWritableDir, join, whichBinary } from "@nouride/runtime";
import { composePath, pythonEnvDir, toolchainEnv } from "@/modules/toolchain/env.ts";
import { binProblems, binReport } from "@/modules/toolchain/bin-report.ts";
import { agentsOwnHome } from "@/modules/toolchain/facts.ts";
import { ensurePythonEnv } from "@/modules/toolchain/python.ts";

const log = createLogger("daemon");

/** Whether `dir`, or the nearest of its parents that exists, is a directory this process can write into. */
function canWriteUnder(dir: string): boolean {
  let at = dir;
  while (!dirExists(at) && dirname(at) !== at) at = dirname(at);
  return isWritableDir(at);
}

export function settleToolchain(config: GlobalConfig, buildPythonEnv: typeof ensurePythonEnv = ensurePythonEnv): void {
  const nouride = dirname(config.daemon.dataDir);
  const bin = process.env.NOURIDE_BIN ?? join(nouride, "bin");
  // What the daemon started with: `settleAgentHome` has already put the bin directory in front.
  const startup = (process.env.PATH ?? "").split(":").filter((dir) => dir !== bin).join(":");
  const home = agentsOwnHome(config.daemon.dataDir);
  const python = home ? pythonEnvDir(nouride) : undefined;

  const replaced: string[] = [];
  if (home) {
    for (const [name, value] of Object.entries(toolchainEnv(nouride))) {
      const current = process.env[name];
      if (current !== undefined && (!value.startsWith("/") || canWriteUnder(current))) continue;
      if (current !== undefined) replaced.push(`${name}=${current}`);
      process.env[name] = value;
    }
  }
  process.env.PATH = process.env.NOURIDE_PATH = composePath({ bin, startup, ...(python ? { python } : {}), ...(home ? { home } : {}) });
  // Said once at boot, so a broken or shadowing entry is found before an agent trips on it.
  const problems = binProblems(binReport(bin)).map((found) => found.problem);
  if (problems.length > 0) log.warn("the agents' bin directory needs a look (`nouride doctor` lists it)", { bin, problems });
  if (!home || !python) return;

  log.info("agents install into .nouride: global npm, bun, pipx, uv, go and cargo installs land in its bin", {
    bin,
    python: join(python, "bin"),
    path: process.env.PATH,
    ...(replaced.length > 0 ? { replaced_unwritable: replaced } : {}),
  });
  // Not awaited: building it takes seconds, nothing at boot needs it, and a failure is reported, not fatal.
  // The system's python3, found on the PATH the daemon started with — never the env's own.
  void buildPythonEnv(python, {
    python: whichBinary("python3", startup),
    env: { PATH: startup, HOME: home, LANG: process.env.LANG ?? "C.UTF-8" },
  }).catch((err) => log.warn("could not check the shared Python env", { error: String(err) }));
}
