/**
 * What `nouride tools run` runs (0.8.1), and why it will not run the rest: read by the command itself, and by the
 * `nouride` tool before its gate asks anyone — a call it would refuse is refused there, so nobody approves it first (on
 * the live box a person said yes to an `ln -s` through it, which the command then refused).
 */

const global = (rest: readonly string[]) => rest.includes("-g") || rest.includes("--global");
const first = (...verbs: string[]) => (rest: readonly string[]) => verbs.includes(rest[0] ?? "");

/**
 * What `tools run` runs (0.8.1): an installer installing, updating or removing a program for every agent — nothing
 * else. It runs as the daemon's user, who owns every pack, the database and the secret store; on the live box the
 * orchestrator ran `cat` on another agent's config.toml through it, which no tool of its own let it read.
 */
const INSTALLERS: Record<string, (rest: readonly string[]) => boolean> = {
  npm: (rest) => first("i", "install", "update", "up", "upgrade", "uninstall", "un", "rm", "remove")(rest) && global(rest),
  bun: (rest) => first("add", "i", "install", "remove", "rm", "update")(rest) && global(rest),
  pipx: first("install", "upgrade", "upgrade-all", "uninstall", "reinstall"),
  uv: (rest) => (rest[0] === "tool" && ["install", "upgrade", "uninstall"].includes(rest[1] ?? "")) || (rest[0] === "python" && ["install", "uninstall"].includes(rest[1] ?? "")),
  pip: first("install", "uninstall"),
  pip3: first("install", "uninstall"),
  cargo: first("install", "uninstall"),
  go: first("install"),
  rustup: first("update", "toolchain", "component", "target", "default"),
  claude: first("update"),
};

/**
 * Flags that would put what is installed somewhere else, or read or write a file: where a program lands is the shared
 * folders this command points every installer at, and what is installed is a package by its name, not a path on this
 * box — a `pip install -r` of a file the daemon's user can read prints what it could not parse. Read by the name before
 * any `=`: only the bare word was, so `pip install --report=<data>/secrets.json` passed, and pip writes its report where
 * it is told — over the secret store. pip, npm, bun, pipx, uv and cargo; Go's are `GO_ELSEWHERE`.
 */
const ELSEWHERE = new Set([
  "--prefix", "--target", "-t", "--root", "--cwd", "--directory", "-C", "--global-dir", "--user", "-r", "--requirement", "-e", "--editable",
  "-c", "--constraint", "--constraints", "--overrides", "-b", "--build", "--build-constraints", "--with-requirements", "--with-editable",
  "--report", "--log", "--log-file", "--src", "--cache", "--cache-dir", "--cert", "--client-cert", "--cafile", "--config", "--config-file",
  "--userconfig", "--globalconfig", "--logs-dir", "--init-module", "--script-shell", "--shell", "--node-options", "--pip-args", "--project",
  "--install-dir", "--path", "--target-dir",
]);
/** Go's: single-dash names, never a short flag with its value run on — `-trimpath` is not `-t rimpath`. */
const GO_ELSEWHERE = new Set(["-C", "-modfile", "-pkgdir", "-toolexec", "-overlay"]);

/**
 * A path in a word — the word, the value after `=` or `@`, or a short flag's value run on (`-t/x`) — or a file URL
 * anywhere in it: `git+file:///…` and `x @ file:…` install from this box.
 */
const LOCAL = /(^|[=@]|^-[A-Za-z]+)(\/|\.{1,2}(\/|$))|(^|=)~|(^|\/)\.\.(\/|$)|(^|[^a-z])file:/i;

function elsewhere(program: string, arg: string): boolean {
  if (!arg.startsWith("-")) return false;
  const name = arg.split("=")[0]!;
  if (program === "go") return GO_ELSEWHERE.has(name.replace(/^--/, "-"));
  // A short one with its value run on: `-t/tmp/x`, `-rreqs.txt`.
  return ELSEWHERE.has(name) || (/^-[A-Za-z]/.test(arg) && ELSEWHERE.has(arg.slice(0, 2)));
}

/** Why `tools run` will not run this, or null when it will. */
export function notAnInstall(command: readonly string[]): string | null {
  const [program = "", ...rest] = command;
  const installs = INSTALLERS[program];
  const allowed = "an installer (npm or bun with -g, pipx, uv tool, pip, cargo, go install, rustup, claude update)";
  if (!installs || !installs(rest)) return `\`nouride tools run\` runs ${allowed} to install or update a program every agent runs, and nothing else: not \`${command.join(" ")}\``;
  const word = rest.find((arg) => elsewhere(program, arg) || LOCAL.test(arg));
  if (word) return `\`${word}\` is not taken here: what is installed is a package by its name, and it lands in the folders every agent runs from`;
  return null;
}
