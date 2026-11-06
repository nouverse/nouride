import type { ProbeResult } from "@/modules/setup/probe.ts";

/**
 * Everyday words several routes answer with, as a reply's `plain` (0.8.20): the dashboard shows it, the route's own
 * `error` and `note` under Details, and the CLI prints those as it always did. One sentence for one situation, said the
 * same way on every page it can happen on. `scripts/route-words.ts` reads them where a route imports them, and
 * `plain-replies.test.ts` holds them to the dashboard's wording rule like the rest.
 */

/** A part of Nouride this server does not run: a build without it, or a test's daemon. */
export const NOT_RUNNING = "This part of Nouride is not running on this server.";

/** No settings the dashboard may read or write: a daemon started without a settings file of its own. */
export const NO_SETTINGS = "The dashboard cannot read or change the settings on this server.";

/** The dashboard's own chat, off on this server: `[control] chat` is false. */
export const CHAT_OFF = "Chat on the dashboard is turned off on this server. Whoever runs the server can turn it on.";

/** A save the server turned down, for a reason in its own words (under Details). */
export const NOT_SAVED = "Nothing was saved. Check what you entered, and try again.";

/** A change that is not a form's (a removal, an action), turned down for a reason in the server's own words. */
export const NOT_CHANGED = "Nothing was changed. Reload the page, and try again.";

/** Refused because what the page showed changed on the server meanwhile. */
export const CHANGED_MEANWHILE = "This changed since the page showed it. Reload the page, and try again.";

/** A number field sent as something else. */
export const NOT_A_NUMBER = "That has to be a whole number. Nothing was saved.";

/** A request the dashboard makes whole, refused as incomplete: a page older or newer than the server. */
export const INCOMPLETE = "Nouride could not read that request. Reload the page and try again.";

/**
 * A provider's address tried without saving it (the setup wizard, Models): what went wrong, worded from why it failed,
 * and the models it listed when it worked. Its `error` stays, for the CLI and under Details.
 */
export function probed(probe: ProbeResult): ProbeResult & { plain?: string } {
  if (probe.ok) return { ok: true, models: probe.models };
  return { ...probe, plain: probePlain(probe) };
}

function probePlain(probe: ProbeResult): string {
  switch (probe.why) {
    case "invalid_url":
      return "That is not a web address. Check it, and try again.";
    case "unauthorized":
      return "The service turned that key down. Check the key, and try again.";
    case "not_found":
      return "Nothing at that address lists models. Check the address: it usually ends in /v1.";
    case "status":
      return `The service answered with an error (${probe.status ?? "no code"}). Try again in a moment.`;
    case "timeout":
      return "The service did not answer within 15 seconds. Check the address, and try again.";
    default:
      return "Nouride could not reach that address. Check it, and that this server can reach the internet.";
  }
}
