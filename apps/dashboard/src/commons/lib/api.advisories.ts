/**
 * What the daemon's last boot said about how this install is set up (`boot/advisories.ts` in the engine) — said at
 * warn once and at info after, so otherwise only in the journal. Its own module, as `api.ts`'s budget note asks of a
 * new endpoint group.
 */

import { control, request } from "./api.client";
import type { AdvisoryLine } from "@nouride/wire";

export const advisoriesApi = {
  advisories: () => request<{ advisories: AdvisoryLine[] }>(`${control}/advisories`),
};
