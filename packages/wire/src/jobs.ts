/**
 * Background jobs' watchdog and delegation (`routes/job-quiet.ts`, `routes/delegate.ts`): how long a job may be quiet,
 * and what a helper may do.
 */

export interface JobQuietPolicy {
  /** 0 is off. Notices then come at double the wait, and double again. */
  minutes: number;
  max: number;
  editable: boolean;
}

/** `[delegate] max_background`: how many helpers an agent may have in the background at once (0.7.15). */
export interface DelegatePolicy {
  /** The daemon's, as it holds now — an agent without its own follows it. 0 is off. */
  maxBackground: number;
  /** Nobody set it: it is what this machine has room for. Absent from an older daemon, where it was always set. */
  auto?: boolean;
  max: number;
  editable: boolean;
}
