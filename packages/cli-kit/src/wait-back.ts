/**
 * `--wait` for `nouride restart` and `nouride update --start`: return when the daemon is back, or say why not.
 *
 * Both answered once the daemon had acknowledged — before anything had restarted — so a script, or an agent's
 * `--then`, could not tell a restart that worked from one still under way or one that never came back. The
 * dashboard has waited all along (`commons/lib/restart.ts`); this is the same wait for the CLI.
 *
 * The daemon is asked through `/health`, which needs no token and, since 0.7.3, answers from the first second of
 * boot with the step it is on. A restart can wait first: one that is not `--now` lets running turns finish, for up
 * to ten minutes, and the old process answers "ok" all that time.
 */

import { DIM, GREEN, RESET, emit, fail, say } from "./ui.ts";

/** One look at `/health`. */
export interface Seen {
  reachable: boolean;
  status?: string;
  version?: string;
  uptime?: number;
  phase?: string;
  /** Which install answered (`installFingerprint`) — a daemon starting on this port may be another install's. */
  install?: string;
}

export type Progress =
  | { kind: "waiting" }
  | { kind: "down" }
  | { kind: "starting"; phase?: string }
  | { kind: "back"; version?: string; status: string };

/**
 * Where a restart is, from one look and whether the old process has been seen to go. A process is the new one
 * once the old was seen to go — or when it is younger than the old one was, for a restart quicker than a poll.
 * Pure.
 */
export function progressOf(before: { uptime: number }, seen: Seen, wentAway: boolean): Progress {
  if (!seen.reachable || seen.status === "shutting_down") return { kind: "down" };
  if (seen.status === "starting") return { kind: "starting", ...(seen.phase ? { phase: seen.phase } : {}) };
  const fresh = wentAway || (seen.uptime !== undefined && seen.uptime < before.uptime);
  if (fresh && (seen.status === "ok" || seen.status === "degraded")) {
    return { kind: "back", status: seen.status, ...(seen.version ? { version: seen.version } : {}) };
  }
  return { kind: "waiting" };
}

/** A restart's line for each change of where it is — nothing for a look that changed nothing. */
function progressLine(progress: Progress, elapsedMs: number): string {
  const at = `${Math.round(elapsedMs / 1000)}s`;
  switch (progress.kind) {
    case "waiting":
      return `${at}  still the old process, finishing what is running before it restarts`;
    case "down":
      return `${at}  stopped`;
    case "starting":
      return `${at}  starting${progress.phase ? `: ${progress.phase}` : ""}`;
    case "back":
      return `${at}  back${progress.version ? `, ${progress.version}` : ""}${progress.status === "degraded" ? " (degraded: nouride doctor)" : ""}`;
  }
}

/** Ten minutes for running turns to finish, as the daemon allows them, and two to boot. */
const WAIT_MS = 12 * 60_000;
const POLL_MS = 500;

export interface WaitDeps {
  look: () => Promise<Seen>;
  say: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export type WaitOutcome = { back: true; version?: string; status: string; tookMs: number } | { back: false; tookMs: number; last: Progress };

/** Look until the daemon is back, saying each change, or until the wait is over. */
export async function waitUntilBack(before: { uptime: number }, deps: WaitDeps): Promise<WaitOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let wentAway = false;
  let said = "";
  let last: Progress = { kind: "waiting" };
  while (now() - started < (deps.timeoutMs ?? WAIT_MS)) {
    last = progressOf(before, await deps.look(), wentAway);
    if (last.kind === "down" || last.kind === "starting") wentAway = true;
    const line = progressLine(last, now() - started);
    // Said when where it is changes, not every half second it stays there.
    const key = line.replace(/^\d+s\s+/, "");
    if (key !== said) {
      deps.say(line);
      said = key;
    }
    if (last.kind === "back") return { back: true, status: last.status, tookMs: now() - started, ...(last.version ? { version: last.version } : {}) };
    await sleep(POLL_MS);
  }
  return { back: false, tookMs: now() - started, last };
}

/** `/health` at `baseUrl`, as a `Seen` — a refused connection or a hung one is "not reachable". */
export async function lookAtHealth(baseUrl: string): Promise<Seen> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { status?: string; version?: string; uptime?: number; phase?: string; install?: string };
    return {
      reachable: true,
      ...(body.status ? { status: body.status } : {}),
      ...(body.version ? { version: body.version } : {}),
      ...(typeof body.uptime === "number" ? { uptime: body.uptime } : {}),
      ...(body.phase ? { phase: body.phase } : {}),
      ...(typeof body.install === "string" ? { install: body.install } : {}),
    };
  } catch {
    return { reachable: false };
  }
}

/**
 * `--wait`, whole: wait, say how it went, and fail when the daemon did not come back — or came back on the version it
 * was meant to leave. `before` is a look taken before the restart was asked for.
 */
export async function waitBack(before: Seen, baseUrl: string, expect?: { version: string }, deps: Partial<WaitDeps> = {}): Promise<void> {
  const outcome = await waitUntilBack(
    { uptime: before.uptime ?? Number.MAX_SAFE_INTEGER },
    { look: () => lookAtHealth(baseUrl), say: (line) => say(`${DIM}${line}${RESET}`), ...deps },
  );
  if (!outcome.back && outcome.last.kind === "waiting") {
    // Not a restart that failed: one that has not begun. A background job has no time limit, and the daemon waits for it.
    fail(
      `Not restarted after ${Math.round(outcome.tookMs / 1000)}s: the daemon is still finishing what runs.`,
      "The note above names what it waits for; `nouride restart --now` restarts at once, and it carries on by itself otherwise.",
    );
  }
  if (!outcome.back) {
    fail(`Not back after ${Math.round(outcome.tookMs / 1000)}s.`, "`nouride logs` (or `journalctl -u nouride -n 50`) says why.");
  }
  // The update names its release by tag (`v0.7.29`), `/health` its version (`0.7.29`): one, spelled two ways. Compared
  // whole, every update that took said it had not.
  const bare = (version: string) => version.replace(/^v/, "");
  if (expect && outcome.version && bare(outcome.version) !== bare(expect.version)) {
    fail(`Back, but on ${outcome.version}: the update to ${expect.version} did not take.`, "`nouride logs` says why.");
  }
  emit({ back: true, status: outcome.status, version: outcome.version ?? null, tookMs: outcome.tookMs });
  say(`${GREEN}✓${RESET} back in ${Math.round(outcome.tookMs / 1000)}s${outcome.version ? `, ${outcome.version}` : ""}`);
}
