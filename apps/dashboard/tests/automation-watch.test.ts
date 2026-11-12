/**
 * An automation that watches, in words (`modules/automations/lib/watch.ts`): whether it is off because it told, the
 * quiet hours as a line says them and as two times are checked before they are sent, and what is said of the two marks
 * where it reports. The pages only draw what these say.
 */

import { describe, expect, test } from "bun:test";
import { atOnceHint, hoursProblem, hoursWords, marksWords, otherClock, toldAndOff } from "@/modules/automations/lib/watch";

describe("one set to tell once", () => {
  test("is off because it told only while it is off, and for that reason alone", () => {
    expect(toldAndOff({ enabled: false, disabledReason: "told" })).toBe(true);
    // Turned on again: it will tell once more, and is not off.
    expect(toldAndOff({ enabled: true, disabledReason: "told" })).toBe(false);
    expect(toldAndOff({ enabled: false, disabledReason: "5 runs failed in a row" })).toBe(false);
    // Paused by a person: no reason is kept.
    expect(toldAndOff({ enabled: false })).toBe(false);
  });
});

describe("the quiet hours, in words", () => {
  test("two times are said from the first to the second; none set, or half of them, is none", () => {
    expect(hoursWords({ from: "22:00", to: "07:00" })).toBe("22:00 to 07:00");
    expect(hoursWords({})).toBeNull();
    expect(hoursWords({ from: "22:00" })).toBeNull();
    expect(hoursWords({ to: "07:00" })).toBeNull();
  });
});

describe("two times, before they are sent", () => {
  test("both, and different, can be saved; both empty is none; half of them, or the same twice, is said", () => {
    expect(hoursProblem("22:00", "07:00")).toBeNull();
    expect(hoursProblem("", "")).toBeNull();
    expect(hoursProblem("22:00", "")).toBe("Set both times, or leave both empty for no quiet hours.");
    expect(hoursProblem("", "07:00")).toBe("Set both times, or leave both empty for no quiet hours.");
    expect(hoursProblem("22:00", "22:00")).toBe("The two times must be different.");
  });

  test("whose clock they are in is worth saying only where the server's reads another time than the browser's", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    expect(otherClock("Asia/Jakarta", now, "Asia/Jakarta")).toBe(false);
    // Two names, one time.
    expect(otherClock("Asia/Jakarta", now, "Asia/Bangkok")).toBe(false);
    expect(otherClock("Asia/Jakarta", now, "Europe/Berlin")).toBe(true);
    // A zone the browser does not know is said; a server that names none is not.
    expect(otherClock("Mars/Olympus", now, "Asia/Jakarta")).toBe(true);
    expect(otherClock(undefined, now, "Asia/Jakarta")).toBe(false);
  });
});

describe("the two marks where an automation reports", () => {
  test("what telling at once does is said as things stand: no hours set, no chat told, or the hours it overrides", () => {
    expect(atOnceHint(null, true)).toBe("Quiet hours are not set.");
    // With none set that is all there is to say, whoever it tells.
    expect(atOnceHint(null, false)).toBe("Quiet hours are not set.");
    expect(atOnceHint("22:00 to 07:00", true)).toBe("Quiet hours are 22:00 to 07:00. What it says then is sent at once, not kept for later.");
    // Only what goes to a chat is ever kept: one that tells none has nothing the switch could change.
    expect(atOnceHint("22:00 to 07:00", false)).toBe("It tells no chat, so nothing it says is kept for later.");
    // A server that has not said what the hours are: the line claims none.
    expect(atOnceHint(undefined, true)).toBe("What it says is sent at once, whatever the hour.");
  });

  test("each mark is a sentence on the card where it does something, and is not said where it does nothing", () => {
    expect(marksWords({ mode: "announce" })).toEqual([]);
    expect(marksWords({ mode: "announce", once: true })).toEqual(["It tells once, then turns itself off."]);
    expect(marksWords({ mode: "announce", atOnce: true })).toEqual(["It tells at once, even in quiet hours."]);
    expect(marksWords({ mode: "announce", once: true, atOnce: true })).toEqual(["It tells once, then turns itself off.", "It tells at once, even in quiet hours."]);
    // Sent to another app, it still turns itself off after the first; nothing sent there is ever kept for later.
    expect(marksWords({ mode: "webhook", once: true, atOnce: true })).toEqual(["It tells once, then turns itself off."]);
    expect(marksWords({ mode: "none", once: true, atOnce: true })).toEqual([]);
  });
});
