/**
 * `nouride events` — what turns do, as the daemon writes it down (`modules/events/events.store.ts`).
 *
 * A page by default, oldest first after `--since`; `-f` follows the stream as it is written — from now, or from
 * `--since` — and comes back from where it was when the connection drops: a restart is often exactly what is being
 * watched. Narrowed to one turn, or one conversation, and to some kinds.
 *
 * Following, it asks for the stream's control frames (`docs/EVENTS.md`, protocol 1.1) and says what they say: a
 * daemon of another major, rows it will not replay and where to page them from, a database that went back to an
 * older state. A daemon that refuses — no token, no stream on that build — is an answer, not a dropped connection.
 */

import { EVENT_KINDS, EVENT_PROTOCOL_VERSION, eventJson, parseSse, type StreamFrameData, type StreamFrameName, type StreamRow } from "@nouride/shared";
import { flagValue, hasFlag, DIM, RESET, YELLOW, emit, fail, say, usageError, wholeNumber } from "@nouride/cli-kit";
import type { Client } from "@nouride/cli-kit";

/**
 * A row as the daemon sends it: the envelope the contract fixes (`StreamRow`, `@nouride/shared`), its kind and data
 * read loosely — a daemon newer than this CLI may send a kind it has never heard of, which it prints rather than
 * refuses.
 */
type StreamEvent = Omit<StreamRow, "kind" | "data"> & { kind: string; data: Record<string, unknown> };

const RECONNECT_MS = 3_000;
/** Three keep-alives missed: the connection is gone even if nothing said so, and it is opened again. */
const IDLE_MS = 45_000;

export async function events(client: Client, args: string[]): Promise<void> {
  const params = new URLSearchParams();
  const turn = flagValue(args, "--turn");
  const gateway = flagValue(args, "--gateway");
  const chat = flagValue(args, "--chat");
  const kinds = flagValue(args, "--kinds");
  const since = flagValue(args, "--since");
  const limit = flagValue(args, "--limit");
  if (turn) params.set("turn", turn);
  // A conversation is a chat on one connection: either alone names nothing.
  if (Boolean(gateway) !== Boolean(chat)) usageError("--gateway and --chat name one conversation together.", "nouride events --gateway telegram:main --chat 814");
  if (gateway && chat) {
    params.set("gateway", gateway);
    params.set("chat", chat);
  }
  if (kinds) params.set("kinds", kinds);
  if (since !== undefined) params.set("since", String(wholeNumber("events", since)));
  if (limit !== undefined) params.set("limit", String(wholeNumber("events", limit)));

  if (!hasFlag(args, "-f", "--follow")) {
    // The newest page unless a cursor is given: a bare `nouride events` printed the oldest rows kept, a month old.
    if (since === undefined) params.set("newest", "1");
    const page = await client.get<{ events: StreamEvent[]; next: number }>(`/events?${params.toString()}`);
    emit(page);
    if (page.events.length === 0) return say(`${DIM}nothing after #${page.next}${RESET}`);
    for (const event of page.events) say(eventLine(event));
    return say(`${DIM}next: --since ${page.next}${RESET}`);
  }

  // From now unless asked otherwise: following from 0 replayed the whole table before the first new row.
  let last: number | null = since === undefined ? null : Number(params.get("since"));
  params.set("frames", "1");
  for (;;) {
    let wait = RECONNECT_MS;
    try {
      if (last === null) params.set("tail", "1");
      else {
        params.delete("tail");
        params.set("since", String(last));
      }
      for await (const item of readFrames(await client.open(`/events/stream?${params.toString()}`), IDLE_MS)) {
        if (item.row) {
          last = item.row.seq;
          say(eventLine(item.row));
          continue;
        }
        const told = controlLine(item.frame, last);
        if (told.line) say(told.line);
        if (told.from !== undefined) last = told.from;
        // Following from now: the newest row when the stream opened is the cursor, so a drop before the first row
        // comes back from there rather than from "now" again, which would lose what was written in between.
        else if (item.frame.event === "hello" && last === null) last = item.frame.data.latest;
        if (item.frame.event === "bye" && item.frame.data.reason === "slow") wait = 0;
      }
    } catch (err) {
      // A refusal is the daemon's answer: following again would ask the same question every three seconds for ever.
      const status = (err as { status?: number }).status;
      if (status !== undefined && ((status >= 400 && status < 500 && status !== 408 && status !== 429) || status === 501)) {
        fail(`the event stream was refused: ${(err as Error).message}`);
      }
      if ((err as { hint?: string }).hint) fail((err as Error).message, (err as { hint?: string }).hint);
      // A dropped stream is not the end of following it: the daemon may be restarting.
    }
    say(`${DIM}the stream closed, following again from ${last === null ? "now" : `#${last}`}${RESET}`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** One control frame (1.1), as `readFrames` gives it. */
export type ControlFrame = { [F in StreamFrameName]: { event: F; data: StreamFrameData[F] } }[StreamFrameName];

/**
 * What a control frame means for a follower: a line to print, and the cursor to follow from when it moves one. A
 * `hello` of another major is said — rows may not read right — and nothing else about it; the rest move or explain.
 */
export function controlLine(frame: ControlFrame, last: number | null): { line?: string; from?: number } {
  switch (frame.event) {
    case "hello": {
      const theirs = frame.data.version.split(".")[0];
      return theirs === EVENT_PROTOCOL_VERSION.split(".")[0]
        ? {}
        : { line: `${YELLOW}!${RESET} the daemon speaks event protocol ${frame.data.version}, this CLI ${EVENT_PROTOCOL_VERSION}, so rows may not read right` };
    }
    case "gap":
      return frame.data.reason === "swept"
        ? { line: `${DIM}rows #${frame.data.since + 1}–#${frame.data.until} are gone with their turns' retention${RESET}` }
        : {
            line: `${DIM}rows #${frame.data.since + 1}–#${frame.data.until} are too many to replay here (nouride events --since ${frame.data.since})${RESET}`,
            from: frame.data.until,
          };
    case "reset":
      return {
        line: `${YELLOW}!${RESET} the daemon's database is older than #${last ?? 0} (restored or rolled back); following from #${frame.data.latest}`,
        from: frame.data.latest,
      };
    case "bye":
      return { line: `${DIM}the daemon ended the stream: ${frame.data.reason === "slow" ? "this reader fell behind" : "it is shutting down"}${RESET}` };
    case "thinking":
      // A model call under way (1.2): `nouride chat` draws it; a page of rows has nothing to add for it.
      return {};
  }
}

/** Every frame this CLI knows — one entry per frame of the contract, or this does not compile. */
const KNOWN_FRAMES = { hello: true, gap: true, reset: true, bye: true, thinking: true } satisfies Record<StreamFrameName, true>;
const CONTROL_FRAMES: readonly string[] = Object.keys(KNOWN_FRAMES);

/**
 * Rows and the control frames this CLI knows, in order, read by the one SSE parser (`@nouride/shared`). A frame of a
 * later protocol it does not know, or one that is not a row, is passed over rather than printed as one: this reader
 * used to read every frame's data as a row, and the first it did not know broke the follow and its cursor.
 */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs?: number,
): AsyncGenerator<{ row: StreamEvent; frame?: undefined } | { row?: undefined; frame: ControlFrame }> {
  for await (const frame of parseSse(body, idleTimeoutMs)) {
    const data = eventJson<Record<string, unknown>>(frame);
    if (!data) continue;
    if (frame.event) {
      if (CONTROL_FRAMES.includes(frame.event)) yield { frame: { event: frame.event, data } as unknown as ControlFrame };
      continue;
    }
    const row = data as unknown as StreamEvent;
    if (typeof row.seq !== "number" || typeof row.kind !== "string" || typeof row.data !== "object" || row.data === null) continue;
    yield { row };
  }
}

/**
 * One line per event: where it is in the stream, when, what kind, whose turn, and what it says. A kind newer than this
 * CLI — the stream may add one within its major version — is printed with its text and marked, not refused.
 */
export function eventLine(event: StreamEvent): string {
  const time = new Date(event.at).toISOString().slice(11, 19);
  const turn = event.turnId ? event.turnId.slice(-8) : "-";
  const newer = (EVENT_KINDS as readonly string[]).includes(event.kind) ? "" : ` ${DIM}(a kind newer than this CLI)${RESET}`;
  return `${DIM}#${event.seq} ${time}${RESET} ${event.kind.padEnd(11)} ${DIM}${turn} ${event.agentId ?? ""}${RESET} ${summary(event)}${newer}`;
}

function summary(event: StreamEvent): string {
  const data = event.data;
  const one = (value: unknown, max = 100) => String(value ?? "").replace(/\s+/g, " ").slice(0, max);
  // A person's edit (`editOf`, stream 1.3): a turn answering one, or a message edited while a turn worked — said in a
  // word, and the steer's `✎` (kept for a reader that knows no `editOf`) left off, since the word says it.
  const edited = typeof data.editOf === "string" ? ` ${DIM}(edited)${RESET}` : "";
  switch (event.kind) {
    case "turn":
      // A delegate's own turn (1.4) says whose: `start (ask_agent · nox): …`.
      return data.phase === "end"
        ? `ended ${one(data.status)}${data.error ? `: ${one(data.error)}` : ""}`
        : `${one(data.phase)}${typeof data.via === "string" ? ` (${one(data.via)} · ${one(data.by)})` : ""}: ${one(data.prompt)}${edited}`;
    case "steer":
      return `${one(edited ? String(data.text ?? "").replace(/^✎ /, "") : data.text)}${edited}`;
    case "reply":
      return `+${one(data.text).length} chars of the answer`;
    case "audit":
      return `${one(data.tool)} ${one(JSON.stringify(data.args ?? {}), 80)}${data.error || data.threw ? " (failed)" : ""}${call(data)}`;
    case "tool":
    case "tool_done":
      return `${one(data.text)}${call(data)}`;
    case "usage":
      return `${one(data.model)} ${one(data.inputTokens)}→${one(data.outputTokens)} tokens${typeof data.usd === "number" ? ` $${data.usd.toFixed(4)}` : ""}`;
    case "unstep":
      return `steps ${one(JSON.stringify(data.steps))} taken back`;
    case "context":
      // What a model request carried (1.4): `request 3: ~148200 tokens, 2 cleared, summary`.
      return `request ${one(data.request)}: ~${one(data.estimatedTokens)} tokens, ${one(data.cleared)} cleared${data.summary === true ? ", summary" : ""}${typeof data.by === "string" ? ` ${DIM}(${one(data.by)})${RESET}` : ""}`;
    default:
      return one(data.text);
  }
}

/** The call a row pairs by — a `tool`, its `tool_done` and its `audit` row carry the same one. */
function call(data: Record<string, unknown>): string {
  return typeof data.callId === "string" ? ` ${DIM}${data.callId}${RESET}` : "";
}
