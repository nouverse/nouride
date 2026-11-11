/**
 * A restart, followed from this tab until the daemon is back — and the page with it.
 *
 * Three places followed a restart and each did part of it: Overview's Restart (`useDaemonRestart`) waited for a new
 * process and refetched every query, the update page's card waited for the version it installed and reloaded, and the
 * reconnecting banner only said the daemon was not answering. None kept the page quiet while it was down: a query that
 * polled into the gap failed and showed its error until somebody reloaded. This is the one follower:
 *
 * - it waits for the process asked to restart to go and a new one to answer — `/health` done starting, then
 *   `/auth/me` (`restart-watch.ts` decides from each look);
 * - while nothing answers, it holds every query (`onlineManager`), so nothing on the page fails into the gap;
 * - back, it compares the build the daemon now serves with this page's — the entry script's hashed name in
 *   `index.html` — and reloads into a new one, or else refetches every query on the page it is on;
 * - a restart nobody here asked for (another tab, the CLI, a crash) is noticed by a query that could not reach the
 *   daemon (`whenUnreachable`), and followed the same way, except that a new build is left to `UpdatedBanner` to
 *   offer: whoever is typing in this tab did not ask for the page to go.
 *
 * A module, not a hook: a restart outlives the button that asked for it — the person navigates away while it waits —
 * and every page shows the same one.
 */

import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { HealthPayload } from "@nouride/wire";
import { ApiError, whenUnreachable } from "./api.client";
import { lookAgain, lookAtInstall, POLL_MS, readRestart, type InstallPhase, type RestartWatch } from "./restart-watch";

/** What is being followed: a restart this tab asked for, an update's, or one nobody here asked for. */
export type RestartKind = "restart" | "install" | "outage";

export type RestartState =
  | { phase: "idle" }
  | {
      phase: "waiting" | "restarting" | "stuck" | "back";
      kind: RestartKind;
      /** What the daemon said when asked: what it waits for. */
      note: string | null;
      /** The version an update installed, for the update page's card. */
      expected?: string;
      startedAt: number;
    }
  /** An update's restart came back on another version: the new one did not start. */
  | { phase: "rolled-back"; kind: "install"; running: string; expected: string; startedAt: number };

/** What the follower does to the world — the browser's, or a test's. */
export interface RestartIo {
  health(): Promise<HealthPayload | null>;
  /** Whether the daemon answers for the session: signed in or not, but not unreachable and not starting. */
  answersForSession(): Promise<boolean>;
  /** The entry script of the build the daemon serves now, and of the one this page runs; null where unknown. */
  servedBuild(): Promise<string | null>;
  pageBuild(): string | null;
  /** Hold every query (`false`) or let them run again (`true`). */
  setOnline(online: boolean): void;
  refetchAll(): void;
  reload(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A background job is waited for however long it takes; a tab is not kept polling for ever. */
const WAIT_PATIENCE_MS = 12 * 60 * 60_000;
/** Long enough to read "Back on v0.7.11" before an update's page goes. */
const RELOAD_DELAY_MS = 1_500;

let state: RestartState = { phase: "idle" };
/**
 * Whether a follow is running — not whether the last one left something to say. A rollback stays said on the update
 * page's card and `stuck` stays on the strip, and both used to count as following: an outage after either went
 * unfollowed, with no strip and nothing held, and Restart did nothing. Found by a test that ran after one ending in a
 * rollback (2026-10-17).
 */
let active = false;
const listeners = new Set<() => void>();
/** The restarts that finished here, for whatever wants to say so once (`RestartFollower`). */
let finished = 0;
/** Saves since the last restart that wait for one, by what was saved (`useSaved`). */
let pending: string[] = [];

function set(next: RestartState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The restart being followed, if any. */
export function restartState(): RestartState {
  return state;
}

export function useRestart(): RestartState {
  return useSyncExternalStore(subscribe, restartState, restartState);
}

/** How many restarts have come back in this tab — a change is one more back. */
export function useRestartsFinished(): number {
  return useSyncExternalStore(subscribe, () => finished, () => finished);
}

/** What was saved and waits for a restart, newest last. */
export function restartPending(): readonly string[] {
  return pending;
}

export function useRestartPending(): readonly string[] {
  return useSyncExternalStore(subscribe, restartPending, restartPending);
}

/** A save that takes effect only after a restart: said until one happens. */
export function markRestartPending(what: string): void {
  if (pending.includes(what)) return;
  pending = [...pending, what];
  for (const listener of listeners) listener();
}

/** Whether a restart is being followed now — what starting another one waits for. */
export function following(): boolean {
  return active;
}

/** The daemon not answering, as opposed to answering no — `session.ts` reads a session the same way. */
function unreachable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const status = error.status;
  return status === 0 || (status >= 502 && status <= 504) || (status >= 520 && status <= 527);
}

/** The hashed entry script an `index.html` loads — the one name that changes with every build. */
export function entryScript(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) return src;
  }
  return null;
}

/**
 * Follow a restart to its end: see the top of this file. `before` is the uptime of the process asked to restart, or
 * null when it was not answering; `held` says the daemon is going down at once, so queries are held from the start.
 */
export async function follow(io: RestartIo, start: { kind: RestartKind; before: number | null; note?: string | null; expected?: string; held?: boolean }): Promise<void> {
  const startedAt = io.now();
  const base = { kind: start.kind, note: start.note ?? null, startedAt, ...(start.expected ? { expected: start.expected } : {}) };
  let watch: RestartWatch = { before: start.before, awaySince: null };
  let held = start.held === true;
  // Before the first await, so two callers in one tick cannot both start one.
  active = true;
  if (held) io.setOnline(false);
  // Waiting is for a daemon that said it waits for running work; one going down at once is restarting from the start.
  set({ phase: held ? "restarting" : "waiting", ...base });

  try {
    let phase: InstallPhase = "waiting";
    let running: string | undefined;
    while (io.now() - startedAt < WAIT_PATIENCE_MS) {
      await io.sleep(POLL_MS);
      const health = await io.health().catch(() => null);
      const look = start.expected ? lookAtInstall(watch, health, start.expected, io.now()) : lookAgain(watch, health, io.now());
      watch = look.watch;
      phase = look.phase;
      running = health?.version ?? running;
      // Answering, and the same process, after a query could not reach it: a blip, not a restart — nothing to wait for.
      if (start.kind === "outage" && phase === "waiting") phase = "back";
      if (phase === "back" || phase === "rolled-back") break;
      if (phase !== "waiting" && !held) {
        held = true;
        io.setOnline(false);
      }
      set({ phase, ...base });
    }
    if (phase !== "back" && phase !== "rolled-back") return set({ phase: "stuck", ...base });

    // Back on /health, which answers before the routes do: the session's own answer is the one the page needs.
    while (!(await io.answersForSession().catch(() => false))) await io.sleep(POLL_MS);

    if (phase === "rolled-back") {
      io.setOnline(true);
      io.refetchAll();
      return set({ phase: "rolled-back", kind: "install", running: running ?? "the previous version", expected: start.expected!, startedAt });
    }

    // A restart applies every save that waited for one; a blip — the same process, answering again — applies nothing.
    if (start.kind !== "outage" || watch.awaySince !== null) pending = [];
    const served = await io.servedBuild().catch(() => null);
    const page = io.pageBuild();
    const newBuild = served !== null && page !== null && served !== page;
    // An update always reloads: the files its page came from were replaced. A restart reloads only into a new build,
    // and one nobody here asked for never does — `UpdatedBanner` offers it instead.
    if (start.kind === "install" || (start.kind === "restart" && newBuild)) {
      set({ phase: "back", ...base });
      await io.sleep(start.kind === "install" ? RELOAD_DELAY_MS : 0);
      return io.reload();
    }
    io.setOnline(true);
    io.refetchAll();
    if (start.kind === "restart") finished += 1;
    set({ phase: "idle" });
  } finally {
    // However it ended, nothing stays held but a page that is about to reload.
    if (state.phase !== "back") io.setOnline(true);
    active = false;
  }
}

let asking = false;

/**
 * One request ran out of this page's patience. That is a slow route until `/health` is silent too: the weekly skill
 * review answered after minutes, was cut at the client's seconds, and the strip said Nouride was probably restarting
 * while it ran on. So one look first, and an outage is followed only when that look finds nothing answering.
 */
export async function afterSlowAnswer(io: RestartIo): Promise<void> {
  if (asking || active) return;
  asking = true;
  try {
    const health = await io.health().catch(() => null);
    if (readRestart(health, null, false) !== "away" || active) return;
  } finally {
    asking = false;
  }
  await follow(io, { kind: "outage", before: null, held: true });
}

// ── The browser's side ──────────────────────────────────────────────────────────────────────────────────────────────

let client: QueryClient | null = null;

/**
 * Called once, with the app's query client: a restart refetches it, and a request that finds the daemon not answering
 * starts following one (`whenUnreachable`).
 */
export function connectRestart(queryClient: QueryClient): void {
  client = queryClient;
  whenUnreachable((how) => {
    if (following()) return;
    if (how === "slow") void afterSlowAnswer(browser);
    else void follow(browser, { kind: "outage", before: null, held: true });
  });
}

const BASE = "/dashboard/";

const browser: RestartIo = {
  health: () => api.health().catch(() => null),
  answersForSession: async () => {
    try {
      await api.me();
      return true;
    } catch (error) {
      return error instanceof ApiError && !unreachable(error);
    }
  },
  servedBuild: async () => {
    const response = await fetch(BASE, { cache: "no-store", credentials: "same-origin" });
    return response.ok ? entryScript(await response.text()) : null;
  },
  pageBuild: () => document.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null,
  setOnline: (online) => onlineManager.setOnline(online),
  refetchAll: () => void client?.invalidateQueries(),
  reload: () => window.location.reload(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Restart the daemon and follow it back. Rejects when the daemon refuses — nothing would start it again — with the
 * route's own reason. A second press while one is followed joins it.
 */
export async function restartDaemon(): Promise<void> {
  await restartThrough(async () => {
    const ack = await api.restartDaemon();
    return { waiting: ack.waiting, note: ack.plain ?? ack.note };
  });
}

/**
 * A restart another request asks for, followed as Restart's is: `ask` makes the request and answers the restart it
 * started, or null when it started none — turning the LLM gateway off, which restarts only where something runs.
 * Rejects with the request's own refusal.
 */
export async function restartThrough(ask: () => Promise<{ waiting: boolean; note: string } | null>): Promise<void> {
  if (following()) return;
  const before = await api.health().then((health) => health.uptime).catch(() => null);
  const ack = await ask();
  if (!ack) return;
  void follow(browser, { kind: "restart", before, note: ack.waiting ? ack.note : null, held: !ack.waiting });
}

/** Stop waiting for running work: the daemon restarts on its next look. A refusal means it is already going down. */
export function restartNow(): void {
  void api.restartDaemon({ now: true }).catch(() => {});
}

/** An update's restart, from the moment its install answered. */
export function followInstall(input: { before: number | null; expected: string; note: string }): void {
  if (following()) return;
  void follow(browser, { kind: "install", before: input.before, expected: input.expected, note: input.note });
}
