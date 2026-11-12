/**
 * An automation that watches, in words: whether it is off because it told, the quiet hours, and what is said of the
 * two marks where an automation reports. Pure (`tests/automation-watch.test.ts`); the pages only draw what this says.
 *
 * The quiet hours are one setting for every automation on the server: two times of the day, in the server's own clock,
 * between which what automations would say to a chat is kept, and sent as one message when they end.
 */

import type { AutomationSummary, QuietHoursPolicy } from "@nouride/wire";

/**
 * Whether an automation is off because it told: one set to tell once, which the server turns off after the first run
 * on its own time that told its chat something, with this word as why. Nothing failed, and nobody paused it.
 */
export const toldAndOff = (automation: Pick<AutomationSummary, "enabled" | "disabledReason">): boolean => !automation.enabled && automation.disabledReason === "told";

/** The hours as a line says them, "22:00 to 07:00"; null where none are set. */
export function hoursWords(policy: Pick<QuietHoursPolicy, "from" | "to">): string | null {
  return policy.from && policy.to ? `${policy.from} to ${policy.to}` : null;
}

/**
 * What the quiet hours keep now, as the line says it after the hours: "3 messages kept until 07:00". Null where nothing
 * is kept, or no hours are set to say an end of. The end is the hours' own, in the clock the line already reads in.
 */
export function keptWords(policy: Pick<QuietHoursPolicy, "to" | "kept">): string | null {
  const count = policy.kept?.count ?? 0;
  if (count < 1 || !policy.to) return null;
  return `${count} ${count === 1 ? "message" : "messages"} kept until ${policy.to}`;
}

/**
 * What two times, as typed, lack before they can be saved; null when they can. Both empty is no quiet hours, which
 * can. Held here first, so nothing the server would refuse is sent: half of them, or a span of no length.
 */
export function hoursProblem(from: string, to: string): string | null {
  if (!from && !to) return null;
  if (!from || !to) return "Set both times, or leave both empty for no quiet hours.";
  return from === to ? "The two times must be different." : null;
}

/**
 * Whether the server's clock reads another time than this browser's now: only then does a line of hours need to say
 * whose clock they are in. By what the two clocks read, not by the zones' names: two names can be one time.
 * `here`: the browser's own zone, for a test; absent, wherever the browser is.
 */
export function otherClock(server: string | undefined, now = new Date(), here?: string): boolean {
  if (!server) return false;
  const reads = (timeZone?: string) => new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).format(now);
  try {
    return reads(server) !== reads(here);
  } catch {
    // A zone this browser does not know: said, rather than taken for the browser's own.
    return true;
  }
}

type Delivery = AutomationSummary["delivery"];

/** The line under "Tell me once, then turn off": what the switch does. */
export const ONCE_HINT = "After the first run that tells you something, it turns itself off. A run you start by hand does not count.";

/**
 * The line under "Tell me at once, even in quiet hours": what the switch does for this automation as things stand.
 * `hours`: the quiet hours in words, null where none are set, undefined where the server has not said. `tellsChat`:
 * whether what it says goes to a chat, which is all the quiet hours ever keep.
 */
export function atOnceHint(hours: string | null | undefined, tellsChat: boolean): string {
  if (hours === null) return "Quiet hours are not set.";
  if (!tellsChat) return "It tells no chat, so nothing it says is kept for later.";
  return hours ? `Quiet hours are ${hours}. What it says then is sent at once, not kept for later.` : "What it says is sent at once, whatever the hour.";
}

/**
 * The marks where an automation reports, each as a sentence, for whoever reads the page without opening its fields.
 * A mark that does nothing as the automation stands is not said: telling once where it tells nobody, telling at once
 * where it tells no chat.
 */
export function marksWords(delivery: Pick<Delivery, "mode" | "once" | "atOnce">): string[] {
  return [...(delivery.once && delivery.mode !== "none" ? ["It tells once, then turns itself off."] : []), ...(delivery.atOnce && delivery.mode === "announce" ? ["It tells at once, even in quiet hours."] : [])];
}
