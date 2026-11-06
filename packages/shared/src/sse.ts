/**
 * Server-sent events parsing.
 *
 * The one place that has to know the framing: events are separated by a blank line, `data:` lines
 * within an event concatenate, and a chunk boundary can land anywhere — including mid-field.
 * Splitting on "\n" as chunks arrive would corrupt exactly the long tool-call arguments that are
 * hardest to reproduce, so the buffer is only consumed up to the last complete separator.
 *
 * It lives in `shared` rather than next to either caller because there are two, in packages that
 * cannot see each other: the streaming providers in `@nouride/llm`, and MCP's HTTP transports in
 * `@nouride/mcp`, which carry JSON-RPC over the same framing. A second copy would drift, and the
 * bug a drifted SSE parser produces — a truncated field, only under chunk boundaries — is one of
 * the more expensive ones to find twice.
 */

export interface SseEvent {
  event?: string;
  /** The `id:` field — where a reconnect resumes (`Last-Event-ID`). */
  id?: string;
  data: string;
}

/** `data: [DONE]` — OpenAI's terminator. Anthropic ends with a `message_stop` event. */
export const SSE_DONE = "[DONE]";

/** A stream that sent nothing for longer than its idle timeout. A type of its own, so a reader tells it from a drop. */
export class SseStalledError extends Error {
  override name = "SseStalledError";
  constructor(readonly idleTimeoutMs: number) {
    super(`stream stalled: no data for ${idleTimeoutMs}ms`);
  }
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  /**
   * Abort if no chunk arrives for this long.
   *
   * A generation that takes two minutes is normal; a stream that goes quiet forever is not, and
   * the two are indistinguishable without a watchdog. Without this, one stalled response holds a
   * conversation's queue open indefinitely.
   */
  idleTimeoutMs?: number,
): AsyncIterableIterator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  const source =
    idleTimeoutMs === undefined ? stream : withIdleTimeout(stream, idleTimeoutMs);

  for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // Normalize CRLF once here so the separator search below only has one form to
    // look for.
    buffer = buffer.replaceAll("\r\n", "\n");

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = parseEvent(raw);
      if (event) yield event;
    }
  }

  const tail = parseEvent(buffer);
  if (tail) yield tail;
}

/**
 * Wrap a stream so a gap longer than `idleTimeoutMs` throws instead of waiting forever.
 *
 * Implemented by racing each `read()` rather than with a single overall deadline, so a long but
 * healthy generation is never cut off.
 */
async function* withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SseStalledError(idleTimeoutMs)), idleTimeoutMs);
      });

      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (done) return;
        if (value) yield value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseEvent(raw: string): SseEvent | null {
  if (!raw.trim()) return null;

  let name: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "event") name = value;
    else if (field === "id") id = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { ...(name ? { event: name } : {}), ...(id === undefined ? {} : { id }), data: dataLines.join("\n") };
}

/** Parse an event's JSON payload, or `null` when it is the terminator or garbage. */
export function eventJson<T>(event: SseEvent): T | null {
  if (event.data === SSE_DONE) return null;
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}
