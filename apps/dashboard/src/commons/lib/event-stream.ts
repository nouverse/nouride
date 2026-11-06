/**
 * What a frame of the conversation's event stream (`/events/stream`) asks of the page.
 *
 * Every frame used to poll the live route. The audit row of a tool call and the usage of a model call never
 * change what the page draws — each comes with a step or an answer that does, which polls on its own — so they
 * do not. Anything else wakes it, a frame that does not parse included: a poll too many is cheap, and a poll too
 * few is the bug the stream exists to fix.
 *
 * And what it says is news for more than the live view: a `waiting` step comes before an approval is asked, and a
 * turn ending changes the list of conversations. The page polled both every second or two in case; the stream says
 * when, and the polls are a slow net under it.
 */

// `context` (1.4) too: what a model request carried changes nothing drawn; the turn's record reads it when opened.
const QUIET = new Set(["audit", "usage", "context"]);

export interface RowEffects {
  /** Poll the live view now. */
  wakes: boolean;
  /** Queries to refetch now — by key prefix. */
  refresh: readonly (readonly string[])[];
}

type Row = { kind?: unknown; data?: { phase?: unknown } } | null;

function parse(frame: string): Row {
  try {
    return JSON.parse(frame) as Row;
  } catch {
    return null;
  }
}

export function rowEffects(frame: string): RowEffects {
  const row = parse(frame);
  const kind = typeof row?.kind === "string" ? row.kind : null;
  if (kind === null) return { wakes: true, refresh: [] };
  if (kind === "waiting") return { wakes: true, refresh: [["approvals"]] };
  const phase = row?.data?.phase;
  if (kind === "turn" && (phase === "end" || phase === "note")) return { wakes: true, refresh: [["sessions"], ["rooms"]] };
  return { wakes: !QUIET.has(kind), refresh: [] };
}
