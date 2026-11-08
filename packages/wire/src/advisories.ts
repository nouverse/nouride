/**
 * What the daemon's last boot said about how this install is set up (`boot/advisories.ts`), as `/advisories` lists it.
 */

/** One thing said, with every agent it was said about — six agents with one unscoped secret is one line. */
export interface AdvisoryLine {
  message: string;
  agents: string[];
  hint?: string;
  /** When it was first said, unchanged since — epoch ms. */
  since: number;
}
