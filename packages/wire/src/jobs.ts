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

/** `[cron] quiet_hours`: when what automations would say to a chat is kept, and sent as one message afterwards. */
export interface QuietHoursPolicy {
  /** `22:00`. Absent with `to`: no quiet hours are set. */
  from?: string;
  /** `07:00`. */
  to?: string;
  /** The zone the two times are in: the daemon's. */
  timeZone: string;
  editable: boolean;
  /**
   * What is kept now, of the automations whoever asked may see: how many things said, and when the hours end and
   * they are sent. Absent when nothing is kept.
   */
  kept?: { count: number; until: number };
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
