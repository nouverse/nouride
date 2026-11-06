/**
 * What boot says about how an install is set up — an agent with no credential, a WhatsApp number with no agent, a
 * secret every command is handed — at warn while it is new, and at info once it has been said.
 *
 * The same advisory on every boot taught an operator to skim the warn lines, and those are the lines the exec and
 * credential warnings use too. What changes is new, and said at warn again. Remembered in the `advisories` row of
 * `daemon_state` (`<data>/advisories.json` before 0.8.18): the set the last boot said, each with when it was first said.
 * `nouride doctor` lists it, and so does the dashboard's Overview (`GET /api/control/advisories`) — said at info, an
 * advisory was otherwise only in the journal.
 */

import { sha256Text } from "@nouride/runtime";
import type { Logger } from "@nouride/shared";
import type { StateRows } from "@/commons/daemon-state.store.ts";

/** Say one advisory. */
export type Advise = (message: string, data?: Record<string, unknown>) => void;

/** One advisory, as the last boot said it. */
export interface Advisory {
  message: string;
  data: Record<string, unknown>;
  /** When it was first said, unchanged since — epoch ms. */
  since: number;
}

interface Remembered extends Advisory {
  key: string;
}

/** What the row holds: the set, each with its key. */
function remembered(json: string | null): Map<string, Remembered> {
  try {
    const parsed = JSON.parse(json ?? "{}") as unknown;
    const said = (parsed as { said?: Remembered[] }).said ?? [];
    return new Map(said.map((entry) => [entry.key, entry]));
  } catch {
    // None yet, or unreadable: everything is new.
    return new Map();
  }
}

export function openAdvisories(rows: StateRows, log: Logger, now: () => number = Date.now): { advise: Advise; save(): void } {
  const before = remembered(rows.get("advisories"));
  const said = new Map<string, Remembered>();
  return {
    advise: (message, data = {}) => {
      const key = sha256Text(`${message}\n${JSON.stringify(data)}`).slice(0, 16);
      said.set(key, { key, message, data, since: before.get(key)?.since ?? now() });
      if (before.has(key)) log.info(message, { ...data, said_before: true });
      else log.warn(message, data);
    },
    save: () => {
      try {
        const entries = [...said.values()].sort((a, b) => a.key.localeCompare(b.key));
        rows.set("advisories", JSON.stringify({ version: 1, said: entries }));
      } catch {
        // A database that takes no write: each one is said at warn again next boot, which is only louder.
      }
    },
  };
}

/** The set the last boot said, oldest first, from its row: the daemon's own, or `doctor`'s read of the database file. */
export function readAdvisories(json: string | null): Advisory[] {
  return [...remembered(json).values()]
    .map(({ message, data, since }) => ({ message, data, since }))
    .sort((a, b) => a.since - b.since);
}

/** One line per thing said, with every agent it was said about — six agents with one unscoped secret is one finding. */
export interface AdvisoryLine {
  message: string;
  agents: string[];
  hint?: string;
  since: number;
}

export function groupAdvisories(advisories: readonly Advisory[]): AdvisoryLine[] {
  const lines = new Map<string, AdvisoryLine>();
  for (const advisory of advisories) {
    const line = lines.get(advisory.message) ?? { message: advisory.message, agents: [], since: advisory.since };
    const agent = advisory.data.agent_id;
    if (typeof agent === "string" && !line.agents.includes(agent)) line.agents.push(agent);
    if (typeof advisory.data.hint === "string") line.hint = advisory.data.hint;
    line.since = Math.min(line.since, advisory.since);
    lines.set(advisory.message, line);
  }
  return [...lines.values()];
}
