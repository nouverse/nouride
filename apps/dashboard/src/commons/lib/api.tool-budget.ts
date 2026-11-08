/**
 * What one reply may spend: how many tool round-trips, and how many seconds of wall clock.
 *
 * Split out of `api.ts` for the reason `api.setup.ts`, `api.skills.ts` and `api.update.ts` were:
 * that file is over its line budget and may not grow. Spread into `api` rather than imported
 * separately, so `api.setToolIterations()` reads the same at every call site.
 */

import { control, post, request } from "./api.client";
import type { ToolIterationsPolicy, TurnSecondsPolicy } from "@nouride/wire";

export const toolBudgetApi = {
  /** The daemon-wide wall clock, in seconds, with the bounds and the queue's ceiling. */
  turnSecondsPolicy: () => request<TurnSecondsPolicy>(`${control}/policy/turn-seconds`),
  setTurnSeconds: (turnSeconds: number) =>
    post<{ ok: true; turnSeconds: number }>(`${control}/policy/turn-seconds`, { turnSeconds }),
  /** One agent's own clock. `null` means "follow the daemon", the same as the tool budget. */
  setAgentTurnSeconds: (agent: string, turnSeconds: number | null) =>
    post<{ ok: true }>(`${control}/agents/${agent}/turn-seconds`, { turnSeconds }),
  /** The daemon-wide tool budget, with the bounds the form has to respect. */
  toolIterationsPolicy: () =>
    request<ToolIterationsPolicy>(
      `${control}/policy/tool-iterations`,
    ),
  setToolIterations: (maxToolIterations: number) =>
    post<{ ok: true; maxToolIterations: number }>(`${control}/policy/tool-iterations`, {
      maxToolIterations,
    }),
  /**
   * One agent's own budget. `null` means "follow the daemon" and is a value, not an omission —
   * a number equal to today's default would stop tracking it tomorrow.
   */
  setAgentToolIterations: (agent: string, maxToolIterations: number | null) =>
    post<{ ok: true; maxToolIterations: number | null; daemonDefault: number }>(
      `${control}/agents/${agent}/tool-iterations`,
      { maxToolIterations },
    ),
};
