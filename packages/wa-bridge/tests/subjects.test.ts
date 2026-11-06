/**
 * A group's subject for the `message` event's `chatTitle` (0.7.24): asked of WhatsApp beside the message, never before
 * it — so the first message from a group goes up without one, and the next carries it. Asked again a day later; a
 * rename WhatsApp announces is taken at once; a failed ask is not repeated on every message.
 */

import { describe, expect, test } from "bun:test";
import { GroupSubjects } from "../src/subjects.ts";

/** Lets the ask, which runs beside the message, settle — a few turns of the microtask queue, no timer. */
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("a group's subject", () => {
  test("not waited for: the first message has none, the next has it, and it is asked once", async () => {
    let now = 0;
    const subjects = new GroupSubjects(() => now);
    const asked: string[] = [];
    const fetch = async (jid: string) => (asked.push(jid), { subject: "Keluarga Besar" });

    expect(subjects.of("1203@g.us", fetch)).toBeUndefined();
    await tick();
    expect(subjects.of("1203@g.us", fetch)).toBe("Keluarga Besar");
    now += 60 * 60_000;
    expect(subjects.of("1203@g.us", fetch)).toBe("Keluarga Besar");
    expect(asked).toEqual(["1203@g.us"]);

    now += 24 * 60 * 60_000;
    subjects.of("1203@g.us", async (jid) => (asked.push(jid), { subject: "Arisan" }));
    await tick();
    expect(subjects.of("1203@g.us", fetch)).toBe("Arisan");
  });

  test("a failed ask is not repeated per message; a rename WhatsApp announces is taken at once", async () => {
    let now = 0;
    const subjects = new GroupSubjects(() => now);
    let asks = 0;
    const failing = async () => {
      asks++;
      throw new Error("forbidden");
    };
    subjects.of("1203@g.us", failing);
    await tick();
    subjects.of("1203@g.us", failing);
    expect(asks).toBe(1);

    subjects.note("1203@g.us", "Keluarga");
    expect(subjects.of("1203@g.us", failing)).toBe("Keluarga");
  });
});
