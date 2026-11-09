/**
 * The model's reasoning, turned into lines an operator can read as they arrive.
 *
 * The operator's complaint was that a turn showed `thinking (step 2)` and nothing else, so there was no
 * way to tell work from a hang. Nougate does send the model's reasoning — confirmed against the real
 * endpoint, on a `reasoning_content` field alongside `content` — and nothing was reading it.
 *
 * Buffered rather than forwarded token by token. Reasoning arrives in fragments of a few characters, and
 * one activity event per fragment would mean hundreds of events per turn through a ring buffer sized for
 * sixty, so the beginning of a thought would be evicted before the end of it arrived. Emitting at
 * sentence boundaries keeps each line meaningful and the volume survivable.
 *
 * Never part of the conversation. This text is not appended to the assistant message and is not sent back
 * to the model as its own previous words — it is a view for a human watching, and nothing else.
 */

import { clip } from "@nouride/shared";

/** Long enough for a thought, short enough for one terminal line. */
const MAX_LINE = 120;

export interface ReasoningStream {
  push(delta: string): void;
  /** Emit whatever is left. A final partial thought is still worth showing. */
  flush(): void;
}

export function createReasoningStream(emit: (line: string) => void): ReasoningStream {
  let buffer = "";

  const send = (text: string): void => {
    const line = text.trim();
    if (line !== "") emit(clip(line, MAX_LINE));
  };

  /**
   * Where to cut, or -1.
   *
   * A sentence end wins; failing that, once the buffer is over-long, the last space before the limit —
   * cutting mid-word makes the line harder to read than cutting late.
   */
  const cut = (): number => {
    const sentence = buffer.search(/[.!?](\s|$)/);
    if (sentence >= 0) return sentence + 1;
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return newline + 1;
    if (buffer.length > MAX_LINE) {
      const space = buffer.lastIndexOf(" ", MAX_LINE);
      return space > 0 ? space + 1 : MAX_LINE;
    }
    return -1;
  };

  return {
    push(delta: string): void {
      buffer += delta;
      for (;;) {
        const at = cut();
        if (at < 0) break;
        send(buffer.slice(0, at));
        buffer = buffer.slice(at);
      }
    },
    flush(): void {
      send(buffer);
      buffer = "";
    },
  };
}
