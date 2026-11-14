/**
 * Where a coding CLI's version stands, in the words a person reads (0.8.24): on the Models page and the Brain tab of an
 * agent that works in it. The daemon decides the standing (`cliStanding`); this says it. Four, each with whether an
 * update is on offer: up to date, a newer version out, newer than this Nouride was tested with (it runs, with a warning),
 * older than it supports; and, up to date in all but name, a newer CLI out that nothing carries yet.
 */

import type { CliVersionView } from "@nouride/wire";

export interface StandingWords {
  /** A word or two, on a badge. */
  badge: string;
  tone: "success" | "info" | "warning";
  /** One sentence beside it. */
  says: string;
  /** Whether an update is on offer. */
  update: boolean;
}

/**
 * The newest out is offered whether or not this Nouride was tested with it: "not tested" is a word beside the offer,
 * never a reason to hold it back. Where the server read the CLI's own versions, the sentence names them.
 */
export function standingWords(name: string, view: CliVersionView): StandingWords {
  const untested = view.offerUntested ? " It was not tested with this Nouride yet." : "";
  const out = view.brings ? `${name} ${view.brings} is out.` : `A newer version of ${name} is out.`;
  switch (view.standing) {
    case "current":
      // Up to date only when nothing newer is out at all: a newer CLI no connector carries yet is said, in another colour.
      return view.ahead
        ? { badge: "newest you can get", tone: "info", says: `${name} ${view.ahead} is out, but it cannot be installed here yet. There is nothing to update.`, update: false }
        : { badge: "up to date", tone: "success", says: `This is the newest ${name}.`, update: false };
    case "update":
      return { badge: "update out", tone: "info", says: `${out}${untested}`, update: true };
    case "newer":
      return { badge: "newer than tested", tone: "warning", says: `This ${name} is newer than this Nouride was tested with. It runs, but it was not tried with it.`, update: false };
    case "older":
      return { badge: "too old", tone: "warning", says: `This ${name} is older than this Nouride supports. Update it.${untested}`, update: true };
  }
}
