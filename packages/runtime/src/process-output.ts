/**
 * Reading what a command writes — `runCommand`'s half that is about pipes rather than processes.
 */

/**
 * How long output is still read after the command itself exits.
 *
 * What it wrote before exiting is already in the pipe and arrives in well under this. Anything still
 * holding the pipe open past it is a process the command started and left running — `server &`, or
 * `cd dir && nohup server > log &`, where the `&` backgrounds the whole list and the subshell keeps
 * the pipe. Waiting for those to close it waited until the call timed out: found live, an agent
 * starting a preview server lost thirty seconds and the call reported a timeout for a server that
 * had started fine.
 */
const AFTER_EXIT_MS = 200;

/** Resolves once the command has exited and its last output has had time to arrive. */
export function settledAfter(exited: Promise<unknown>): Promise<void> {
  return exited.then(() => new Promise<void>((resolve) => setTimeout(resolve, AFTER_EXIT_MS)));
}

/**
 * The next chunk, or nothing once the command has settled. Past that the stream is handed to `drain`
 * rather than cancelled or dropped. Under Bun neither of those shows — it buffers an unread pipe, and
 * a writer to a closed one gets an error rather than SIGPIPE — so no test here can tell them apart;
 * drained anyway, because "keeps running and may keep writing" is the guarantee, and on a runtime that
 * does neither for us a closed pipe kills the process and an unread one blocks it at 64 KB.
 */
async function* untilSettled(stream: ReadableStream<Uint8Array>, settled: Promise<void>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  const stop = settled.then(() => null);
  for (;;) {
    const next = await Promise.race([reader.read(), stop]);
    if (next === null) {
      void drain(reader);
      return;
    }
    if (next.done) return;
    yield next.value;
  }
}

/** Read and discard whatever a process left running still writes, until it closes the pipe. */
async function drain(reader: { read(): Promise<{ done: boolean }> }): Promise<void> {
  try {
    while (!(await reader.read()).done);
  } catch {
    // The pipe went away with its process; there is nothing left to read.
  }
}

/**
 * Read a stream, keeping at most `maxBytes` of it.
 *
 * Buffering the whole stream and slicing afterwards would let a runaway command exhaust memory
 * before the cap is ever applied — the cap has to be enforced while reading, not after.
 *
 * Past the cap the stream is still **drained**, not cancelled. Cancelling closed the pipe, and a child
 * writing to a closed pipe gets SIGPIPE: a build whose log passed the cap died partway through and
 * reported a failure it never had. Draining costs a read per chunk; the timeout still bounds how long.
 *
 * Decoded as a stream, so a cap that lands inside a multi-byte character drops that character rather
 * than turning it into U+FFFD.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  settled: Promise<void>,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let truncated = false;

  for await (const value of untilSettled(stream, settled)) {
    if (total >= maxBytes) {
      if (value.byteLength > 0) truncated = true;
      continue;
    }
    const room = maxBytes - total;
    const kept = value.byteLength > room ? value.subarray(0, room) : value;
    if (kept !== value) truncated = true;
    total += kept.byteLength;
    text += decoder.decode(kept, { stream: true });
  }
  // Not flushed when truncated: what the decoder is still holding is the front half of a character
  // the cap cut through, and flushing it would emit exactly the replacement character this avoids.
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}

/** Pass a stream on as decoded text, holding nothing. See `SandboxOptions.onOutput`. */
export async function forward(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  settled: Promise<void>,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  for await (const value of untilSettled(stream, settled)) {
    const text = decoder.decode(value, { stream: true });
    if (text) onText(text);
  }
  const rest = decoder.decode();
  if (rest) onText(rest);
  return { text: "", truncated: false };
}
