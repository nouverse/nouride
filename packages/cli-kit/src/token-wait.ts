/**
 * No control token yet, asked about rather than reported.
 *
 * `/health` answers from the first second of boot (`web/server.ts`), and the control token is written near its
 * end, when the control plane starts — on a first start the file does not exist until then. A command run in that
 * window found no token and said to "start the daemon once": the daemon that was, at that moment, starting. So a
 * missing token is put to `/health` first. This install's daemon saying it is starting is waited for, a moment, until
 * its token is there; anything else is said as what it is.
 *
 * Pure but for its two looks, which are handed in — `/health`, and whether the file is there yet — so a test hands it a
 * boot that takes its time, one that never finishes, and one that dies halfway.
 */

import type { Seen } from "./wait-back.ts";

/** Long enough for a boot to reach its control plane — a first start's is quick — and short enough not to hang a script. */
const WAIT_MS = 30_000;
const POLL_MS = 250;

export interface TokenWaitDeps {
  /** One look at `/health` (`lookAtHealth`). */
  look: () => Promise<Seen>;
  /** Whether the control token is there now. */
  tokenExists: () => Promise<boolean>;
  /** A line about the wait, for the person watching. */
  say: (line: string) => void;
  /** This install's fingerprint (`installFingerprint`), to tell its daemon from another install's on the port. */
  install: string;
  /** Where the token is expected, for what is said when there is none. */
  path: string;
  baseUrl: string;
  /** `[control] enabled` — off, the daemon writes no token at all. */
  controlEnabled: boolean;
  /** How to start the daemon here (`startHint`). */
  startHint: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** Why there is no token to use — or null, when there is one now. */
export async function awaitControlToken(deps: TokenWaitDeps): Promise<{ message: string; hint: string } | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let seen = await deps.look();

  // Nothing of this install's is starting: the token is missing because no daemon of it has ever run, or the one on
  // the port is somebody else's — either way, not something a wait would change.
  const starting = (look: Seen) => look.status === "starting" && (look.install === undefined || look.install === deps.install);
  if (!starting(seen)) {
    if (await deps.tokenExists()) return null;
    return absent(deps, seen);
  }

  let said = "";
  for (;;) {
    if (await deps.tokenExists()) return null;
    if (!starting(seen)) {
      if (!seen.reachable || seen.status === "shutting_down") {
        return {
          message: `The daemon at ${deps.baseUrl} stopped while it was starting, before it wrote its control token.`,
          hint: `${deps.startHint()} Its log says why it stopped.`,
        };
      }
      return upWithoutToken(deps);
    }
    const line = `nouride is starting${seen.phase ? ` (${seen.phase})` : ""}; waiting for its control token`;
    if (line !== said) {
      deps.say(line);
      said = line;
    }
    if (now() - started >= (deps.timeoutMs ?? WAIT_MS)) {
      return {
        message: `The daemon at ${deps.baseUrl} is still starting${seen.phase ? ` (${seen.phase})` : ""}, and has not written its control token yet.`,
        hint: "Try again in a moment. Its log says what it is doing: `journalctl -u nouride -f` under systemd.",
      };
    }
    await sleep(POLL_MS);
    seen = await deps.look();
  }
}

/** No token, and no daemon of this install starting: none has run here yet — or the one on the port is not this install's. */
function absent(deps: TokenWaitDeps, seen: Seen): { message: string; hint: string } {
  if (seen.reachable && seen.install !== undefined && seen.install !== deps.install) {
    return {
      message: "No control token found.",
      hint:
        `Expected ${deps.path}, which this install's daemon writes the first time it starts. What answers at ${deps.baseUrl} is another ` +
        "install's daemon. Run the command from the install whose daemon that is, or set $NOURIDE_URL and $NOURIDE_TOKEN for one elsewhere.",
    };
  }
  if (seen.reachable && seen.status !== "starting" && seen.status !== "shutting_down") return upWithoutToken(deps);
  return {
    message: "No control token found.",
    hint: `Expected ${deps.path}, which the daemon writes the first time it starts. ${deps.startHint()} For a daemon elsewhere, set $NOURIDE_URL and $NOURIDE_TOKEN.`,
  };
}

/**
 * This install's daemon is up and there is no token: its control API is off, this user cannot see the file, or the file
 * was deleted after the daemon read it — which keeps its token in memory and writes the file again only when it starts.
 */
function upWithoutToken(deps: TokenWaitDeps): { message: string; hint: string } {
  if (!deps.controlEnabled) {
    return {
      message: `The daemon at ${deps.baseUrl} is up with its control API off ([control] enabled = false), so it wrote no control token.`,
      hint: "Turn it on in config.toml and restart the daemon, or use the dashboard.",
    };
  }
  return {
    message: `The daemon at ${deps.baseUrl} is up, and there is no control token at ${deps.path} that this user can see.`,
    hint:
      "The token is readable by the service user and its group: run with sudo (`sudo nouride <command>`), or join the group: " +
      "`sudo usermod -aG nouride $USER && newgrp nouride`. If it was deleted since the daemon started, a restart writes a new one.",
  };
}
