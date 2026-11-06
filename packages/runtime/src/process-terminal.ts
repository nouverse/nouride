/**
 * How an interactive session gets a terminal on each platform, and the bounded buffer its output is read from.
 *
 * `script(1)` on both, because a terminal without a native module (TD-001) is a program that owns one. The two
 * `script`s differ:
 *
 * - **Linux**, util-linux: `script -qec "<command string>" /dev/null`. Unchanged.
 * - **macOS**, BSD: no `-c` (`illegal option -- c`) — the command is argv after the file — and it reads its stdin's
 *   terminal attributes, which fails with `tcgetattr/ioctl: Operation not supported on socket` on what Bun gives a
 *   child for stdin there: a socketpair. A FIFO is no better (macOS builds those on sockets too). A `pipe(2)` is what
 *   it accepts, so bash hands it one: `exec script … < <(exec cat)`, with `cat` copying Bun's socket into the pipe.
 *   `exec` keeps `script` the process Bun waits on, so the session ends when the program does, with its status.
 *   (Finding 6 of issue #7 on nouride-releases: a session there had no terminal — `tty` said "not a tty".)
 *
 * Bun's own PTY (`Bun.spawn({ terminal })`, Bun 1.4.2) was tried first and is not used: on macOS a child on it that
 * exits with output still queued waits for the terminal to drain, while Bun's event loop sits in a blocking
 * `wait4()` for that child — so nothing reads the terminal, and the whole process stops. Seen twice in the test suite
 * under load, with the main thread in `__wait4_nocancel`. In the daemon that would be every gateway at once. Here the
 * terminal belongs to `script`, which drains it itself.
 */

import { statFile } from "./fs.ts";

/** The first of `paths` that exists, or null. */
const firstOf = (paths: string[]): string | null => paths.find((path) => statFile(path) !== null) ?? null;

/**
 * Quote one argument for a POSIX shell.
 *
 * Needed because util-linux `script(1)`'s `-c` takes a **command string** — so an argv array has to be rendered back
 * into shell syntax. That is the exact conversion this codebase otherwise refuses to do, which is why it is one
 * function with one rule rather than string building spread around: wrap in single quotes, and the only character that
 * can escape single quotes is a single quote, closed and reopened around a backslash-escaped one.
 *
 * Nothing inside single quotes is special to a shell — not `$`, not a backtick, not `;` — so a correctly quoted
 * argument cannot become syntax.
 */
export function shellQuote(argv: string[]): string {
  return argv.map((arg) => `'${arg.split("'").join(`'\\''`)}'`).join(" ");
}

/**
 * The command that runs `argv` on a terminal of its own here, or null where none can be had (no `script`, or a
 * platform that is neither) — the caller then runs `argv` on pipes and says so.
 *
 * `-q` suppresses the "Script started" banner and `/dev/null` is the typescript file nobody wants; util-linux's `-e`
 * returns the child's exit status, which BSD's does by default. On macOS the arguments reach the program as argv,
 * through bash's `"$@"`: nothing is quoted into a string.
 */
export function terminalCommand(argv: string[], platform: string = process.platform): string[] | null {
  if (platform === "linux") {
    const script = firstOf(["/usr/bin/script", "/bin/script"]);
    return script ? [script, "-qec", shellQuote(argv), "/dev/null"] : null;
  }
  if (platform === "darwin") {
    const script = firstOf(["/usr/bin/script"]);
    const bash = firstOf(["/bin/bash"]);
    if (!script || !bash) return null;
    return [bash, "-c", `exec ${script} -q /dev/null "$@" < <(exec cat)`, "nouride-session", ...argv];
  }
  return null;
}

/**
 * Output kept for the next `drain`, up to `cap` characters: past it the oldest goes, and the next drain says so.
 *
 * The newest output is what a caller waiting on a prompt needs; the oldest is what it has most likely already seen.
 * Marked rather than silently trimmed, because a truncated transcript that does not say so is one that will be misread.
 */
export function outputBuffer(cap: number): { append(text: string): void; drain(): string } {
  let buffer = "";
  let dropped = false;
  return {
    append(text) {
      buffer += text;
      if (buffer.length > cap) {
        buffer = buffer.slice(buffer.length - cap);
        dropped = true;
      }
    },
    drain() {
      const out = dropped ? `[earlier output dropped]\n${buffer}` : buffer;
      buffer = "";
      dropped = false;
      return out;
    },
  };
}
