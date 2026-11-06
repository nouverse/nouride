/**
 * What a coding CLI is told that a model's turn always had (0.8.10): the time in the household's zone, first among its
 * first prompt's notes, and how to write where its words go — the platform's line, told once a session and again when it
 * changes. A CLI had the date from its own prompt and not the time, so "remind me at five" was worked out on a guess, and
 * it wrote tables on Telegram, which the gateway flattened into lines it did not choose.
 */

import { describe, expect, test } from "bun:test";
import { promptOf } from "@/modules/external-agents/prompt.ts";
import { situationOf, untold } from "@/modules/external-agents/situation.ts";
import type { TurnRequest } from "@/modules/llm/executor/types.ts";
import { CLOCK } from "./fixtures/clock.ts";

const TELEGRAM = "Formatting: this is usually read on a phone, so do not use tables.";
const req = (extra: Partial<TurnRequest> = {}) =>
  ({ toolset: { definitions: [], get: () => undefined }, gateway: "telegram", gatewayId: "telegram:coder", chatId: "555", chatType: "dm", ...extra }) as unknown as TurnRequest;
const takes = { image: false, audio: false };

describe("the time", () => {
  test("the turn's first prompt carries it first among its notes; a message steered in after carries none", async () => {
    const first = req({ reminders: ["[A note for this turn.]"] });
    const [opened] = await promptOf({ role: "user", content: "remind me at five" }, first, "", takes, undefined, CLOCK);
    expect(opened).toEqual({ type: "text", text: `[telegram · DM] remind me at five\n\n${CLOCK}\n[A note for this turn.]` });
    const [steered] = await promptOf({ role: "user", content: "and the totals" }, undefined, "", takes, undefined, CLOCK);
    expect(steered).toEqual({ type: "text", text: "and the totals" });
  });
});

describe("how to write here", () => {
  test("told on a session's first turn, not again while it stands, and again where it changes", () => {
    const telegram = situationOf(req({ formatting: TELEGRAM }));
    expect(untold(telegram, undefined)).toContain(TELEGRAM);
    expect(untold(telegram, telegram)).toBe("");
    // The dashboard's, a browser's, where the connection says nothing.
    const dashboard = situationOf(req({ gateway: "web" as never, gatewayId: "web:dashboard" }));
    expect(untold(dashboard, telegram)).toContain("Formatting: plain markdown, rendered in a browser");
    expect(untold(dashboard, telegram)).not.toContain(TELEGRAM);
  });

  test("a turn the daemon started is told it too, and nothing of who is here: nobody is speaking", () => {
    const job = situationOf(req({ formatting: TELEGRAM, systemEvent: true }));
    expect(untold(job, undefined)).toBe(`[Nouride: who is here, the other agents and how to write here, said again only when it changes]\n${TELEGRAM}\n\n`);
    // Where a person was told, what they were told stands.
    const person = situationOf(req({ formatting: TELEGRAM, senderName: "Mira" }));
    expect(situationOf(req({ formatting: TELEGRAM, systemEvent: true }), person)).toEqual(person);
  });
});
