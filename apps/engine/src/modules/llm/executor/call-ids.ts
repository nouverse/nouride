/**
 * Every tool call of a turn with an id of its own.
 *
 * An id pairs a call with its result: for the provider, which is sent both back, and for whatever follows the
 * turn's event stream, where a `tool` row, its `tool_done` and its `audit` row carry it (`callId`). A provider does
 * not always give one. An OpenAI-compatible gateway that streams calls without ids gets `call_0`, `call_1`… from
 * the client — the same names again on the next round trip — so a follower pairing by id paired a second call with
 * the first one's result. A missing or repeated id is replaced here, before the calls are kept, and the provider is
 * sent the new one on both halves.
 */

import type { ToolCall } from "@nouride/shared";

/** `calls`, each id kept unless it is missing or already used this turn (`seen`, which this adds to). */
export function withUniqueIds(calls: readonly ToolCall[], seen: Set<string>, round: number): ToolCall[] {
  return calls.map((call, index) => {
    if (call.id && !seen.has(call.id)) {
      seen.add(call.id);
      return call;
    }
    let id = `call_${round}_${index}`;
    for (let n = 1; seen.has(id); n += 1) id = `call_${round}_${index}_${n}`;
    seen.add(id);
    return { ...call, id };
  });
}
