/**
 * A skill's reason, as the chat reads it: cut at a word. 0.7.x cut it at 200 characters wherever that fell, so the
 * announcement read "…corrected the sort order twice before it was rig" right above `/drafts show`.
 */

import { describe, expect, test } from "bun:test";
import type { Notifier } from "@/commons/notify.ts";
import { announceAccepted } from "@/modules/reflection/notify.ts";
import { parseTriage } from "@/modules/reflection/synthesis.ts";
import type { SkillDraft } from "@/modules/reflection/types.ts";

const LONG = `${"you corrected the sort order twice before it was right ".repeat(4)}and then a third time`;

describe("a skill's reason, cut at a word", () => {
  test("triage keeps at most 200 characters and ends on a whole word", () => {
    const why = parseTriage(JSON.stringify({ decision: "update", target: "send-file-fallbacks", why: LONG }))?.why ?? "";
    expect(why.length).toBeLessThanOrEqual(200);
    expect(why).toEndWith("…");
    expect(LONG.split(" ")).toContain(why.slice(0, -1).split(" ").at(-1) ?? "");
  });

  test("the chat's announcement carries that reason, then the commands", async () => {
    const why = parseTriage(JSON.stringify({ decision: "update", target: "sort-orders", why: LONG }))?.why ?? "";
    const sent: string[] = [];
    const notifier = { toChat: async (_target: unknown, text: string) => (sent.push(text), true) } as unknown as Notifier;
    const draft = { name: "sort-orders", gatewayId: "telegram:bot", chatId: "1", triggerReason: why, carries: [] } as unknown as SkillDraft;
    await announceAccepted({ notifyChat: true, notifier }, draft);
    const lines = sent[0]?.split("\n") ?? [];
    expect(lines[1]).toBe(why);
    expect(lines[1]).toEndWith("…");
    expect(lines.at(-1)).toContain("/drafts show sort-orders");
  });
});
