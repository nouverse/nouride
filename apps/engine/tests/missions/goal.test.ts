/**
 * `/goal`, as other harnesses name it: answered as `/mission`, every subcommand with it, and kept out of `/help` and the
 * platforms' menus, so they keep one name. `/mission <goal>` starts nothing itself: the agent drafts one, which runs once
 * the person starts it. It got "Unknown command" before — a dead end for a habit brought from
 * Codex CLI and the rest — and a model asked for "goal mode" in words is told it is a mission here.
 */

import { describe, expect, test } from "bun:test";
import { draftAsked, missionHooks } from "@/modules/hooks/builtins/mission.ts";
import { HookRegistry } from "@/modules/hooks/registry.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import { createMissionTools, WHEN_TO_START } from "@/modules/tools/builtins/mission.ts";
import { missionsHarness } from "./harness.ts";

const goal = missionHooks.find((hook) => hook.command === "/goal")!;

const mission = missionHooks.find((hook) => hook.command === "/mission")!;

describe("/mission <goal>, and /goal as its other name", () => {
  for (const [name, hook] of [["/mission", mission], ["/goal", goal]] as const) {
    test(`${name} <goal> starts no mission: it hands the agent a turn that drafts one from the goal; a subcommand still acts`, async () => {
      const h = await missionsHarness();
      const typed = async (text: string) =>
        await hook.handler({
          deps: { missions: h.missions, isAdmin: () => false },
          args: text.split(/\s+/).slice(1),
          gatewayId: "telegram:nova",
          chatId: "8142",
          senderId: "8142",
          agent: { config: { id: "nova" } },
          envelope: { chatType: "dm", senderName: "Gading" },
        } as unknown as HookContext);
      const asked = await typed(`${name} write the quarterly report`);
      expect(asked).toEqual({ handled: false, prompt: draftAsked("write the quarterly report") });
      expect(h.store.forChat("telegram:nova", "8142")).toEqual([]);
      // A draft the agent makes is stopped by the same subcommands.
      const made = h.missions.start({ agentId: "nova", goal: "the report", startedBy: "8142", gatewayId: "telegram:nova", chatId: "8142", proposed: true });
      if ("refused" in made) throw new Error(made.refused);
      const drafted = made.mission;
      await typed(`${name} stop ${drafted!.id.slice(0, 10)}`);
      expect(h.store.get(drafted!.id)!.status).toBe("stopped");
    });
  }

  test("the turn is asked for a draft from the goal as written: read first, brief and checks, ask when unclear, runs once started", () => {
    const words = draftAsked("move the metrics to Postgres");
    for (const rule of ['"move the metrics to Postgres"', "Draft a mission", "action \"start\"", "read what you need first", "brief and checks", "If the goal is unclear, ask in this chat first", "only when the person starts it"]) {
      expect(words).toContain(rule);
    }
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

  test("the rule says where a draft waits, in the word a person has for it: asked to put something in the backlog, an agent drafts", () => {
    // "Put it in the backlog" was answered with a note to self: the board's first column was named nowhere in the rule.
    expect(WHEN_TO_START).toContain("A draft waits in the person's Backlog: asked to put something in the backlog, draft it.");
    expect(createMissionTools({} as never).chat.definition.description).toContain("asked to put something in the backlog, draft it.");
  });

  test("the rule for when work is a mission's says it is what other harnesses call /goal", () => {
    expect(WHEN_TO_START).toEndWith("What other harnesses call `/goal` is a mission here.");
    // And never that it may start one at once.
    expect(WHEN_TO_START).not.toContain("`said`");
    expect(WHEN_TO_START).not.toMatch(/at once/);
  });
});
