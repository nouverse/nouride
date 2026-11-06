/**
 * Process adapter. Wraps `Bun.spawn` (TD-001) and carries the sandbox guarantees
 * from TD-010: no shell, explicit environment, hard timeout, capped output.
 */

import { contained, createLogger, type SandboxOptions, type SandboxResult } from "@nouride/shared";
import { forward, readCapped, settledAfter } from "./process-output.ts";
import { processGroupActivity } from "./process-activity.ts";
import { commandsOomKills, inCommandsCgroup, oomKillsSince } from "./process-cgroup.ts";

/** `{ oomKills }` when the kernel stopped any of the agents' commands for memory since `before`, for spreading. */
export const withOomKills = (before: number | null): { oomKills?: number } => {
  const kills = oomKillsSince(before);
  return kills ? { oomKills: kills } : {};
};
import { ownGroupSpawnOptions, signalTree, withOwnProcessGroup } from "./process-group.ts";
import { outputBuffer, terminalCommand } from "./process-terminal.ts";

export { shellQuote } from "./process-terminal.ts";
import { systemProgram, withBinFirst } from "./process-shell.ts";
import { asItsAgent, trackCommand, untrackCommand } from "./process-agents.ts";

export { systemProgram } from "./process-shell.ts";
import { freemem, totalmem } from "node:os";
import { readTextFileSync, statFile } from "./fs.ts";

const log = createLogger("runtime.process");

/**
 * Run a command to completion.
 *
 * `cmd` is an array and is never joined into a shell string — that is the whole
 * defence against injection through a model-supplied argument (§17.1 SPEC), so it
 * is a signature choice, not an implementation detail. `env` is passed as given;
 * the daemon's own environment (which holds every API key) is not inherited.
 */
export async function runCommand(cmd: string[], opts: SandboxOptions): Promise<SandboxResult> {
  if (cmd.length === 0) throw new Error("runCommand: empty command");
  const startedAt = Date.now();
  const oomBefore = commandsOomKills();

  const line = commandLine(cmd, opts);
  const proc = Bun.spawn({
    cmd: line.cmd,
    ...ownGroupSpawnOptions(),
    cwd: opts.cwd,
    env: opts.env,
    // A value to feed, or nothing to read. `"ignore"` and not `"inherit"`: a child that inherits a
    // terminal can block forever on input nobody is there to type.
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  trackCommand(proc.pid, line.pidFile);

  /**
   * Written and closed immediately.
   *
   * Closed, because a command reading to EOF — which is what every `--*-stdin` flag does — waits for
   * the pipe to end, and a pipe nobody closes is a command that hits its own timeout with the value
   * already delivered.
   */
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin);
    await proc.stdin.end();
  }

  let timedOut = false;
  let aborted = opts.signal?.aborted === true;
  // When it last printed, for the one question a timeout raises: was it working, or waiting?
  let lastOutputAt = startedAt;
  let activity: SandboxResult["activity"];
  const timer = setTimeout(
    contained(log, "could not measure a command that ran out of time", () => {
      timedOut = true;
      try {
        // Read before the kill: after it there is no group left to read.
        const measured = processGroupActivity(proc.pid);
        activity = { quietForMs: Date.now() - lastOutputAt, bytesMoved: measured?.bytesMoved ?? null, cpuSeconds: measured?.cpuSeconds ?? null };
      } finally {
        // Whatever the reading did: the timeout is the promise, the measurement only says how it was spent.
        signalTree(proc, "SIGKILL");
      }
    }),
    opts.timeoutMs,
  );
  const onAbort = contained(log, "could not stop a command its caller abandoned", () => {
    aborted = true;
    signalTree(proc, "SIGKILL");
  });
  if (opts.signal) {
    if (aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const passOn = opts.onOutput;
    const onOutput = passOn
      ? (stream: "stdout" | "stderr", text: string) => {
          lastOutputAt = Date.now();
          passOn(stream, text);
        }
      : undefined;
    const settled = settledAfter(proc.exited);
    const [stdout, stderr, exitCode] = await Promise.all([
      onOutput
        ? forward(proc.stdout, (text) => onOutput("stdout", text), settled)
        : readCapped(proc.stdout, opts.maxOutputBytes, settled),
      onOutput
        ? forward(proc.stderr, (text) => onOutput("stderr", text), settled)
        : readCapped(proc.stderr, opts.maxOutputBytes, settled),
      proc.exited,
    ]);

    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: timedOut || aborted ? null : exitCode,
      timedOut,
      aborted,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - startedAt,
      ...(activity ? { activity } : {}),
      ...withOomKills(oomBefore),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    untrackCommand(proc.pid);
  }
}

/**
 * The command line an agent's command runs as — one for the foreground, the background and nothing else.
 *
 * Two layers. The command itself, with what applies to it: `prlimit`'s ceilings outermost so its own accounting is not
 * what gets capped, then `nice` and `choom`, then this daemon's bin first on `PATH` — all of it run as the agent's own
 * user where boot found the helper (`asItsAgent`), since a limit set on the client would limit the client. Then
 * around that, as the daemon: into the commands cgroup, and `setsid` outermost so `signalTree` reaches all of it —
 * the client and, through it, the command. Each a no-op where its utility is absent.
 */
export function commandLine(
  cmd: string[],
  opts: { env?: Record<string, string>; limits?: SandboxOptions["limits"]; agent?: string; cwd?: string },
): { cmd: string[]; pidFile?: string } {
  const work = withLimits(withBackgroundPriority(withBinFirst(cmd, opts.env)), opts.limits);
  const own = asItsAgent(work, opts.agent, opts.cwd);
  return { cmd: withOwnProcessGroup(inCommandsCgroup(own.cmd)), ...(own.pidFile ? { pidFile: own.pidFile } : {}) };
}


export interface LongLivedProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Run as this agent's own user where boot found the helper (`asItsAgent`), as its commands run: an external agent's
   * coding CLI (0.8.1) is the agent's whole shell, and an agent's stdio MCP server can be one too (a shell, a file
   * server), so both get the same wall. Absent: the daemon's user.
   */
  agent?: string;
}

/**
 * A subprocess the engine keeps talking to: an MCP server over stdio (the WhatsApp bridge was one
 * until it moved into the daemon). Framing is newline-delimited JSON in both directions, so the
 * handle exposes lines rather than bytes. It runs where an agent's commands do (`inCommandsCgroup`).
 */
export interface LongLivedProcess {
  readonly pid: number;
  writeLine(line: string): void;
  lines(): AsyncIterableIterator<string>;
  stderrLines(): AsyncIterableIterator<string>;
  exited: Promise<number>;
  /**
   * Close the child's stdin. A stdio MCP server reads end-of-file as "shut down" — the first step of the spec's own
   * order — and some exit on nothing else: `mcp-atlassian` ignores SIGTERM while its stdin is open (issue #11 on
   * nouride-releases).
   */
  endInput(): void;
  /** Signal the child and everything it started: it leads a process group of its own (`signalTree`). */
  kill(signal?: NodeJS.Signals): void;
}

export function spawnLongLived(
  cmd: string[],
  opts: LongLivedProcessOptions = {},
): LongLivedProcess {
  if (cmd.length === 0) throw new Error("spawnLongLived: empty command");

  const own = asItsAgent(cmd, opts.agent, opts.cwd);
  const proc = Bun.spawn({
    // An MCP server is a program somebody else wrote, run for an agent: it goes where an agent's commands go. And it
    // leads a group of its own, so stopping it stops what it started — `uvx` runs the server as a child of `uv`, and a
    // signal to `uv` alone left the server running (issue #11 on nouride-releases).
    cmd: withOwnProcessGroup(inCommandsCgroup(own.cmd)),
    ...ownGroupSpawnOptions(),
    cwd: opts.cwd,
    env: opts.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  trackCommand(proc.pid, own.pidFile);
  void proc.exited.then(() => untrackCommand(proc.pid));
  const encoder = new TextEncoder();

  return {
    pid: proc.pid,
    writeLine(line) {
      proc.stdin.write(encoder.encode(`${line}\n`));
      proc.stdin.flush();
    },
    lines: () => iterateLines(proc.stdout),
    stderrLines: () => iterateLines(proc.stderr),
    exited: proc.exited,
    endInput: () => {
      try {
        proc.stdin.end();
      } catch {
        // Already closed, or the child is gone: either way there is no input left to end.
      }
    },
    kill: (signal = "SIGTERM") => signalTree(proc, signal),
  };
}

async function* iterateLines(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
    }
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}


/**
 * A process kept alive with its input open, read as raw bytes rather than lines.
 *
 * Distinct from `spawnLongLived`, and the difference is the whole point: that one iterates *lines*,
 * which is right for the WhatsApp bridge's newline-delimited JSON and useless for anything
 * interactive. A password prompt is `Password: ` with no newline after it, so a line iterator waits
 * forever for a terminator that only arrives once the answer has already been given.
 *
 * A terminal where one can be had with no native module (TD-001): `script(1)` on Linux and on macOS
 * (`process-terminal.ts`). Elsewhere — or with `tty: false` — the child gets pipes, so anything that checks
 * `isatty` behaves as though it were being piped: no colours, no cursor control, no `kubectl exec -it`.
 * What pipes still cover is the common shape — a prompt, an answer, and output that keeps arriving.
 */
export interface InteractiveProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Bytes of unread output kept. Beyond it the oldest is dropped, with a marker. */
  maxBufferBytes?: number;
  /**
   * Ask for a real terminal.
   *
   * Granted where one can be allocated, and reported back on `tty` either way — a caller that assumes
   * it got one when it did not would tell the model that `kubectl exec -it` should work.
   */
  tty?: boolean;
  /** The agent whose session this is: its own user's, where boot found the helper (`process-agents.ts`). */
  agent?: string;
}

export interface InteractiveProcess {
  readonly pid: number;
  /** Whether the child actually got a terminal. False means pipes, and `isatty` will say so. */
  readonly tty: boolean;
  /** Written verbatim — the caller decides whether a newline is part of the answer. */
  write(data: string): void;
  /** Everything received since the last call, and clears it. */
  drain(): string;
  running(): boolean;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

const DEFAULT_INTERACTIVE_BUFFER = 256 * 1024;

/**
 * Everything on this process's own stdin, as text.
 *
 * Here rather than at the call site because `Bun.stdin` is a Bun API and TD-001 keeps every one of
 * them behind this package — `scripts/check-arch.ts` fails the build otherwise, which is how this
 * ended up here rather than in the CLI where it was first written.
 *
 * Used for secrets: a credential piped in never appears in argv, so it stays out of shell history,
 * out of durable exec grants and out of the audit log, all of which keep a command's full text.
 */
export async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

/**
 * Everything on stdin, as bytes: a file the shell opened and handed over (`nouride knowledge add -`), which may be a PDF
 * as well as text.
 */
export async function readStdinBytes(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.stdin.arrayBuffer());
}

export function spawnInteractive(
  cmd: string[],
  opts: InteractiveProcessOptions = {},
): InteractiveProcess {
  if (cmd.length === 0) throw new Error("spawnInteractive: empty command");

  // The same shell and PATH `exec` gets — see `process-shell.ts`. Applied before the terminal's wrapping, so the shell
  // `script(1)` starts is the pinned one rather than a bare name looked up on the agents' PATH.
  const argv = withBinFirst(cmd, opts.env);
  // `script(1)` on Linux and macOS, each its own way (`process-terminal.ts`); pipes where there is none.
  const terminal = opts.tty === false ? null : terminalCommand(argv);

  // The terminal's `script` runs as the agent too: a pty the session's own user holds.
  const own = asItsAgent(terminal ?? argv, opts.agent, opts.cwd);
  const proc = Bun.spawn({
    cmd: inCommandsCgroup(own.cmd),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const encoder = new TextEncoder();
  const output = outputBuffer(opts.maxBufferBytes ?? DEFAULT_INTERACTIVE_BUFFER);
  let alive = true;

  /** stdout and stderr interleave into one buffer: that is what a terminal shows, and prompts use both. */
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        output.append(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // The process ended mid-read. Whatever arrived is still in the buffer, which is what matters.
    }
  };

  void pump(proc.stdout);
  void pump(proc.stderr);
  trackCommand(proc.pid, own.pidFile);
  void proc.exited.then(() => {
    alive = false;
    untrackCommand(proc.pid);
  });

  return {
    pid: proc.pid,
    tty: terminal !== null,
    write(data) {
      proc.stdin.write(encoder.encode(data));
      proc.stdin.flush();
    },
    drain: () => output.drain(),
    running: () => alive,
    exited: proc.exited,
    // `script` killed hangs its terminal up on what runs there; on a Mac the `cat` feeding it ends as Bun closes its
    // input.
    kill: (signal) => proc.kill(signal),
  };
}

/**
 * Where `prlimit(1)` lives, or null.
 *
 * The same shape as `terminalCommand`'s lookup, and the same reason: a kernel-enforced limit without a native
 * module. Linux only — macOS has no `prlimit`, so a native macOS install runs unlimited and says so
 * rather than pretending otherwise.
 */
function findPrlimit(): string | null {
  if (process.platform !== "linux") return null;
  for (const candidate of ["/usr/bin/prlimit", "/bin/prlimit"]) {
    if (statFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Wrap a command so the kernel stops it, rather than trusting it to stop itself.
 *
 * The timeout already bounds wall-clock and `maxOutputBytes` bounds what we read, and neither helps
 * against a command that allocates until the machine swaps or spins a core flat for the whole
 * timeout. Those are the two that take the *host* down rather than the turn, which matters most
 * exactly where this daemon is meant to run: somebody's own server.
 *
 * `prlimit` takes an argv array like any other program, so this adds no shell and no quoting.
 * `--as` is address space rather than resident size: the coarser of the two, and the one a runaway
 * allocation trips first.
 */
export function withLimits(cmd: string[], limits: SandboxOptions["limits"]): string[] {
  if (!limits) return cmd;
  const memoryMb = limits.memoryMb ?? 0;
  const cpuSeconds = limits.cpuSeconds ?? 0;
  if (memoryMb <= 0 && cpuSeconds <= 0) return cmd;

  const prlimit = findPrlimit();
  if (!prlimit) return cmd;

  return [
    prlimit,
    ...(memoryMb > 0 ? [`--as=${memoryMb * 1024 * 1024}`] : []),
    ...(cpuSeconds > 0 ? [`--cpu=${cpuSeconds}`] : []),
    "--",
    ...cmd,
  ];
}

/**
 * Where `nice(1)` lives, or null. Same shape and same reason as `findPrlimit`.
 */
function findNice(): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  for (const candidate of ["/usr/bin/nice", "/bin/nice"]) {
    if (statFile(candidate)) return candidate;
  }
  return null;
}

/**
 * How far below the daemon a spawned command runs. Ten is the conventional "background work".
 */
const BACKGROUND_NICE = 10;

/**
 * Run a command at a lower CPU priority than the daemon that started it.
 *
 * Costs the command nothing when the machine is idle — that is the whole property of `nice`. It only
 * yields when something else wants the CPU, and on this daemon the something else is a turn: a
 * gateway reconnecting, an approval being answered, six agents' worth of conversation. The failure
 * this prevents is a two-core box where an agent kicked off a build and every chat went silent until
 * it finished, which is indistinguishable from the daemon having crashed.
 *
 * Deliberately *not* a memory limit. `prlimit --as` is address space, not resident size, and V8
 * reserves far more address space than it uses: capped at 1 GB on a real box, `tsc` aborts with a
 * stack trace while using 250 MB. So a cap low enough to protect a small machine kills every build
 * on it, and one high enough to let builds run protects nothing. Memory is bounded where every command
 * shares it instead: their own cgroup below the unit's ceiling (`process-cgroup.ts`, 0.7.19), or — where
 * the unit gives none — the unit's MemoryHigh, which throttles the daemon with them.
 *
 * Absent `nice`, the command runs unwrapped. A missing utility is not worth failing a turn over.
 *
 * No `--` before the command. GNU and BSD `nice` accept one; BusyBox's — the `nice` in the Alpine
 * image — takes it for the program's name and fails with "can't execute '--'". That broke every
 * `exec` in every container, `pwd` included, from the day this was written until 0.5.11 was verified
 * against the published image. The command's own name never starts with `-`, so nothing needs it.
 */
export function withBackgroundPriority(cmd: string[]): string[] {
  const nice = findNice();
  const sized = withOomPreference(cmd);
  return nice ? [nice, "-n", String(BACKGROUND_NICE), ...sized] : sized;
}

/**
 * Where `choom(1)` lives, or null. util-linux since 2.33, so Linux only; BusyBox has none.
 */
function findChoom(): string | null {
  if (process.platform !== "linux") return null;
  for (const candidate of ["/usr/bin/choom", "/bin/choom"]) {
    if (statFile(candidate)) return candidate;
  }
  return null;
}

/**
 * How much likelier than the daemon a spawned command is to be what the kernel kills when memory runs out (E8).
 *
 * 500 is half of the machine's memory added to the command's score. The daemon is left at what its unit gives it:
 * made unkillable, it would see NetworkManager and sshd killed before itself on a Box where it is the one leaking.
 */
const BACKGROUND_OOM_SCORE_ADJ = 500;

/**
 * Run a command as the first thing the kernel's OOM killer reaches for, ahead of the daemon that started it.
 *
 * Every command an agent ran was in the daemon's cgroup — and still is where the unit hands none over
 * (`process-cgroup.ts`) — so when memory ran out — a 1.2 GB clone, twelve typechecks, a box whose memory cgroup is
 * off — the victim was whichever process was largest, and on a Box that is the daemon: every gateway and every turn
 * gone for the build that caused it. With the unit's `OOMPolicy=continue` the command is
 * killed alone, and the agent reads an exit it can report. Raising one's own score needs no privilege. Absent `choom`,
 * the command runs as before.
 */
function withOomPreference(cmd: string[]): string[] {
  const choom = findChoom();
  return choom ? [choom, "-n", String(BACKGROUND_OOM_SCORE_ADJ), "--", ...cmd] : cmd;
}

/** Whether limits requested here would actually be applied. Reported at boot rather than assumed. */
export function resourceLimitsAvailable(): boolean {
  return findPrlimit() !== null;
}

/**
 * The command line of a running process, or null.
 *
 * Used to confirm a PID read from a lock file is still the daemon that wrote it. PIDs are recycled, so
 * signalling a recorded PID without checking can hit an unrelated program that happens to have inherited
 * the number — a rare event with an unbounded blast radius, which is the worst combination to leave to
 * chance.
 */
export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // `/proc` first, where there is one: a container may have no `ps` at all (Debian's slim images ship none), and
  // BusyBox's reads neither `-o command=` nor `-p` — so in exactly the place PIDs are reused, the answer was nothing.
  try {
    const args = readTextFileSync(`/proc/${pid}/cmdline`).split("\0").filter(Boolean);
    if (args.length > 0) return args.join(" ");
  } catch {
    // No `/proc` (macOS), or not this PID's to read: `ps` below.
  }
  try {
    const res = Bun.spawnSync([systemProgram("ps"), "-o", "command=", "-p", String(pid)]);
    const out = new TextDecoder().decode(res.stdout).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Send a signal to a pid. False when the process is gone or not ours to signal. */
export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Signal handlers for the graceful shutdown sequence (§14.1 SPEC). */
export function onShutdownSignal(handler: (signal: string) => void): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    // A listener's throw is uncaught — and the uncaught-exception handler answers with this signal again. A shutdown
    // that throws ends the process here instead, with the reason in the log.
    process.on(signal, () => {
      try {
        handler(signal);
      } catch (err) {
        log.error("the shutdown sequence threw; exiting now", { signal, error: String(err) });
        process.exit(1);
      }
    });
  }
}

export function exitProcess(code: number): never {
  process.exit(code);
}

/**
 * A user's home as `/etc/passwd` has it — the current user's by default — not `$HOME`. OpenSSH reads `~/.ssh/config`
 * from this one, so the two disagree whenever a service sets `HOME` (Nouride's unit does). Read from the file: Bun's
 * `os.userInfo().homedir` answers `$HOME` (Node's does not), which found nothing on a Raspberry Pi. Null where the file has no
 * such user — macOS keeps people in Directory Services.
 */
export function passwdHome(uid: number | undefined = process.getuid?.()): string | null {
  if (uid === undefined) return null;
  try {
    return homeInPasswd(readTextFileSync("/etc/passwd"), uid);
  } catch {
    return null;
  }
}

export function homeInPasswd(passwd: string, uid: number): string | null {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length >= 6 && Number(fields[2]) === uid && fields[5]) return fields[5];
  }
  return null;
}

/**
 * The absolute path of an executable on `PATH`, or `null` when it is not installed.
 *
 * Here rather than at a call site because `Bun.which` is a `Bun.*` API (invariant 1) — and behind a
 * name that says what a `null` means, since the one caller that matters is "does this host have
 * `dot`?" and a thrown error would read as a broken check rather than a missing program.
 *
 * A lookup, not a run: nothing is executed, so this is safe to call for a name that came out of a
 * skill's frontmatter.
 */
export function whichBinary(name: string, path: string = process.env.PATH ?? ""): string | null {
  // Anything that is not a bare program name is refused rather than looked up. `Bun.which("../x")`
  // resolves relative paths, so a `requires:` field naming one would probe the daemon's cwd — and a
  // frontmatter field is not a place to accept a path.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) return null;
  // PATH named, because `Bun.which` alone searches the PATH the process started with: the daemon puts
  // `.nouride/bin` first at boot, and a program an agent installed there read as not installed.
  // `path` is for the one caller that must not see the agents' own directories: finding the system's
  // python3 to build the shared env from, which a venv's own python3 earlier on PATH would otherwise answer.
  return Bun.which(name, { PATH: path });
}

/**
 * What this machine says it has, in bytes, or 0 when it will not say.
 *
 * `/proc/meminfo` first, and that is the whole point of this function. Inside an LXC, lxcfs rewrites
 * `/proc/meminfo` to show the *container's* memory — but it cannot intercept the `sysinfo()` syscall
 * that `os.totalmem()` uses, so `totalmem()` reports the **host's**. On a 2 GB container of a 62 GB
 * Proxmox node the two disagree by a factor of thirty, and a ceiling computed from the wrong one is
 * no ceiling. Found by writing it the easy way first and watching the unit come out at 50 GB.
 *
 * `totalmem()` stays as the fallback for everywhere `/proc` is not a thing.
 */
export function totalMemoryBytes(): number {
  try {
    const match = /^MemTotal:\s+(\d+) kB$/m.exec(readTextFileSync("/proc/meminfo"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux, or /proc is not mounted.
  }
  try {
    return totalmem();
  } catch {
    return 0;
  }
}

/**
 * This process's own memory, in bytes: what is resident, and how much of the JavaScript heap is in use.
 *
 * Two numbers because they answer different questions. Resident is what the machine pays — the heap, the runtime, and
 * the pages of the executable mapped from disk, which the kernel drops and re-reads under pressure. The heap in use is
 * the part it cannot drop, and the one that grows if something is kept that should not be.
 */
export function processMemory(): { rssBytes: number; heapUsedBytes: number } {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

/**
 * What the kernel says could still be handed out without swapping, in bytes, or 0 when it will not say.
 *
 * `MemAvailable` rather than `MemFree`: free memory on a box that has been up a while is mostly page
 * cache, which the kernel gives back on demand, so `MemFree` reads as nearly full on a box with room
 * to spare. `/proc/meminfo` first for the same LXC reason as {@link totalMemoryBytes}.
 */
export function availableMemoryBytes(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readTextFileSync("/proc/meminfo"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux, or /proc is not mounted.
  }
  try {
    return freemem();
  } catch {
    return 0;
  }
}

/**
 * Whether this process is running as root.
 *
 * True on a Nouride Box, which installs its unit with `--appliance`, and false on the hardened unit
 * every other install gets. What reads it is the prompt: an agent that knows it is root stops
 * reaching for `sudo`, and `sudo` is the one prefix that makes an otherwise ordinary command ask a
 * human every single time and never remember the answer.
 *
 * `getuid` is absent on Windows, where the question has no answer in these terms — false is right
 * there, because nothing on that platform would make `sudo` the correct thing to write.
 */
export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Whether `sudo` could elevate this process at all.
 *
 * False under systemd's `NoNewPrivileges=true`, which every install but a privileged one runs with:
 * setuid is ignored, so `sudo` fails whatever sudoers says. The prompt told agents on such a box to
 * try `sudo apt-get` first, a step that could never work. Read from `/proc/self/status`; a host
 * without it (macOS) can elevate as far as this knows.
 */
export function canElevate(status?: string): boolean {
  let text = status;
  if (text === undefined) {
    try {
      text = readTextFileSync("/proc/self/status");
    } catch {
      return true;
    }
  }
  return !/^NoNewPrivs:\s*1\s*$/m.test(text);
}
