/**
 * The event stream, read — a page at a time, or followed as it is written (`modules/events/events.store.ts`).
 *
 * `GET /events` answers a page as JSON, oldest first after `since` — or, with `newest=1`, the newest page, still oldest
 * first within it: what `nouride events` prints, with the oldest and newest `seq` there are. `GET /events/stream` answers `text/event-stream`: the rows after `since` (or the browser's
 * `Last-Event-ID`), then every new one as it is committed, each with its `seq` as the event id, so a dropped connection
 * comes back where it left off and misses nothing; `tail` starts it at the newest row. Filtered by one turn, or one
 * conversation, and by kind. Both say which version of the stream's contract they speak (`EVENT_PROTOCOL_VERSION`,
 * `docs/EVENTS.md`).
 *
 * The stream is read as fast as its reader takes it, and no faster (1.1). The replay is a page per pull, so a reader
 * asking for everything holds one page in memory, not the table — `nouride events -f` once asked for every row there
 * was, and the daemon read them all in one synchronous stretch. It stops at `REPLAY_CAP` rows: past that, a `gap`
 * frame says where a reader pages `GET /events` from, and the stream goes on from the newest row. Rows written while
 * it replays wait in a queue; a reader that lets `LIVE_QUEUE_CAP` of them pile up is closed, and comes back losslessly
 * with its last id. The stream subscribes before it replays, so nothing falls between the two.
 *
 * `frames=1` asks for the named control frames: `hello` first, `reset` for a cursor past the newest row, `gap`, and
 * `bye` before the daemon ends the stream. Without it a reader sees rows only, as in 1.0. Either way, right after
 * `retry:` comes an id-only block — the cursor the stream starts from — so a drop before the first row resumes there
 * rather than from wherever the URL said.
 *
 * `Cache-Control: no-cache` and `X-Accel-Buffering: no`, because a proxy in front — nginx, a tunnel — holds a response
 * until it is complete otherwise, and an event stream never is. A comment line every fifteen seconds keeps an idle one
 * from being closed under it.
 */

import { contained, createLogger, EVENT_PROTOCOL_VERSION, STREAM_ROW_KEYS, type StreamFrameData, type StreamFrameName, type StreamRow } from "@nouride/shared";
import type { EventFilter, EventRow, Pulse } from "@/modules/events/events.store.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

const log = createLogger("control.events");

/** A replay is read this many rows at a time — one pull of the reader's. */
const REPLAY_PAGE = 500;
/** At most this many rows replayed to one stream: past it a `gap` frame says where to page from. */
const REPLAY_CAP = 5_000;
/** Live rows queued for a reader that is not reading them: past this it is closed, and resumes from its last id. */
const LIVE_QUEUE_CAP = 2_000;
const HEARTBEAT_MS = 15_000;

/** The filter a request asks for: `since`, `turn`, `chat` (on one `gateway`, or any), `kinds` (comma-separated), `limit`. */
function eventFilter(query: Record<string, string | undefined>, lastEventId?: string): EventFilter {
  // A reconnect's last id first: the URL still says where the stream first started.
  const since = Number.parseInt(lastEventId ?? query.since ?? "", 10);
  const limit = Number.parseInt(query.limit ?? "", 10);
  const kinds = (query.kinds ?? "").split(",").map((kind) => kind.trim()).filter(Boolean);
  return {
    ...(Number.isFinite(since) && since > 0 ? { since } : {}),
    ...(query.turn ? { turnId: query.turn } : {}),
    ...(query.chat ? { chatId: query.chat, ...(query.gateway ? { gatewayId: query.gateway } : {}) } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(query.newest === "1" ? { newest: true } : {}),
  };
}

/** A row as the contract has it on the wire — its keys and no others, whatever the store keeps beside them. */
export function wireRow(row: EventRow): StreamRow {
  return Object.fromEntries(STREAM_ROW_KEYS.map((key) => [key, row[key]])) as unknown as StreamRow;
}

/** One row as an event: its `seq` the id a reconnect resumes from, the row itself the data. */
function frame(row: EventRow): string {
  return `id: ${row.seq}\ndata: ${JSON.stringify(wireRow(row))}\n\n`;
}

/** A control frame (1.1), named, so a reader of 1.0 and a browser's `onmessage` never take it for a row. */
function named<F extends StreamFrameName>(name: F, data: StreamFrameData[F]): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function registerEventRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/events", (c) => {
    const store = deps.events;
    if (!store) return c.json({ error: "the event stream is not available" }, 501);
    const rows = store.list(eventFilter(c.req.query()));
    c.header("x-event-protocol", EVENT_PROTOCOL_VERSION);
    return c.json({
      version: EVENT_PROTOCOL_VERSION,
      oldest: store.oldest(),
      latest: store.latest(),
      events: rows.map(wireRow),
      next: rows.at(-1)?.seq ?? Number.parseInt(c.req.query("since") ?? "0", 10),
    });
  });

  control.get("/events/stream", (c) => {
    const store = deps.events;
    if (!store) return c.json({ error: "the event stream is not available" }, 501);
    const asked = eventFilter(c.req.query(), c.req.header("last-event-id"));
    const frames = c.req.query("frames") === "1";
    const latest = store.latest();
    const oldest = store.oldest();
    // `tail`: only what comes next — a page opening a conversation has read its history already. A reconnect
    // carries the browser's last id, and resumes from it instead.
    const wanted = c.req.query("tail") && asked.since === undefined ? latest : (asked.since ?? 0);
    // Past the newest row: the database went back to an older state, and the next rows reuse these numbers.
    const reset = wanted > latest;
    let last = reset ? latest : wanted;
    const filter = { ...asked, since: last };
    // Rows after the cursor that are gone with their turns' retention: no replay or page has them.
    const swept = oldest > 0 && last < oldest - 1;
    // Open for as long as the reader is: the server's idle timeout is for requests that end.
    c.env?.keepOpen?.(0);

    const encoder = new TextEncoder();
    let replaying = true;
    let replayed = 0;
    let closed = false;
    const queue: (EventRow | Pulse)[] = [];
    let wake = () => {};
    let stop = () => {};
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const write = (text: string) => {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(text));
      } catch {
        end();
      }
    };
    /** Close the stream — saying why first, to a reader that asked for frames. */
    const end = (reason?: StreamFrameData["bye"]["reason"]) => {
      if (closed) return;
      if (reason && frames) write(named("bye", { reason }));
      closed = true;
      stop();
      wake();
      try {
        controller.close();
      } catch {
        // Already closed by the reader going away.
      }
    };

    const body = new ReadableStream<Uint8Array>({
      start(opened) {
        controller = opened;
        write("retry: 3000\n\n");
        if (frames) write(named("hello", { version: EVENT_PROTOCOL_VERSION, oldest, latest, epoch: store.epoch }));
        if (frames && reset) write(named("reset", { latest }));
        if (frames && swept) write(named("gap", { since: last, until: oldest - 1, reason: "swept" }));
        // The cursor before any row: a drop now resumes from here (`Last-Event-ID`), not from what the URL said.
        write(`id: ${last}\n\n`);
        // Subscribed before the replay, so a row written while it runs is queued rather than falling between the two.
        const take = (item: EventRow | Pulse) => {
          if (queue.length >= LIVE_QUEUE_CAP) return end("slow");
          queue.push(item);
          wake();
        };
        // A model call under way (`thinking`, 1.2), in order with the rows — to a reader that asked for frames, and not
        // while it replays the past: a pulse is now or never.
        const unsubscribe = store.subscribe(filter, take, frames ? (pulse) => void (!replaying && take(pulse)) : undefined);
        // `write` catches the reader going away; contained besides, since a throw out of a timer ends the daemon.
        const beat = setInterval(contained(log, "could not keep an event stream alive", () => write(": keep-alive\n\n")), HEARTBEAT_MS);
        // Ended by a shutdown too, or the server's graceful stop would wait on it until the deadline (`OpenStreams`).
        const release = deps.streams?.add(() => end("shutdown")) ?? (() => {});
        stop = () => {
          clearInterval(beat);
          unsubscribe();
          release();
        };
        c.req.raw.signal.addEventListener("abort", contained(log, "could not end an event stream its reader left", () => end()));
      },
      /**
       * Every pull ends having enqueued something, or with the stream closed. Bun's server does not call again a pull
       * that returned empty-handed: a replay that found nothing, or a queue that held only rows the replay had sent,
       * left the stream waiting for its heartbeat to enqueue a keep-alive from outside — fifteen seconds in which a
       * short turn began and ended unseen (`nouride chat` drew no progress at all; `stream-live.test.ts`).
       */
      async pull() {
        if (closed) return;
        if (replaying) {
          const page = store.list({ ...filter, since: last, limit: REPLAY_PAGE });
          if (page.length > 0) write(page.map(frame).join(""));
          last = page.at(-1)?.seq ?? last;
          replayed += page.length;
          if (page.length < REPLAY_PAGE) replaying = false;
          else if (replayed >= REPLAY_CAP) {
            // The rest is there to page: say where, and go on from the newest row.
            const newest = store.latest();
            if (frames) write(named("gap", { since: last, until: newest, reason: "capped" }));
            last = newest;
            replaying = false;
            write(`id: ${last}\n\n`);
          }
          if (page.length > 0) return;
        }
        for (;;) {
          while (queue.length === 0 && !closed) await new Promise<void>((resolve) => (wake = resolve));
          if (closed) return;
          // What the replay already sent is in the queue too: only what is newer goes.
          let out = "";
          for (const item of queue.splice(0)) {
            if (!("seq" in item)) out += named("thinking", { turnId: item.turnId, text: item.text });
            else if (item.seq > last) {
              out += frame(item);
              last = item.seq;
            }
          }
          if (out) return write(out);
        }
      },
      cancel() {
        closed = true;
        stop();
        wake();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", "x-event-protocol": EVENT_PROTOCOL_VERSION },
    });
  });
}
