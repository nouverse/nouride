/**
 * What one reply may spend (`routes/policy.ts`): how many tool round-trips, and how many seconds of wall clock.
 */

export interface ToolIterationsPolicy {
  maxToolIterations: number;
  /** The bounds travel with the value, so a form cannot offer a number the daemon will refuse. */
  min: number;
  max: number;
  editable: boolean;
}

export interface TurnSecondsPolicy {
  turnSeconds: number;
  /** The queue's own timeout. A turn may not outlast it, which is a lower ceiling than `max`. */
  queueSeconds: number;
  min: number;
  max: number;
  editable: boolean;
}
