/**
 * The claim table has a hard ceiling (P13).
 *
 * A claim collapses the copies of one message that every bot in a room is handed. It was swept only of claims older
 * than its TTL, so a burst inside one minute — a busy room, a flood — kept every one and grew past the cap; the
 * bound held only for traffic slower than the TTL.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { LoadedAgent, MessageEnvelope } from "@nouride/shared";
import { Admission } from "@/modules/pipeline/admission.ts";
import { CLAIM_MAX_ENTRIES } from "@/modules/pipeline/deps.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";

const message = (id: string): MessageEnvelope => ({ id, gateway: "telegram", gatewayId: "telegram:a", chatId: "room", chatType: "group" }) as MessageEnvelope;

describe("the claim table", () => {
  test("stays at its cap through a burst inside one TTL, and the newest claims hold", () => {
    const admission = new Admission({} as PipelineDeps);
    for (let i = 0; i < CLAIM_MAX_ENTRIES + 500; i += 1) expect(admission.claim(message(`m${i}`), "nouva")).toBe(true);
    expect(admission.claimEntries()).toBeLessThanOrEqual(CLAIM_MAX_ENTRIES);
    // The copies a claim is for arrive within milliseconds: the newest are what must still collapse.
    expect(admission.claim(message(`m${CLAIM_MAX_ENTRIES + 499}`), "nouva")).toBe(false);
    expect(admission.claim(message(`m${CLAIM_MAX_ENTRIES + 400}`), "nouva")).toBe(false);
  });
});

/**
 * The rate-limit table keeps a row only for a sender heard from in the last minute.
 *
 * It replaced a pipeline test that sent thirty senders and asserted at most thirty rows — true with the pruning
 * deleted. What prunes is age, so the clock has to move.
 */
describe("the rate-limit table", () => {
  afterEach(() => setSystemTime());

  const from = (senderId: string) => ({ ...message("m"), senderId }) as MessageEnvelope;

  test("a sender silent for a minute is dropped the next time anyone speaks", () => {
    const admission = new Admission({ config: { security: { rateLimit: { messagesPerMinute: 5 } } } } as unknown as PipelineDeps);
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    for (let i = 0; i < 30; i += 1) expect(admission.withinRateLimit(from(`sender-${i}`))).toBe(true);
    expect(admission.rateLimitEntries()).toBe(30);

    // Still inside the minute: every row is live.
    setSystemTime(new Date("2026-10-17T10:00:59Z"));
    admission.withinRateLimit(from("sender-0"));
    expect(admission.rateLimitEntries()).toBe(30);

    setSystemTime(new Date("2026-10-17T10:01:00.500Z"));
    admission.withinRateLimit(from("latecomer"));
    // sender-0 spoke at :59, so it is the only one of the thirty still inside the window.
    expect(admission.rateLimitEntries()).toBe(2);
  });
});

/**
 * The daemon's own events — a mission's turn, a job's end, an answered approval, a restart's resume — are all
 * `nouride:system` on one connection (0.8.1). Counted as a sender, a few at once shared one budget; checked against a
 * pack's allowlist, every one was refused: a mission stayed running for good, a job's report was lost.
 */
describe("the daemon's own events", () => {
  const system = { ...message("w"), senderId: "nouride:system" } as MessageEnvelope;

  test("are not counted against a rate limit; a person still is", () => {
    const admission = new Admission({ config: { security: { rateLimit: { messagesPerMinute: 1 } } } } as unknown as PipelineDeps);
    for (let i = 0; i < 5; i += 1) expect(admission.withinRateLimit(system)).toBe(true);
    const person = { ...message("p"), senderId: "555" } as MessageEnvelope;
    expect([admission.withinRateLimit(person), admission.withinRateLimit(person)]).toEqual([true, false]);
  });

  test("pass a pack's allowlist; a person not on it still does not", () => {
    const admission = new Admission({} as PipelineDeps);
    const agent = { config: { senderAllowlist: ["boss"] } } as unknown as LoadedAgent;
    expect(admission.senderAuthorized(agent, system)).toBe(true);
    expect(admission.senderAuthorized(agent, { ...message("p"), senderId: "stranger" } as MessageEnvelope)).toBe(false);
  });
});
