/**
 * Which commands belong in the job store rather than in a foreground turn.
 *
 * A table and the function that reads it, kept apart from the tool itself: everything here is a
 * judgement about a program's *shape*, reworked every time a live turn was routed the wrong way,
 * and none of it needs the sandbox, the policy or the workspace.
 *
 * Auto-backgrounding is not a free guess. The tool returns a job id instead of output **and** ends
 * the turn, so a wrong yes turns a routine diagnostic into "started as job_7" and stops the
 * conversation. A wrong no is the other failure and it is the one this file was last widened for —
 * see `waitSeconds`.
 */

const AUTO_BACKGROUND_TIMEOUT_MS = 120_000;

/**
 * Seconds of deliberate waiting that make a command background work, whatever it does afterwards.
 *
 * Ten, because the foreground timeout is 30s and a wait is the one part of a command whose length is
 * known before it runs. Below this a `sleep` is punctuation — settling a service, spacing two writes;
 * at or above it the command's whole purpose is to not finish yet.
 */
const WAIT_SECONDS_BEFORE_BACKGROUND = 10;

const SLEEP_UNITS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3_600, d: 86_400 };
const SHELL_LAUNCHERS = new Set(["sh", "bash", "zsh"]);

/**
 * Programs whose whole purpose is slow work, whatever the subcommand.
 *
 * Kept deliberately short. Auto-backgrounding is not a free guess: the tool returns a job id instead
 * of output *and* ends the turn, so getting it wrong means a routine diagnostic answers with "started
 * as job_7" and the conversation stops. `cargo`, `docker-compose` and `nix` were here and should not
 * have been — `cargo tree`, `docker-compose ps` and `nix flake show` are all instant, and all three
 * ended turns. Each of them has a subcommand entry below that says which verbs are actually slow, and
 * for `cargo` this entry made that entry dead code.
 */
const LONG_RUNNING_PROGRAMS = new Set(["make", "cmake", "rsync", "scp", "pytest"]);

const LONG_RUNNING_SUBCOMMANDS = new Map<string, Set<string>>([
  ["git", new Set(["clone", "fetch", "pull", "submodule"])],
  // `add` and `i` are installs too: `bun add remotion @remotion/cli react` timed out twice in a month.
  ["bun", new Set(["install", "add", "test", "run", "x"])],
  ["npm", new Set(["ci", "install", "i", "add", "test", "run", "start"])],
  ["pnpm", new Set(["install", "i", "add", "test", "run", "start"])],
  ["yarn", new Set(["install", "add", "test", "run", "start"])],
  ["docker", new Set(["build", "compose", "pull"])],
  ["podman", new Set(["build", "compose", "pull"])],
  ["docker-compose", new Set(["build", "pull", "up"])],
  // `install` compiles from source: minutes, and it lands in the bin directory when it is done.
  ["go", new Set(["build", "test", "run", "install"])],
  ["cargo", new Set(["build", "test", "run", "install"])],
  ["pipx", new Set(["install"])],
  /**
   * `nouride pkg install|upgrade|remove|refresh` — the package manager behind the root helper.
   *
   * The client waits up to half an hour for a change and `exec`'s foreground is capped at four minutes,
   * so an apt install longer than that was killed on this side while dpkg went on running on the other.
   * `check` and `status` answer at once and stay in the foreground. The tool runs the binary by its full
   * path, which is why this is matched on the program's base name like everything else here.
   */
  ["nouride", new Set(["pkg"])],
  ["nix", new Set(["build", "develop"])],
  ["uv", new Set(["run", "sync"])],
  ["poetry", new Set(["install", "run"])],
  ["pip", new Set(["install"])],
  ["pip3", new Set(["install"])],
]);
const RUN_SUBCOMMANDS = new Set(["build", "dev", "serve", "start", "test", "watch"]);
const PKG_CHANGES = new Set(["install", "upgrade", "remove", "refresh"]);

/**
 * `docker compose <verb>` — the modern spelling, where the slow part is a word further along.
 *
 * `compose` is in docker's set above because `docker compose build` is slow, which made every
 * `docker compose ps`, `logs` and `config` slow too. The shell-pattern list already got this right;
 * the argv path did not.
 */
const COMPOSE_SUBCOMMANDS = new Set(["build", "pull", "up"]);

/**
 * Arguments that mean "tell me about it" rather than "do it".
 *
 * A `--version` or a `--dry-run` returns instantly whatever program it is attached to, so it must
 * never be routed to the job store. `-n` is only listed for the programs where it means dry-run —
 * elsewhere it is a count, and treating it as a dry-run would push real work into the foreground.
 */
const QUICK_FLAGS = new Set(["--version", "-V", "--help", "-h", "--dry-run", "--just-print"]);
const DRY_RUN_SHORT_FLAG_PROGRAMS = new Set(["make", "cmake", "rsync"]);

const LONG_RUNNING_ARGV_PREFIXES = [
  ["gh", "repo", "clone"],
  ["python", "-m", "pip", "install"],
  ["python3", "-m", "pip", "install"],
  ["uv", "pip", "sync"],
  ["python", "-m", "pytest"],
  ["python3", "-m", "pytest"],
  ["playwright", "install"],
  ["uv", "tool", "install"],
  ["npx", "playwright", "install"],
  ["bunx", "playwright", "install"],
];
const SHELL_LONG_RUNNING = [
  /\bgit\s+clone\b/,
  /\bgh\s+repo\s+clone\b/,
  /\b(curl|wget)\b[\s\S]*\b(tar|unzip)\b/,
  /**
   * An installer script fetched and run in one go — `curl … | bash`, `bash <(curl …)`,
   * `sh -c "$(curl …)"`. It prints nothing while it downloads, and what it downloads is large.
   * Live, 2026-10-12: Claude Code's installer fetched 257 MB at 1.9 MB/s, was killed at 30 s, then at
   * 60 s under `bash -x`, and only finished the third time, in the background. `curl … | head` is not
   * one of these and stays in the foreground.
   */
  /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  /\b(ba|z|da)?sh\b[^;&|]*<\(\s*(curl|wget)\b/,
  /\b(ba|z|da)?sh\s+-c\s+["']?\$\(\s*(curl|wget)\b/,
  /\b(bun|npm|pnpm|yarn)\s+(ci|install|i|add|test)\b/,
  /\b(pytest|python3?\s+-m\s+pytest)\b/,
  /\bplaywright\s+install\b/,
  /\b(bun|npm|pnpm|yarn)\s+run\s+(build|dev|serve|start|test|watch)\b/,
  /\b(docker|podman)\s+(build|pull)\b/,
  /\b(docker|podman)\s+compose\s+(build|pull|up)\b/,
  /\b(uv)\s+(run|sync)\b/,
  /\buv\s+pip\s+sync\b/,
  /\b(poetry)\s+(install|run)\b/,
  /\b(pip|pip3)\s+install\b/,
  /\b(pipx|cargo|go)\s+install\b/,
  /\buv\s+tool\s+install\b/,
  /\b(python|python3)\s+-m\s+pip\s+install\b/,
  /\bnix\s+(build|develop)\b/,
];

/**
 * Long-running work belongs in the job store, not in a foreground turn.
 *
 * This keeps the architecture honest: we already have a detached-work path with logging, wake-ups and
 * restart semantics, so the fix for "clone Hermes blocks the chat" is to route that shape there
 * earlier rather than teaching the foreground path to survive indefinitely.
 */
export function shouldAutoBackground(
  argv: string[],
  rawTimeout: unknown,
  backgroundAvailable: boolean,
): boolean {
  if (!backgroundAvailable || argv.length === 0) return false;

  // An explicit timeout past the threshold is the model saying so itself, and it says it about the
  // command as a whole — so it wins over every heuristic below, quick-looking flags included.
  if (typeof rawTimeout === "number" && rawTimeout >= AUTO_BACKGROUND_TIMEOUT_MS) return true;

  // Before `looksQuick`, because a wait is not made quick by what it is waiting for: the whole
  // point of `sleep 30; gh run view --json status` is the thirty seconds, not the inspection.
  if (waitSeconds(argv) >= WAIT_SECONDS_BEFORE_BACKGROUND) return true;

  const program = basename(argv[0]);
  if (looksQuick(program, argv)) return false;

  if (LONG_RUNNING_PROGRAMS.has(program)) return true;

  const subcommand = argv[1] ?? "";
  const subcommands = LONG_RUNNING_SUBCOMMANDS.get(program);
  if (subcommands?.has(subcommand)) {
    if (subcommand === "run") return RUN_SUBCOMMANDS.has(argv[2] ?? "");
    if (subcommand === "pkg") return PKG_CHANGES.has(argv[2] ?? "");
    if (subcommand === "compose") return COMPOSE_SUBCOMMANDS.has(argv[2] ?? "");
    return true;
  }

  if (LONG_RUNNING_ARGV_PREFIXES.some((prefix) => hasArgvPrefix(argv, prefix))) return true;

  return isShellLongRunning(argv);
}

/** Is this an inspection rather than work? See `QUICK_FLAGS`. */
function looksQuick(program: string, argv: string[]): boolean {
  return argv
    .slice(1)
    .some(
      (arg) =>
        QUICK_FLAGS.has(arg) || (arg === "-n" && DRY_RUN_SHORT_FLAG_PROGRAMS.has(program)),
    );
}

/** Prefix match for nested subcommands such as `gh repo clone` and `python -m pip install`. */
function hasArgvPrefix(argv: string[], prefix: string[]): boolean {
  if (argv.length < prefix.length) return false;
  return prefix.every((part, index) => argv[index] === part);
}

/**
 * How long this command spends deliberately doing nothing.
 *
 * The shape this exists for is polling: `sleep 20; <check>`, run again and again until the thing
 * being watched is done. Every other entry in this file classifies a program by what it *does*, and
 * by that reading a poll is quick — `gh run view`, `kubectl get`, `curl -s` all return in a second,
 * and the sleep in front of them is invisible.
 *
 * Observed live, on a turn that watched a CI run: nine polls, five of them `sleep`-prefixed, the
 * first one (`sleep 45`) killed by the 30s foreground timeout — which taught the model to poll in
 * shorter hops rather than to stop polling. It spent the whole 300s turn deadline that way and the
 * person got "I ran out of time" instead of the answer, which had been available for two minutes.
 *
 * Summed rather than maxed: `sleep 10; a; sleep 10; b` waits twenty seconds, and it is the total
 * that has to fit in a foreground turn. A bare `sleep` and one inside `bash -lc` both count, because
 * the model reaches for whichever spelling the rest of the command needs.
 */
export function waitSeconds(argv: string[]): number {
  if (!isShellScript(argv)) {
    // A plain argv runs one program. `sleep` has to *be* that program — anywhere else the word is
    // an argument, and `grep -rn "sleep 30" src/` is a search that returns immediately.
    if (basename(argv[0]) !== "sleep") return 0;
    return parseSleep(argv.slice(1).join(""));
  }
  let total = 0;
  // Only at a command position — after a separator, or at the start. Inside quotes it is a string
  // somebody is searching for, not a wait, and the same grep goes through a shell often enough.
  for (const match of scriptToRun(argv).matchAll(/(?:^|[;&|\n(])\s*sleep\s+([^\s;&|)]+)/g)) {
    total += parseSleep(match[1] ?? "");
  }
  return total;
}

/** `30`, `1m`, `0.5` — the argument as `sleep(1)` reads it, in seconds. Anything else is zero. */
function parseSleep(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(raw.trim());
  if (!match) return 0;
  return Number(match[1]) * (SLEEP_UNITS[match[2] ?? ""] ?? 1);
}

/** `sh -c "…"` / `bash -lc "…"` — a script to be re-parsed, not a program and its arguments. */
export function isShellScript(argv: string[]): boolean {
  return SHELL_LAUNCHERS.has(basename(argv[0])) && ["-c", "-lc"].includes(argv[1] ?? "");
}

/**
 * The script without its here-documents' bodies: what runs, not what is being written.
 *
 * `cat << 'EOF' > start.bat`, then a batch file that starts uvicorn, is a file write that takes two
 * milliseconds. Read whole, the body said "uvicorn" and the write ran as a service; a package.json
 * with a `dev` script, a README showing `bun run dev`, did the same. On one evening on a live box 26
 * commands became jobs, most of them writes, and each one that ended woke its agent to report nothing.
 */
function scriptToRun(argv: string[]): string {
  const kept: string[] = [];
  let end: { word: string; tabs: boolean } | null = null;
  for (const line of argv.slice(2).join(" ").split("\n")) {
    if (end) {
      if ((end.tabs ? line.replace(/^\t+/, "") : line) === end.word) end = null;
      continue;
    }
    kept.push(line);
    const heredoc = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (heredoc) end = { word: heredoc[3] ?? "", tabs: heredoc[1] === "-" };
  }
  return kept.join("\n");
}

function isShellLongRunning(argv: string[]): boolean {
  if (!isShellScript(argv)) return false;
  const script = scriptToRun(argv).trim();
  return script !== "" && SHELL_LONG_RUNNING.some((pattern) => pattern.test(script));
}

/**
 * Commands that outlast the foreground default but finish, and whose result the turn needs next.
 *
 * Not background work: a commit's outcome decides the next step, and a job would end the turn to report
 * it. Killed at thirty seconds, though, a commit in a repository whose pre-commit hook runs its lints
 * never finished — 14 of a month's 71 foreground timeouts on a live box were `git commit`, each one
 * retried and killed again. A certbot DNS challenge waits on propagation the same way.
 */
const SLOW_BUT_FINITE = [
  /(^|[\s;&|(])git\s+(-C\s+\S+\s+)?(commit|push|merge|rebase|cherry-pick|am)\b/,
  /(^|[\s;&|(])certbot\s+(certonly|renew|run)\b/,
];
const SLOW_BUT_FINITE_TIMEOUT_MS = 180_000;

/** How long a foreground command waits when its call named no `timeout_ms`. */
export function foregroundTimeoutFor(argv: string[], fallback: number): number {
  const text = isShellScript(argv) ? scriptToRun(argv) : argv.join(" ");
  return SLOW_BUT_FINITE.some((pattern) => pattern.test(text)) ? Math.max(fallback, SLOW_BUT_FINITE_TIMEOUT_MS) : fallback;
}

function basename(value: string | undefined): string {
  if (!value) return "";
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
}

/**
 * A command that serves until it is stopped — a dev server, a static server, a tunnel — rather than
 * doing work and finishing.
 *
 * Run as a service: a job like any other (listed, logged, killable from `nouride jobs` and the
 * dashboard) that does not end the turn. As an ordinary background job it did, and a server never
 * finishes, so nothing woke the turn again — found live on a Pi: asked for a preview link, the agent
 * started the server three turns running and each ended on "it is running" with no link. Matched here
 * as well as asked for with `service: true`, because the model that did that had been told.
 */
const SERVICE_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|serve|start|watch|preview)\b/,
  /\b(python|python3)\s+-m\s+http\.server\b/,
  // `vite` as a command, not `vite.config.ts` in a path being copied — which made a `mkdir` over ssh a service.
  /(^|[\s;&|(/])vite(?=$|[\s;&|)])(?!\s+(build|optimize)\b)/m,
  /\b(next\s+(dev|start)|astro\s+(dev|preview)|nuxt\s+dev|http-server|live-server)\b/,
  /\bcloudflared\s+tunnel\b/,
  // With the app it serves (`main:app`), so `pip install uvicorn fastapi` is an install, not a server.
  /\b(uvicorn|gunicorn|hypercorn)\s+(-\S+\s+)*[\w.]+:[\w.()]+/,
  /\bflask\s+run\b/,
  /\brails\s+(s|server)\b/,
  /\bphp\s+-S\b/,
  /\b(hugo|jekyll)\s+(server|serve)\b/,
  /\b(docker|podman)(\s+compose|-compose)\s+up\b(?![^;&|]*\s(-d|--detach)\b)/,
];

/**
 * A server started so that it outlives the command — the command itself returns at once.
 *
 * `Start-Process`, `start /b`, `nohup`: the launch is over in a second and the server runs on without
 * it. Run as a service, each became a job that ended immediately and woke its agent to report nothing;
 * on another machine over ssh the agent then killed "the service" to free a session that had closed.
 *
 * Not a bare trailing `&`. Left in the foreground, a server backgrounded that way still writes to the
 * command's pipe, and dies of it once the command has returned; as a service its output goes to the
 * job's log and it lives.
 */
const DETACHED = [
  /\bStart-Process\b/i,
  /\bstart\s+(""\s+)?\/b\b/i,
  /\b(nohup|setsid|disown|schtasks)\b/,
  /\b(screen\s+-d?m|tmux\s+new(-session)?\b[^\n;&|]*\s-d)\b/,
];

export function isService(argv: string[]): boolean {
  const text = isShellScript(argv) ? scriptToRun(argv) : argv.join(" ");
  return SERVICE_PATTERNS.some((pattern) => pattern.test(text)) && !DETACHED.some((pattern) => pattern.test(text));
}

