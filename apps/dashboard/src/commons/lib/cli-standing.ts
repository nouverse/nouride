/**
 * Where a coding CLI's version stands, in the words a person reads (0.8.24): on the Models page and the Brain tab of an
 * agent that works in it. The daemon decides the standing (`cliStanding`); this says it. Four, each with whether an
 * update is on offer: up to date, a newer version out, newer than this Nouride was tested with (it runs, with a warning),
 * older than it supports.
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

export function standingWords(name: string, view: CliVersionView): StandingWords {
  switch (view.standing) {
    case "current":
      return {
        badge: "up to date",
        tone: "success",
        says: view.untested
          ? `This is the newest ${name} this Nouride was tested with. A newer one is out, not tested with it yet.`
          : `This is the newest ${name} this Nouride was tested with.`,
        update: false,
      };
    case "update":
      return { badge: "update out", tone: "info", says: `A newer version of ${name} is out, one this Nouride was tested with.`, update: true };
    case "newer":
      return { badge: "newer than tested", tone: "warning", says: `This ${name} is newer than this Nouride was tested with. It runs, but it was not tried with it.`, update: false };
    case "older":
      return { badge: "too old", tone: "warning", says: `This ${name} is older than this Nouride supports. Update it.`, update: true };
  }
}
