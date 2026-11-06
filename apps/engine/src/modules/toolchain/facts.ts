/**
 * What an agent has to know about this host before it installs or runs anything, and nothing more.
 *
 * Each of these answers a question agents were spending tool calls on, or getting wrong:
 *
 * - **What is already installed.** 107 `which` probes on the live box, a third of them failing, and
 *   59 calls to a program by its full path inside the bin directory — while the prompt never said what
 *   the directory held. The list is read from the directory itself, so it cannot go stale.
 * - **Which build to download.** An x86_64 binary on ARM fails with `Exec format error`, a glibc build
 *   on Alpine with `not found` for a file that is plainly there; both read like a corrupt download.
 * - **Which installers exist here.** The install steps named `uv tool install` on a box with no uv.
 */

import { dirname, join, listDir, resolve, runningPlatform, statFile, whichBinary } from "@nouride/runtime";

/** `<install>/.nouride/bin` for an install whose data directory is `<install>/.nouride/data`. */
export function binDirFor(dataDir: string): string {
  return join(dirname(dataDir), "bin");
}

/**
 * HOME, when it is the agents' own (`.nouride/home`), else null.
 *
 * The line between a service and a person's own machine: a unit and the container image both give the
 * agents this HOME, and a `nouride start` in a checkout leaves the developer's. Everything that redirects
 * an installer keys on it, so a developer's own npm and pip are never repointed.
 */
export function agentsOwnHome(dataDir: string): string | null {
  const home = process.env.HOME;
  return home && resolve(home) === resolve(join(dirname(dataDir), "home")) ? home : null;
}

export interface HostFacts {
  platform: string;
  /** As release assets name it: `x86_64`, `aarch64`. */
  arch: string;
  /** Linux only; null elsewhere. */
  libc: "glibc" | "musl" | null;
}

let host: HostFacts | undefined;

function hostFacts(): HostFacts {
  // The machine's, not the build's folded constants (`runningPlatform`): agents fetch binaries by what this says.
  const { platform, arch } = runningPlatform();
  host ??= {
    platform,
    arch: arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch,
    // musl's loader is the one file every musl system has and no glibc system does.
    libc: platform !== "linux" ? null : listDir("/lib").some((entry) => entry.name.startsWith("ld-musl-")) ? "musl" : "glibc",
  };
  return host;
}

/** `linux/x86_64 with glibc`, as the install steps say it. */
export function describeHost(facts: HostFacts = hostFacts()): string {
  return `${facts.platform}/${facts.arch}${facts.libc ? ` with ${facts.libc}` : ""}`;
}

let listed: { key: string; names: string[] } | undefined;

/**
 * What the bin directory holds, by name — re-read only when the directory changes, so a prompt built
 * every turn costs one `stat`.
 */
export function installedTools(bin: string): string[] {
  const stat = statFile(bin);
  if (!stat) return [];
  const key = `${bin}\u0000${stat.mtimeMs}`;
  if (listed?.key !== key) {
    listed = { key, names: listDir(bin).map((entry) => entry.name).filter((name) => !name.startsWith(".")).sort() };
  }
  return listed.names;
}

const INSTALLERS: [program: string, command: string][] = [
  ["npm", "`npm i -g`"],
  ["bun", "`bun add -g`"],
  ["pipx", "`pipx install`"],
  ["uv", "`uv tool install`"],
  ["go", "`go install`"],
  ["cargo", "`cargo install`"],
];

let found: { at: number; commands: string[] } | undefined;

/**
 * The global-install commands this host can actually run, in the form agents type them.
 *
 * Looked up on the composed PATH, so rustup's `cargo` in `~/.cargo/bin` counts. Re-checked once a
 * minute: an agent that installs uv should see `uv tool install` offered without a restart.
 */
export function installCommands(now = Date.now()): string[] {
  if (!found || now - found.at > 60_000) {
    found = { at: now, commands: INSTALLERS.filter(([program]) => whichBinary(program) !== null).map(([, command]) => command) };
  }
  return found.commands;
}

/**
 * Directories an agent with a shell may `read` by path, and never write with the file tools: its HOME
 * when it is the agents' own, and the install's program directories (`bin`, `lib`, `opt`).
 *
 * The file tools refused them while `exec cat` read them fine — the shape where a limit exists on paper
 * only, and the one that taught agents to reach for the shell to read a config. Credential files in
 * them are read with their values hidden (`tools/credential-files.ts`), and a search with no path skips
 * them: they are full of caches, not of anything a person means by "the project".
 */
export function hostReadRoots(bin: string | undefined = process.env.NOURIDE_BIN): string[] {
  if (!bin) return [];
  const nouride = dirname(bin);
  const home = agentsOwnHome(join(nouride, "data"));
  return [...(home ? [home] : []), bin, join(nouride, "lib"), join(nouride, "opt")];
}
