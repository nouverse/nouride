/**
 * An asleep agent (0.8.0) takes no work: a person's chat is told once an hour, and what the daemon sends it — a job's
 * end, an approval answered, a mission's next turn — waits for it to wake, then goes back in, in order.
 */

import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { Asleep } from "@/modules/pipeline/asleep.ts";

const nova = { id: "nova", displayName: "Nova" };
const at = (chatId: string) => ({ gatewayId: "telegram:nova", chatId });
const envelope = (id: string) => ({ id, gatewayId: "telegram:nova", chatId: "c1" }) as MessageEnvelope;

describe("an asleep agent", () => {
  test("tells a chat once an hour, and each chat on its own", () => {
    let now = 0;
    const asleep = new Asleep(() => now);
    expect(asleep.notice(nova, at("c1"))).toBe("Nova is asleep and takes no work until someone wakes it: /wake.");
    expect(asleep.notice(nova, at("c1"))).toBeNull();
    expect(asleep.notice(nova, at("c2"))).not.toBeNull();
    now += 60 * 60_000;
    expect(asleep.notice(nova, at("c1"))).not.toBeNull();
  });

  test("keeps what the daemon sent it, and puts it back in order when it wakes — the oldest dropped past fifty", () => {
    const asleep = new Asleep();
    const back: string[] = [];
    asleep.requeue = (one) => void back.push(one.id);
    for (let i = 0; i < 52; i += 1) asleep.hold("nova", envelope(`m${i}`));
    expect(back).toEqual([]);
    expect(asleep.release("nova")).toBe(50);
    expect(back[0]).toBe("m2~woke");
    expect(back.at(-1)).toBe("m51~woke");
    expect(asleep.release("nova")).toBe(0);
  });

  test("woken, its chats are told again the next time it sleeps", () => {
    const asleep = new Asleep(() => 0);
    asleep.notice(nova, at("c1"));
    asleep.release("nova");
    expect(asleep.notice(nova, at("c1"))).not.toBeNull();
  });
});
