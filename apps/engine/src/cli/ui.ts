/**
 * Terminal output: colour, the two ways to end a line, and the ways to end a command badly.
 *
 * `fail` calls `process.exit`, which is why it lives here rather than in the client — a command
 * writes for a person watching, and "say what went wrong and stop" is the same act everywhere.
 * Anything polled in the background must *throw* instead; see `Client.softGet`.
 *
 * ## Exit codes, and `--json` (D5)
 *
 * The CLI is an agent's control surface as much as a person's, and both read the exit code: 0 done, 1 failed,
 * 2 asked wrongly — an unknown command or action, an argument missing or malformed (`usageError`). Usage used to
 * be printed with 0, so a script could not tell a typo from a success.
 *
 * `--json` swaps the lines for one object on stdout, `{ ok, data, error, hint }`. `data` is what the command
 * hands `emit`, or else the daemon's last answer — the same data the lines were printed from, without the
 * formatting an agent had to read its way back through.
 */

import { clip } from "@nouride/shared";
import { crashReport } from "@/commons/crash.ts";

export const RESET = "\x1b[0m";
export const DIM = "\x1b[90m";
export const BOLD = "\x1b[1m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
export const CYAN = "\x1b[36m";

let json = false;
/** What the command said it answered with, if it said; otherwise the daemon's last answer is the data. */
let emitted: { data: unknown } | null = null;
let lastAnswer: unknown = null;

export function setJsonOutput(on: boolean): void {
  json = on;
}

export function jsonOutput(): boolean {
  return json;
}

export function say(line = ""): void {
  if (!json) console.log(line);
}

/**
 * A line about how the command is getting on — waiting for a daemon that is starting — on stderr, so stdout stays the
 * command's answer: its lines, or under `--json` its one object.
 */
export function aside(line: string): void {
  console.error(`${DIM}${line}${RESET}`);
}

/** The command's answer under `--json`. Says nothing otherwise — the lines are the answer there. */
export function emit(data: unknown): void {
  emitted = { data };
}

/** Every answer the daemon gives, so a command that never calls `emit` still has `data` (the client calls this). */
export function heard(answer: unknown): void {
  lastAnswer = answer;
}

/** Off colour codes, for an envelope a program reads. */
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Called once the command returned: under `--json`, the envelope. `ok` is the exit code's — a command that set
 * `process.exitCode` (`doctor` with a problem, `pkg` refused) answered, and said no.
 */
export function finish(): void {
  if (!json) return;
  const ok = (process.exitCode ?? 0) === 0;
  const data = emitted ? emitted.data : lastAnswer;
  const error = ok ? null : typeof (data as { error?: unknown } | null)?.error === "string" ? (data as { error: string }).error : "the command did not succeed";
  console.log(JSON.stringify({ ok, data: data ?? null, error, hint: null }));
}

function end(code: 1 | 2, message: string, hint?: string): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, data: null, error: plain(message), hint: hint ? plain(hint) : null }));
  } else {
    console.error(`${RED}✗${RESET} ${message}`);
    if (hint) console.error(`${DIM}  ${hint}${RESET}`);
  }
  process.exit(code);
}

/** Something went wrong doing what was asked: exit 1. */
export function fail(message: string, hint?: string): never {
  return end(1, message, hint);
}

/**
 * A throw nothing in the command caught: `fail` with the error's class and message, and a crash's stack on stderr —
 * under `--json` too, where stdout stays the one envelope. It printed the message alone, so a crash a customer sent
 * back had nothing to read it from.
 */
export function crashed(err: unknown): never {
  const { message, stack } = crashReport(err);
  if (stack) console.error(stack);
  return fail(message);
}

/** What was asked is not a command this CLI has — unknown, incomplete or malformed: exit 2, with how to ask. */
export function usageError(message: string, hint?: string): never {
  return end(2, message, hint);
}

/**
 * A command's own usage, for a call missing what it needs: exit 2, the first line as the message and the rest as the
 * hint. These were printed with `say` and exit 0, so the agent's `nouride` tool read "restart needs --then" as a
 * success, and under `--json` the answer was `{ok: true, data: null}`.
 */
export function usageLines(text: string): never {
  const [first = "", ...rest] = plain(text).split("\n");
  return usageError(first.trim(), rest.join("\n").trim() || undefined);
}

/**
 * One line per entry, whatever the payload.
 *
 * The record keeps arguments in full — that is the difference between "ran skill_create" and
 * knowing what it wrote. But a 3KB skill body printed raw made `nouride audit` unreadable, so the
 * *display* elides long values and says how much it left out. Read the whole thing from the
 * audit table when you need it.
 */
export function summarize(details: Record<string, unknown>, maxValue = 120): string {
  const shorten = (value: unknown): unknown => {
    if (typeof value === "string" && value.length > maxValue) {
      return `${clip(value, maxValue, maxValue)}(+${value.length - maxValue} chars)`;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shorten(v)]),
      );
    }
    return value;
  };

  return JSON.stringify(shorten(details));
}
