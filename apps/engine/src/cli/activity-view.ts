/**
 * Drawing the activity feed, including how long the current step has been running.
 *
 * The operator's complaint: `thinking (step 2)` on screen and no way to tell work from a hang. Two
 * answers, and they are independent — the model's reasoning when the provider sends any, and a timer that
 * ticks either way. The timer matters more: it is the one that is always available, and "is it alive" is
 * the question being asked.
 *
 * Only the formatting lives here. Writing to a terminal, and deciding whether a line may be redrawn in
 * place, belongs to the caller that knows whether it owns a tty.
 */

/** A running step's age, in the shortest form that stays unambiguous. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}

/**
 * One activity line.
 *
 * `elapsedMs` is omitted for a step that has already finished with its own timing in the text — the
 * daemon puts the duration in `tool_done` lines, and a second number measuring the round trip to the
 * poller would contradict it.
 */
export function formatActivityLine(text: string, elapsedMs?: number): string {
  // Under a second is not worth a number: `· 0s` on a step that finished instantly reads like a stall.
  if (elapsedMs === undefined || elapsedMs < 1000) return text;
  return `${text} · ${formatElapsed(elapsedMs)}`;
}
