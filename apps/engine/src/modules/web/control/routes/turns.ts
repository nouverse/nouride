/**
 * Turns, read whole — what `nouride turns` asks.
 *
 * The dashboard reads a turn through its conversation; this reads one by its id, with what the transcript does not
 * carry: each model call with its tokens, cost, latency and retries, and the audit log's rows for its tool calls.
 */

import type { TurnRecordDetail } from "@nouride/wire";
import type { ControlApp, ControlDeps } from "../types.ts";
import { conversationFor } from "../conversation.ts";
import { readerOf, type Reader } from "../whose.ts";

/** Turns a list asks for, at most. Newest first, so the bound only ever cuts the old end. */
const LIST_MAX = 200;

/** A turn is its conversation's: read by whoever may open that (`whose.ts`). */
function readable(deps: ControlDeps, reader: Reader, turnId: string): boolean {
  if (reader.everyone) return true;
  const turn = deps.turns?.get(turnId);
  return Boolean(turn && conversationFor(deps, reader, turn.sessionId));
}

export function registerTurnRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/turns", (c) => {
    if (!deps.turnInspector) return c.json({ error: "turn records are not available" }, 501);
    const asked = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, LIST_MAX) : 20;
    const agentId = c.req.query("agent")?.trim();
    const reader = readerOf(c.get("principal"), deps.ctx.config.people);
    return c.json({ turns: deps.turnInspector.recent({ limit, ...(agentId ? { agentId } : {}) }).filter((turn) => readable(deps, reader, turn.id)) });
  });

  control.get("/turns/:id", (c) => {
    if (!deps.turnInspector) return c.json({ error: "turn records are not available" }, 501);
    const id = c.req.param("id");
    const found = deps.turnInspector.inspect(id);
    if (!found || !readable(deps, readerOf(c.get("principal"), deps.ctx.config.people), found.turn.id)) {
      return c.json({ error: `no turn ${id}`, note: "`nouride turns` lists the newest; a shortened id has to name one turn", plain: "That record is not there any more." }, 404);
    }
    return c.json(found satisfies TurnRecordDetail);
  });
}
