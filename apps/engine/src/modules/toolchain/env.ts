/**
 * Where the programs agents install go — without root, and without a flag anybody has to remember.
 *
 * The daemon runs as an unprivileged account under `ProtectSystem=strict`, so every installer's
 * default for a global install is a directory it cannot write: `npm i -g` reaches for `/usr`, `pip`
 * meets PEP 668, rustup and pipx put their programs in directories nothing had on PATH. An agent that
 * meets one of those walls does not stop. It improvises — `--prefix` by hand, a venv in the scratchpad
 * that the sweep deletes three days later, a binary nothing can find again — and the next agent starts
 * over. Measured on the live box: rustup off PATH, a venv built in the scratchpad, 107 `which` probes
 * for programs that were already installed.
 *
 * So the installers are pointed here instead, by the settings each of them already reads. The commands
 * agents type, and the ones every README and skill prints, then land in `.nouride/bin` the first time:
 * on PATH for every command, kept across restarts, updates and container recreates, and never in the
 * scratchpad. Nothing is wrapped and no installer is replaced.
 *
 * Paths, not credentials, so they travel through `exec`'s environment allowlist by name — never through
 * `exec_secrets`, whose values are masked in output and would hide every path that starts the same way.
 *
 * pnpm is deliberately absent. `PNPM_HOME` would put its global store inside the bin directory, and the
 * npm-side setting for it makes npm 11 warn on every command; `npm i -g` already works for the same
 * packages, which is what the hint for pnpm's error says.
 */

import { join } from "@nouride/runtime";

/** What boot sets, by name — and so what `exec` lets through to a child. */
export const TOOLCHAIN_ENV_NAMES = [
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "BUN_INSTALL_BIN",
  "BUN_INSTALL_GLOBAL_DIR",
  "UV_TOOL_BIN_DIR",
  "UV_TOOL_DIR",
  "UV_PYTHON_INSTALL_DIR",
  "UV_PYTHON_INSTALL_BIN",
  "UV_NO_MODIFY_PATH",
  "INSTALLER_NO_MODIFY_PATH",
  "XDG_BIN_HOME",
  "PIPX_HOME",
  "PIPX_BIN_DIR",
  "GOBIN",
  "CARGO_INSTALL_ROOT",
  "PIP_DISABLE_PIP_VERSION_CHECK",
] as const;

export type ToolchainEnvName = (typeof TOOLCHAIN_ENV_NAMES)[number];

/**
 * The settings for an install whose data directory is `<nouride>/data`.
 *
 * `opt/` holds what is more than one file — bun's and pipx's packages, uv's tools and Pythons, the
 * shared Python env — so the bin directory stays a list of commands. `CARGO_INSTALL_ROOT` is the
 * install itself because cargo appends `bin/` to it.
 */
export function toolchainEnv(nouride: string): Record<ToolchainEnvName, string> {
  const bin = join(nouride, "bin");
  const opt = join(nouride, "opt");
  return {
    NPM_CONFIG_PREFIX: nouride,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    BUN_INSTALL_BIN: bin,
    BUN_INSTALL_GLOBAL_DIR: join(opt, "bun"),
    UV_TOOL_BIN_DIR: bin,
    UV_TOOL_DIR: join(opt, "uv", "tools"),
    UV_PYTHON_INSTALL_DIR: join(opt, "uv", "python"),
    // Otherwise `uv python install` drops `python3.x` into ~/.local/bin, ahead of nothing and owned by nobody.
    UV_PYTHON_INSTALL_BIN: "0",
    // Installer scripts (uv's, and every cargo-dist one) edit shell profiles unless told not to; the
    // PATH here is decided at spawn, and a profile edit would only add a second, stale opinion.
    UV_NO_MODIFY_PATH: "1",
    INSTALLER_NO_MODIFY_PATH: "1",
    XDG_BIN_HOME: bin,
    PIPX_HOME: join(opt, "pipx"),
    PIPX_BIN_DIR: bin,
    GOBIN: bin,
    CARGO_INSTALL_ROOT: nouride,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}

/** The Python env every agent shares — see `python.ts`. */
export function pythonEnvDir(nouride: string): string {
  return join(nouride, "opt", "python");
}

/**
 * One PATH for every command an agent runs.
 *
 * In this order, and the order is the decision:
 *
 * 1. the bin directory, so a newer CLI an agent installed wins over the distribution's copy;
 * 2. the shared Python env's bin, so `python3`, `pip` and what pip installs are the env's and PEP 668
 *    no longer applies — behind the bin directory, so a tool installed there still wins;
 * 3. the PATH the daemon started with — the system's own directories;
 * 4. last, the two directories installers put programs in by default when nothing redirected them:
 *    `~/.local/bin` (pip `--user`, pipx and uv defaults, Claude Code's installer) and `~/.cargo/bin`
 *    (rustup). Last, so nothing there can shadow a system program.
 *
 * The shell that runs a command is resolved with all of these taken off (`withBinFirst` in the
 * runtime), so a `bash` dropped into any of them is never the one that starts a script.
 */
export function composePath(input: { bin: string; python?: string; startup: string; home?: string }): string {
  const tails = input.home ? [join(input.home, ".local", "bin"), join(input.home, ".cargo", "bin")] : [];
  const parts = [input.bin, ...(input.python ? [join(input.python, "bin")] : []), ...input.startup.split(":"), ...tails];
  return [...new Set(parts.filter((part) => part !== ""))].join(":");
}

/**
 * A command run as its agent's own user (0.8.0): HOME is its own folder, and what it installs lands there —
 * `~/.local/bin`, `~/.local/opt`, its own Python env in `~/.local/opt/python` — first on its PATH. What is installed for
 * every agent stays on it behind them, to run and never to write (`toolchain/shared-tools.ts`): the shared bin
 * directory and Python env, and last, as before, the tools in the daemon's HOME — `claude`, Rust's proxies. Rust's
 * toolchains are the shared ones (`RUSTUP_HOME`), and what cargo downloads goes in its own HOME.
 *
 * `daemonPath` is the PATH boot composed; `rustupHome`, the shared one, where there is one.
 */
export function ownUserEnv(home: string, daemonPath: string, rustupHome?: string): Record<string, string> {
  const local = join(home, ".local");
  const bin = join(local, "bin");
  const shared = daemonPath.split(":").filter((dir) => dir !== "");
  const path = [...new Set([bin, join(pythonEnvDir(local), "bin"), ...shared, join(home, ".cargo", "bin")])].join(":");
  // `$NOURIDE_BIN` is where the prompt and the skills say to put a program: its own, here.
  return { HOME: home, ...toolchainEnv(local), NOURIDE_BIN: bin, PATH: path, NOURIDE_PATH: path, ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}) };
}

/**
 * Where an agent's programs are, for what it is told (`HarnessFacts`): its own `~/.local/bin`, where it is its own
 * user, with the directory every agent shares behind it — or that shared one alone, as before.
 */
export function agentBins(sharedBin: string | undefined, privateDir: string | undefined, ownUsers: boolean): { binDir?: string; ownHome?: string; sharedBinDir?: string } {
  if (!ownUsers || !privateDir) return sharedBin ? { binDir: sharedBin } : {};
  return { binDir: join(privateDir, ".local", "bin"), ownHome: privateDir, ...(sharedBin ? { sharedBinDir: sharedBin } : {}) };
}
