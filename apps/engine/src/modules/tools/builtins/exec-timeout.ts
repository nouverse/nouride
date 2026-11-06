/**
 * What a foreground command killed at its timeout says next, so the retry is the right one.
 *
 * The decision it has to support is narrow — run it again in the background, or not — and the
 * evidence for it is what the command was doing when it died. Without that evidence the advice can
 * only guess, and a guess cost the live box two attempts on 2026-10-12: Claude Code's installer
 * prints nothing while it downloads 257 MB, so a killed attempt looked exactly like a hang, and the
 * agent's second try was the same command under `bash -x`. `runCommand` now measures the process
 * group just before the kill (`activity`), and this turns the measurement into the sentence.
 */

import type { SandboxResult } from "@nouride/shared";

/** Programs and flags that stream until killed: more time never finishes them. */
const STREAMS = new Set(["watch", "top", "htop", "btop", "less", "more", "vi", "vim", "nano"]);
const FOLLOW_FLAGS = new Set(["-f", "-F", "--follow", "-w", "--watch"]);
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "rsync", "nc", "ping", "git"]);

/**
 * Enough to call it work, over any timeout this tool allows. A `bash -lc` that only read its profile
 * moves a few kilobytes and a hundredth of a second of CPU; a download, an unpack or a compile is
 * past either line within seconds.
 */
const WORKING_BYTES = 1024 * 1024;
const WORKING_CPU_SECONDS = 1;

type Activity = NonNullable<SandboxResult["activity"]>;

/** What to run instead of something that never exits — after a timeout killed it, or before the background took it. */
export const SNAPSHOT_ADVICE = "Take a snapshot instead: `tail -n 100`, `journalctl -n 100 --no-pager`, `docker logs --tail 100`, `ps aux`.";

/** The most a foreground command may wait in an ordinary turn. */
const FOREGROUND_MAX_MS = 240_000;

/**
 * How long a foreground command waits: what the call asked for, from a second up to `max`, or `fallback` when it asked
 * for nothing.
 *
 * `max` is 240 seconds, below a turn's clock rather than equal to it. They were the same, so a command asking for its
 * full budget was guaranteed to be killed by the turn's deadline first — two limits that had never been compared
 * against each other. A foreground command has to finish inside a turn, and anything longer belongs in
 * `background: true`, which is the honest division rather than a race between two timers. A helper working in the
 * background (0.7.15) has no `background` — it is the background, and every command it runs is in the foreground — so
 * its toolset sets `ToolContext.commandMaxMs` higher, and its own clock bounds the rest.
 */
export function foregroundWait(raw: unknown, fallback: number, max = FOREGROUND_MAX_MS): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return fallback;
  return Math.min(Math.max(1000, Math.trunc(raw)), max);
}

/**
 * `reportsTo`: in a turn another agent asked for (`ToolContext.askedBy`), the agent a job's end goes to — not this one,
 * which is never woken for it (0.8.8).
 */
export function timeoutAdvice(timeoutMs: number, argv: string[], activity?: Activity, reportsTo?: string): string {
  const back = reportsTo
    ? `you get a job id at once, and its end is reported to ${reportsTo}, which asked you, not to you. Say so in your answer, with its id`
    : "you get a job id at once and are woken when it finishes";
  const program = programOf(argv);
  const words = argv.length >= 3 && isShell(argv[0]) ? (argv[2] ?? "").split(/\s+/) : argv;
  const lost = `[killed after ${timeoutMs}ms: its work is lost and the output above is only what it printed first.`;
  if (STREAMS.has(program) || words.some((word) => FOLLOW_FLAGS.has(word))) {
    return `${lost} It follows or streams and never exits on its own, so neither more time nor \`background: true\` will finish it. ${SNAPSHOT_ADVICE}]`;
  }
  const again = "Running it again in the foreground with a shorter wait changes nothing.";
  // CPU alone where the bytes cannot be read — a command run as its agent's own user, whose I/O counters are its own.
  const measured =
    activity && activity.cpuSeconds !== null
      ? { quietForMs: activity.quietForMs, bytesMoved: activity.bytesMoved, cpuSeconds: activity.cpuSeconds }
      : null;
  if (measured) {
    const seen = `${describe(measured)}; ${quiet(measured.quietForMs, timeoutMs)}.`;
    if ((measured.bytesMoved ?? 0) >= WORKING_BYTES || measured.cpuSeconds >= WORKING_CPU_SECONDS) {
      return `${lost} When it was killed it had ${seen} That is work in progress, not a hang. It needed longer, so run it again with \`background: true\`: ${back}. ${again}]`;
    }
    return `${lost} In ${seconds(timeoutMs)} it had ${seen} It was waiting. If the wait is the point (a \`sleep\`, a CI run, a long poll), run it with \`background: true\`: ${back}. If it waits for something that is not coming (a host that does not answer, a prompt nothing here can type into, a lock), more time will not help: retry with explicit timeouts (\`curl --connect-timeout 5 --max-time 30\`, \`ssh -o ConnectTimeout=5 -o BatchMode=yes\`) or a non-interactive flag. ${again}]`;
  }
  // Not measured (a host without `/proc`): both cases, from the program alone.
  if (NETWORK.has(program)) {
    return `${lost} A download, or an installer that fetches one (\`curl … | bash\`), only needed longer, so run it again with \`background: true\`: ${back}. A host that never answers is the other case: retry with explicit timeouts (\`curl --connect-timeout 5 --max-time 30\`, \`ssh -o ConnectTimeout=5 -o BatchMode=yes\`), not in the background, where a hang runs until somebody stops it.]`;
  }
  return `${lost} If it genuinely needs longer (a build, a test suite, a long wait), run it again with \`background: true\`: ${back}. ${again}]`;
}

/**
 * The program that does the work: the first word of a `bash -lc` script, not `bash`.
 *
 * Every command with a pipe or a redirect is run through `bash -lc`, so reading `argv[0]` named the
 * shell for all of them — `curl … | bash` was never recognised as a download.
 */
function programOf(argv: string[]): string {
  const first = isShell(argv[0]) && argv.length >= 3 ? firstCommandWord(argv[2] ?? "") : (argv[0] ?? "");
  return first.split("/").pop() ?? "";
}

function isShell(program: string | undefined): boolean {
  return /(^|\/)(ba|z|da)?sh$/.test(program ?? "");
}

/** Skips `VAR=value` assignments and `export …;` preambles. */
function firstCommandWord(script: string): string {
  const segment = script.split(/;|&&|\|\|/).find((part) => !/^\s*export\s/.test(part)) ?? script;
  return segment.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
}

function describe(activity: { bytesMoved: number | null; cpuSeconds: number }): string {
  const cpu = activity.cpuSeconds >= 0.1 ? `used ${activity.cpuSeconds.toFixed(1)} s of CPU` : "used no CPU to speak of";
  if (activity.bytesMoved === null) return cpu;
  // Read plus written, so a copy counts twice — an indicator of work, not a transfer size.
  const data = activity.bytesMoved >= WORKING_BYTES ? `read and written ${size(activity.bytesMoved)}` : "read and written almost nothing";
  return `${data} and ${cpu}`;
}

function quiet(quietForMs: number, timeoutMs: number): string {
  if (quietForMs >= timeoutMs - 500) return "it printed nothing at all";
  if (quietForMs < 2_000) return "it was still printing";
  return `it had printed nothing for the last ${seconds(quietForMs)}`;
}

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}
