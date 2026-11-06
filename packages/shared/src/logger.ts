/**
 * Structured JSON logging (§15.3 SPEC).
 *
 * One line of JSON per entry on stdout, which is what container and systemd log
 * collectors already know how to read. No transport plugins, no async queue —
 * `console.log` is line-buffered and ordered, and anything fancier would be a
 * dependency for a feature nobody asked for.
 *
 * A CLI process sends them to stderr instead (`cli/main.ts`): its stdout is the
 * command's answer, and under `--json` one object a program parses. A backup
 * taken by `nouride db backup --json` logged its own line there first, so the
 * answer did not parse.
 */

import { redactLogData, redactLogText } from "./log-redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  agent_id?: string;
  chat_id?: string;
  /** The turn a line was written in, where the caller knew it (D2) — `nouride turns show` names it. */
  turn_id?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogContext {
  agent_id?: string;
  chat_id?: string;
  turn_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, ctx?: LogContext): void;
  info(message: string, ctx?: LogContext): void;
  warn(message: string, ctx?: LogContext): void;
  error(message: string, ctx?: LogContext): void;
  /** Child logger with a namespaced component and inherited context. */
  child(component: string, ctx?: LogContext): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = "info";
let pretty = false;
let stream: "stdout" | "stderr" = "stdout";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LEVEL_ORDER, value);
}

/** Set once at boot from the daemon config — and by the CLI, which keeps stdout for its answer. */
export function configureLogger(opts: { level?: LogLevel; pretty?: boolean; stream?: "stdout" | "stderr" }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.pretty !== undefined) pretty = opts.pretty;
  if (opts.stream) stream = opts.stream;
}

/** Hook for the audit log — error-level entries also land in SQLite (§15.3). */
export type LogSink = (entry: LogEntry) => void;
const sinks: LogSink[] = [];

export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

const PRETTY_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

/** Depth of `quietly` calls in progress. */
let quiet = 0;

/**
 * Run `fn` with its info and warn lines dropped; errors still go out. For a check that runs the loader over a file
 * the daemon already loaded — a config about to be written — where the loader's warnings were said at boot and
 * would otherwise be said again on every save. Synchronous only: an `await` inside would quiet whoever ran next.
 */
export function quietly<T>(fn: () => T): T {
  quiet += 1;
  try {
    return fn();
  } finally {
    quiet -= 1;
  }
}

/** What each `holding` call in progress keeps, the innermost last. */
const holds: LogEntry[][] = [];

/**
 * Run `fn` with its warn lines kept rather than written, and hand them back with what it returned. Info lines are
 * dropped and errors still go out, as under `quietly`. For a caller whose terminal is not the place for them: the CLI
 * loads the daemon's config to find its port and its data directory, and what the loader says about that file — an
 * unknown key, a setting worth a second look — is the daemon's to say at boot, and `doctor`'s and `config check`'s to
 * list among their own lines. Kept whatever the level floor, so what those two list does not depend on `LOG_LEVEL`.
 * Synchronous only, as `quietly`.
 */
export function holding<T>(fn: () => T): { value: T; held: LogEntry[] } {
  const held: LogEntry[] = [];
  holds.push(held);
  try {
    return { value: fn(), held };
  } finally {
    holds.pop();
  }
}

/** What `holdLines` keeps while it holds, and null while it does not. */
let heldLines: LogEntry[] | null = null;

/**
 * From now on, keep every warn and error line rather than write it — info and debug are dropped — until the function
 * this returns is called, which stops it and hands the lines over. For a CLI command whose report is the place for what
 * the code it runs logs: `nouride config check` loads every pack, and "agent pack failed to load", written as JSON above
 * "✓ this configuration would start", was the only place it said a pack would not. Process-wide, like `stream`, so it
 * holds across the awaits a load takes — which is why it is for a command that does one thing and exits, never the
 * daemon. `holding` inside it still takes its own warn lines.
 */
export function holdLines(): () => LogEntry[] {
  const held: LogEntry[] = [];
  heldLines = held;
  return () => {
    if (heldLines === held) heldLines = null;
    return held;
  };
}

/**
 * One line as it is written, handed to a sink and held. Scrubbed here, before any of them: the journal, the log table
 * and the audit log all read this one entry, so a credential in it is in all three (D16, `log-redact.ts`).
 */
function entryOf(level: LogLevel, component: string, message: string, ctx?: LogContext): LogEntry {
  const { agent_id, chat_id, turn_id, ...rest } = ctx ?? {};
  return {
    timestamp: new Date().toISOString(),
    level,
    component,
    message: redactLogText(message),
    ...(agent_id ? { agent_id: String(agent_id) } : {}),
    ...(chat_id ? { chat_id: String(chat_id) } : {}),
    ...(turn_id ? { turn_id: String(turn_id) } : {}),
    ...(Object.keys(rest).length > 0 ? { data: redactLogData(rest) } : {}),
  };
}

function emit(level: LogLevel, component: string, message: string, ctx?: LogContext): void {
  const hold = level === "error" ? undefined : holds.at(-1);
  if (hold) {
    if (level === "warn") hold.push(entryOf(level, component, message, ctx));
    return;
  }
  if (heldLines) {
    if (level === "warn" || level === "error") heldLines.push(entryOf(level, component, message, ctx));
    return;
  }
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  if (quiet > 0 && level !== "error") return;

  const entry = entryOf(level, component, message, ctx);
  const write = stream === "stderr" ? console.error : console.log;
  if (pretty) {
    const color = PRETTY_COLORS[level];
    const tail = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
    const who = entry.agent_id ? ` (${entry.agent_id})` : "";
    // The entry's message, scrubbed — the caller's went to the journal as written under `log_pretty`.
    write(
      `${color}${level.toUpperCase().padEnd(5)}\x1b[0m \x1b[90m${component}${who}\x1b[0m ${entry.message}${tail}`,
    );
  } else {
    write(JSON.stringify(entry));
  }

  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // A failing sink must never break the code that logged. Swallowing is the
      // only option here: reporting it would recurse through this same path.
    }
  }
}

export function createLogger(component: string, baseCtx: LogContext = {}): Logger {
  return {
    debug: (m, c) => emit("debug", component, m, { ...baseCtx, ...c }),
    info: (m, c) => emit("info", component, m, { ...baseCtx, ...c }),
    warn: (m, c) => emit("warn", component, m, { ...baseCtx, ...c }),
    error: (m, c) => emit("error", component, m, { ...baseCtx, ...c }),
    child: (sub, c) => createLogger(`${component}.${sub}`, { ...baseCtx, ...c }),
  };
}
