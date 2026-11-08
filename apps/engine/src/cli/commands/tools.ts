/**
 * `nouride tools run -- <command…>` — install or update a program every agent runs (0.8.0, `toolchain/shared-tools.ts`).
 *
 * Run as the daemon's user, in its HOME, with every installer pointed at the shared folders — `npm i -g` into
 * `.nouride/bin`, `claude update` and `rustup update` where they were installed — and then made every agent's to run.
 * No daemon involved. An agent reaches it through the `nouride` tool, which offers it to the orchestrator alone; an
 * agent's own command cannot, being its own user, which may not write there.
 */

import { dirname, join, runCommand } from "@nouride/runtime";
import { DIM, GREEN, RESET, YELLOW, emit, fail, say, usageError } from "@/cli/ui.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { composePath, pythonEnvDir, toolchainEnv } from "@/modules/toolchain/env.ts";
import { notAnInstall } from "@/modules/toolchain/installers.ts";
import { shareTools, sharedToolDirs } from "@/modules/toolchain/shared-tools.ts";

const USAGE = "nouride tools run -- <installer …>";
/** As long as an install of a whole toolchain takes, and no longer. */
const RUN_TIMEOUT_MS = 30 * 60_000;

export async function tools(args: readonly string[]): Promise<void> {
  const [action, separator, ...command] = args;
  if (action !== "run" || separator !== "--" || command.length === 0) return usageError(`unknown: nouride tools ${args.join(" ")}`, USAGE);
  const refused = notAnInstall(command);
  if (refused) return fail(refused, "To change an agent, use its own commands: `nouride agent …`.");
  const { exitCode, shared } = await runShared(command);
  if (!shared) return fail(`${command.join(" ")} did not finish (exit ${exitCode ?? "killed"})`, "Nothing was shared with the other agents.");
  emit({ command, exitCode, shared: shared.ok, ...(shared.problem ? { problem: shared.problem } : {}) });
  if (!shared.ok) {
    say(`${YELLOW}!${RESET} installed, but not every agent can run it yet: ${shared.problem}`);
    process.exitCode = 1;
    return;
  }
  say(`${GREEN}✓${RESET} done, and every agent can run it`);
}

/**
 * `command` run as `tools run` runs it — this user, its HOME, every installer pointed at the shared folders, what it
 * prints shown as it prints it — and what it installed then shared with every agent. `shared` is null where it did not
 * finish: nothing was shared. `nouride agents update` installs a coding CLI's version this way too (0.8.24).
 */
export async function runShared(command: readonly string[]): Promise<{ exitCode: number | null; shared: { ok: boolean; problem?: string } | null }> {
  const { config } = await loadConfig();
  const nouride = dirname(config.daemon.dataDir);
  const home = join(nouride, "home");
  const bin = join(nouride, "bin");
  const path = composePath({ bin, python: pythonEnvDir(nouride), startup: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", home });
  const env = { ...toolchainEnv(nouride), HOME: home, PATH: path, NOURIDE_BIN: bin, NOURIDE_PATH: path, LANG: process.env.LANG ?? "C.UTF-8" };
  const ran = await runCommand([...command], {
    cwd: home,
    env,
    timeoutMs: RUN_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
    onOutput: (stream, text) => (stream === "stdout" ? process.stdout : process.stderr).write(`${DIM}${text}${RESET}`),
  });
  if (ran.exitCode !== 0) return { exitCode: ran.exitCode, shared: null };
  return { exitCode: ran.exitCode, shared: await shareTools(sharedToolDirs(nouride, home)) };
}
