/**
 * A draft's one notice in its chat (`draft-notices.ts`). Every change of a draft sent the whole draft again, each a
 * notification on a person's phone; and four hours on, "is still waiting for you: not started" reminded them of a
 * draft they had meant to leave. Now the notice is rewritten where it stands, and a draft is reminded of by nothing.
 */

import { describe, expect, test } from "bun:test";
import type { MessageButton } from "@nouride/shared";
import { DraftNotices, type DraftChat } from "@/modules/missions/draft-notices.ts";
import { FOLLOW_UP_MS } from "@/modules/missions/limits.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import type { ToolContext } from "@nouride/shared";
import { missionsHarness } from "./harness.ts";

const TG = { gatewayId: "telegram:nix", chatId: "8142" };
const BUTTONS: MessageButton[] = [{ label: "Start it", data: "m:start" } as MessageButton, { label: "Drop it", data: "m:drop" } as MessageButton];

/** A chat that notes what it was asked: `rewrites` as a platform that can rewrite a message, `ids` as what a send posts. */
function chat(how: { rewrites?: boolean; ids?: string[]; buttons?: boolean } = {}) {
  const asked: string[] = [];
  const port: DraftChat = {
    ask: async (to, text, buttons) => {
      const carried = how.buttons !== false && buttons.length > 0;
      asked.push(`ask ${to.chatId}: ${text(carried)} [${buttons.map((one) => one.label).join(", ")}]`);
      return { ids: how.ids ?? ["m1"], buttons: carried };
    },
    rewrite: async (to, messageId, text, buttons) => {
      asked.push(`rewrite ${to.chatId} ${messageId}: ${text} [${buttons.map((one) => one.label).join(", ")}]`);
      return how.rewrites !== false;
    },
    say: async (to, text) => void asked.push(`say ${to.chatId}: ${text}`),
  };
  return { asked, notices: new DraftNotices(port) };
}

describe("a draft's notice", () => {
  test("is sent once, and a change rewrites that message where it stands, its buttons kept: nothing new in the chat", async () => {
    const { asked, notices } = chat();
    await notices.made("msn_1", TG, "📝 Draft msn_1 · nix: first", BUTTONS);
    expect(await notices.changed("msn_1", TG, "✎ Draft msn_1 changed: goal.\n\n📝 Draft msn_1 · nix: second", "✎ Draft msn_1 changed: goal.", BUTTONS)).toBe("rewritten");
    expect(await notices.changed("msn_1", TG, "✎ Draft msn_1 changed: checks (2).\n\n📝 Draft msn_1 · nix: third", "✎ Draft msn_1 changed: checks (2).", BUTTONS)).toBe("rewritten");
    expect(asked).toEqual([
      "ask 8142: 📝 Draft msn_1 · nix: first\nOr tap a button below. [Start it, Drop it]",
      "rewrite 8142 m1: ✎ Draft msn_1 changed: goal.\n\n📝 Draft msn_1 · nix: second\nOr tap a button below. [Start it, Drop it]",
      "rewrite 8142 m1: ✎ Draft msn_1 changed: checks (2).\n\n📝 Draft msn_1 · nix: third\nOr tap a button below. [Start it, Drop it]",
    ]);
  });

  test("where the chat cannot rewrite a message, a change is one line, never the whole draft again", async () => {
    const { asked, notices } = chat({ rewrites: false, buttons: false });
    await notices.made("msn_1", TG, "📝 Draft msn_1 · nix: first", BUTTONS);
    expect(await notices.changed("msn_1", TG, "✎ Draft msn_1 changed: goal.\n\n📝 Draft msn_1 · nix: second", "✎ Draft msn_1 changed: goal.", BUTTONS)).toBe("said");
    expect(asked.at(-1)).toBe("say 8142: ✎ Draft msn_1 changed: goal.");
    expect(asked.filter((one) => one.startsWith("say")).join("\n")).not.toContain("📝");
  });

  test("a notice that went out in parts, another chat, or one forgotten is not rewritten: the line is said", async () => {
    const parts = chat({ ids: ["m1", "m2"] });
    await parts.notices.made("msn_1", TG, "a long draft", BUTTONS);
    expect(await parts.notices.changed("msn_1", TG, "whole", "the line", BUTTONS)).toBe("said");
    expect(parts.asked.some((one) => one.startsWith("rewrite"))).toBe(false);

    const moved = chat();
    await moved.notices.made("msn_1", TG, "a draft", BUTTONS);
    expect(await moved.notices.changed("msn_1", { ...TG, chatId: "999" }, "whole", "the line", BUTTONS)).toBe("said");
    expect(moved.asked.at(-1)).toBe("say 999: the line");

    const forgotten = chat();
    await forgotten.notices.made("msn_1", TG, "a draft", BUTTONS);
    expect(forgotten.notices.size).toBe(1);
    forgotten.notices.forget("msn_1");
    expect(forgotten.notices.size).toBe(0);
    expect(await forgotten.notices.changed("msn_1", TG, "whole", "the line", BUTTONS)).toBe("said");
  });
});

describe("a draft, made and changed by its agent", () => {
  const person = () => ({ agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", senderId: "8142" }) as ToolContext;

  test("is told as its one notice: whole when it is made, and at a change whole with the one line beside it, for the chat to choose by", async () => {
    const told: { whole: string; line: string | null; buttons: string[] }[] = [];
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 }, tellDraft: async (_mission, whole, line, buttons) => void told.push({ whole, line, buttons: buttons.map((one) => one.label) }) });
    const tools = createMissionTools(h.missions, { audit: { record: () => {} } });
    await tools.chat.execute({ action: "start", title: "A test mission", goal: "Revise the RFC to the owner's answers", checks: ["test -s RFC.md"] }, person());
    await h.settle();
    const draft = h.store.open()[0]!;
    const id = draft.id.slice(0, 10);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ line: null, buttons: ["Start it", "Drop it"] });
    expect(told[0]!.whole).toStartWith(`📝 Draft ${id}`);

    const answer = await tools.chat.execute({ action: "edit", id: draft.id, checks: ["test -s RFC.md", "bun run check-paths"] }, person());
    expect(answer.content).toBe(`Draft ${id} changed: checks (2). Its notice in this chat says so now: it was rewritten where it stands, or one line was added under it.`);
    expect(told).toHaveLength(2);
    expect(told[1]!.whole).toStartWith(`✎ Draft ${id} changed: checks (2).\n\n📝 Draft ${id}`);
    expect(told[1]!.line).toBe(`✎ Draft ${id} changed: checks (2). Start it: /mission accept ${id} · drop it: /mission stop ${id}`);
    expect(told[1]!.buttons).toEqual(["Start it", "Drop it"]);
    // Not said a second way as well: the draft's notice is the one thing its chat is told.
    expect(h.told.filter((one) => one.text.includes("Draft"))).toEqual([]);
  });

  test("is reminded of by nothing, however long it waits; a result waiting for its accept still is, once", async () => {
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 } });
    const draft = await h.start("an idea", { startedBy: "nouride:system", byAgent: "nova", proposed: true });
    const before = h.told.length;
    for (const wait of [FOLLOW_UP_MS + 60_000, 3 * FOLLOW_UP_MS, 30 * 24 * 3_600_000]) {
      h.tick(wait);
      h.missions.tick();
    }
    expect(h.told.slice(before).filter((one) => one.mission === draft.id)).toEqual([]);
    expect(h.store.get(draft.id)).toMatchObject({ status: "waiting", waitKind: "accept", followedUpAt: null });

    // One that ran and waits for its person's accept is theirs to answer: named again once, as before.
    const ran = await h.start("a report", { agentId: "nox", accept: true });
    h.turn(ran, { worked: 1 }, () => h.missions.claim(ran.id, { kind: "done", summary: "Done.", report: "Done.", files: [] }));
    await h.settle();
    expect(h.store.get(ran.id)).toMatchObject({ status: "waiting", waitKind: "accept" });
    const told = h.told.length;
    h.tick(FOLLOW_UP_MS + 60_000);
    h.missions.tick();
    expect(h.told.slice(told).filter((one) => one.mission === ran.id && one.text.includes("still waiting for you"))).toHaveLength(1);
  });
});
