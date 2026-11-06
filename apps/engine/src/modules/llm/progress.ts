/**
 * Proof that a long generation is producing something.
 *
 * Measured on a real turn: 205 seconds, of which 191 were spent waiting on the provider, and **two
 * stretches of 74 and 80 seconds passed with no activity event at all**. The elapsed timer kept ticking, so
 * the screen was not frozen — but ticking is all it showed. During those stretches the model was streaming
 * the contents of a 5KB file as tool-call arguments: tokens were arriving the whole time and nothing said
 * so.
 *
 * Throttled, because the alternative is one event per fragment. Reasoning and arguments arrive a few
 * characters at a time, and the activity ring holds sixty events per conversation — an unthrottled feed
 * would evict the tool calls someone actually wants to see in order to show the same line six hundred times.
 *
 * Bytes, not characters. `content.length` on a file with an emoji in it is not its size, and a size that is
 * quietly wrong is worse than no size — the rule against inventing numbers covers cosmetics too.
 */

import { formatBytes } from "@nouride/shared";

/** Long enough that the feed stays quiet, short enough that a wait never looks like a stall. */
const DEFAULT_INTERVAL_MS = 3000;

export interface GenerationProgress {
  /** Account for a streamed fragment. Emits at most once per interval. */
  add(fragment: string): void;
  /**
   * Set the running total directly, for a producer that already counts.
   *
   * The provider clients report tool-argument size as an absolute total rather than a delta, so that a
   * re-sent chunk cannot inflate it. Never decreases: a smaller number arriving would mean the count
   * restarted, and showing a size going backwards is worse than holding the last one.
   */
  setBytes(total: number): void;
  /** Total bytes seen, for a caller that wants the final figure. */
  bytes(): number;
}

export function createGenerationProgress(
  emit: (text: string) => void,
  options?: { intervalMs?: number; now?: () => number },
): GenerationProgress {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options?.now ?? Date.now;
  const encoder = new TextEncoder();

  let total = 0;
  // Starts at the first fragment rather than at construction: the wait before any token arrives belongs to
  // the provider's latency, and reporting "generating · 0 B" during it would be describing nothing.
  let lastEmit: number | null = null;

  return {
    add(fragment: string): void {
      if (fragment === "") return;
      total += encoder.encode(fragment).length;

      const at = now();
      if (lastEmit === null) {
        lastEmit = at;
        return;
      }
      if (at - lastEmit < intervalMs) return;

      lastEmit = at;
      emit(`generating · ${formatBytes(total)}`);
    },
    setBytes(value: number): void {
      if (value <= total) return;
      total = value;
      const at = now();
      if (lastEmit === null) {
        lastEmit = at;
        return;
      }
      if (at - lastEmit < intervalMs) return;
      lastEmit = at;
      emit(`generating · ${formatBytes(total)}`);
    },
    bytes(): number {
      return total;
    },
  };
}
