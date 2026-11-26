/**
 * How much of an account's limits is used, as its coding CLI says while it works.
 *
 * A message refused for a limit is how an agent learns its account is spent, and by then the turn has stopped once.
 * claude-agent-acp says the use itself with every count of the context: each limit's window, the share of it used and
 * when it starts again. Read into the one shape every CLI's use is kept in (`CliUse`) by the CLI's own row
 * (`CliRow.use`), never by the CLI's name; what an agent that asked to move on before the limit reads of it
 * (`rotation.ts`) is the fullest window.
 */

import type { CliUse } from "@nouride/acp";

/** An account's fullest limit: the share of it used, from 0 to 1, and when it starts again. */
export interface AccountUse {
  used: number;
  until: number;
}

/**
 * Of an account's windows that have not started again yet, the fullest, with when it starts again. Null where it
 * said none, or none says when it starts again: a share with no end is nothing to wait for.
 */
export function fullest(use: CliUse | null, now: number): AccountUse | null {
  let found: AccountUse | null = null;
  for (const window of (use?.limits ?? []).flatMap((limit) => limit.windows)) {
    if (window.resetsAt === null || window.resetsAt <= now) continue;
    if (!found || window.usedPercent / 100 > found.used) found = { used: window.usedPercent / 100, until: window.resetsAt };
  }
  return found;
}
