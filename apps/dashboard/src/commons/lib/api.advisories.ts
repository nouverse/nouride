/**
 * What the daemon's last boot said about how this install is set up (`boot/advisories.ts` in the engine) — said at
 * warn once and at info after, so otherwise only in the journal. Its own module, as `api.ts`'s budget note asks of a
 * new endpoint group.
 */

import { control, request } from "./api.client";

/** One thing said, with every agent it was said about — six agents with one unscoped secret is one line. */
export interface AdvisoryLine {
  message: string;
  agents: string[];
  hint?: string;
  /** When it was first said, unchanged since — epoch ms. */
  since: number;
}

export const advisoriesApi = {
  advisories: () => request<{ advisories: AdvisoryLine[] }>(`${control}/advisories`),
};
