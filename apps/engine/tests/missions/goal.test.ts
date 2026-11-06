/**
 * `/goal`, as other harnesses name it (0.8.10): answered as `/mission`, every subcommand with it, and kept out of `/help`
 * and the platforms' menus, so they keep one name. It got "Unknown command" before — a dead end for a habit brought from
 * Codex CLI and the rest — and a model asked for "goal mode" in words is told it is a mission here.
 */

import { describe, expect, test } from "bun:test";
import { missionHooks } from "@/modules/hooks/builtins/mission.ts";
import { HookRegistry } from "@/modules/hooks/registry.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import { WHEN_TO_START } from "@/modules/tools/builtins/mission.ts";
import { missionsHarness } from "./harness.ts";

const goal = missionHooks.find((hook) => hook.command === "/goal")!;

describe("/goal", () => {
  test("answers as /mission: words start a mission for the agent addressed, and a subcommand acts on one", async () => {
    const h = await missionsHarness();
    const typed = async (text: string) =>
      (
        await goal.handler({
          deps: { missions: h.missions, isAdmin: () => false },
          args: text.split(/\s+/).slice(1),
          gatewayId: "telegram:nova",
          chatId: "8142",
          senderId: "8142",
          agent: { config: { id: "nova" } },
          envelope: { chatType: "dm", senderName: "Gading" },
        } as unknown as HookContext)
      ).reply;
    await typed("/goal write the quarterly report");
    const [started] = h.store.forChat("telegram:nova", "8142");
    expect(started).toMatchObject({ agentId: "nova", goal: "write the quarterly report", startedBy: "8142" });
    await typed(`/goal stop ${started!.id.slice(0, 10)}`);
    expect(h.store.get(started!.id)!.status).toBe("stopped");
  });

  test("one name in /help and the menus: /goal is the same hook as /mission, hidden", () => {
    const hooks = new HookRegistry({} as never);
    // What `/help` and a platform's command menu list: the hooks that are not hidden (`meta.ts`, `Pipeline.commands`).
    const listed = hooks.list().filter((hook) => !hook.hidden).map((hook) => hook.command);
    expect(hooks.has("/goal")).toBe(true);
    expect(listed).toContain("/mission");
    expect(listed).not.toContain("/goal");
    expect(goal.handler).toBe(missionHooks.find((hook) => hook.command === "/mission")!.handler);
  });

  test("the rule for when work is a mission's says it is what other harnesses call /goal", () => {
    expect(WHEN_TO_START).toEndWith("with their words in `said`. What other harnesses call `/goal` is a mission here.");
  });
});
