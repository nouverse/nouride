/**
 * What a coding CLI's handshake lacks of what Nouride uses (0.8.24, v0.8.24 items 3 and 4): read when a new version is
 * first started, after an update and before its agents take work, and each week in CI against the newest published.
 * Its protocol version is refused by the client at `initialize` already (`client.ts`); this reads the rest — the
 * steering a message sent while the CLI works goes through, where its row says Nouride relies on it, and the session
 * modes the three presets are set with. No prompt: a check that asked for an answer spent the person's subscription
 * for every agent, and the CLI's first real turn shows the same.
 */

import type { CliRow } from "./agents.ts";
import { steeringOffered, type InitializeResult } from "./protocol.ts";

/**
 * Null where the handshake has what Nouride uses; else what is gone, in words. `modes` is what a session it opened
 * offers, or null where none could be opened (signed out): then they are no verdict.
 */
export function handshakeProblem(row: Pick<CliRow, "steering" | "modes">, info: Pick<InitializeResult, "_meta"> | null | undefined, modes: readonly string[] | null): string | null {
  if (row.steering && !steeringOffered(info)) return "it no longer offers steering, which a message sent while it works goes through";
  const wanted = [...new Set(Object.values(row.modes ?? {}))];
  const missing = modes === null ? [] : wanted.filter((mode) => !modes.includes(mode));
  if (missing.length > 0) return `its sessions no longer offer the modes Nouride's presets set (${missing.join(", ")})`;
  return null;
}
