/**
 * An agent's cat in Nouride Office — `GET /status`'s `look` and `POST /agents/:id/look` — and the words each part takes.
 *
 * The page needs the words at runtime, to offer them, and nothing here exists at runtime: so the dashboard keeps its
 * own list, typed as the daemon's. A word added on one side and not the other fails the dashboard's typecheck.
 */

import type { LOOK_PARTS } from "@nouride/shared";

export type { AgentLook } from "@nouride/shared";

/** Each part of a look: its key in a pack's `[look]`, and the words it takes, in order. */
export type LookParts = typeof LOOK_PARTS;
