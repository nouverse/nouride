/**
 * How much of an account's limits is used, as its coding CLI says while it works.
 *
 * A message refused for a limit is how an agent learns its account is spent, and by then the turn has stopped once.
 * claude-agent-acp says the use itself with every count of the context: each limit's window, the share of it used and
 * when it starts again. Read here as the CLI's row says it is written (`CliRow.use`), never by the CLI's name, for an
 * agent that asked to move on before the limit (`rotation.ts`).
 */

import type { CliRow } from "@nouride/acp";

/** An account's fullest limit: the share of it used, from 0 to 1, and when it starts again. */
export interface AccountUse {
  used: number;
  until: number;
}

const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);

/**
 * What a session update says of the account's use: of its limits that have not started again yet, the fullest. Null
 * where the update says none, the row names no place for it, or what is there is not a share and a time.
 */
export function useOf(row: Pick<CliRow, "use">, update: unknown, now: number): AccountUse | null {
  if (!row.use) return null;
  const windows = field(field(field(update, "_meta"), row.use.meta), row.use.windows);
  if (!windows || typeof windows !== "object") return null;
  let fullest: AccountUse | null = null;
  for (const window of Object.values(windows)) {
    const used = field(window, row.use.used);
    const seconds = field(window, row.use.resets);
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || typeof seconds !== "number" || !Number.isFinite(seconds)) continue;
    if (seconds * 1000 > now && (!fullest || used > fullest.used)) fullest = { used, until: seconds * 1000 };
  }
  return fullest;
}
