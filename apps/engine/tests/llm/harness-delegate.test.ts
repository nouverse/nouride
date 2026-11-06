/**
 * What the harness tells an agent about `delegate` — and, where it may, about helpers in the background (0.7.15).
 *
 * A prompt is behaviour, so the wording that carries a rule is asserted directly. The rules here are the owner's
 * (2026-10-18): one helper in the background is the habit for a task that takes a while, so the agent stays free for
 * the person; two only for two independent pieces; not for a quick answer or a question the person is waiting on;
 * look at what is running first; the brief in English, with its context; and each result reported as it arrives.
 */

import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext } from "@nouride/shared";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";
import { createDelegateTool } from "@/modules/tools/builtins/delegate.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { fakeAgent } from "../helpers.ts";

function harness(toolNames: string[], backgroundHelpers?: number): string {
  return renderTools({
    ctx: { harness: { maxToolIterations: 8, approvalAvailable: true, ...(backgroundHelpers === undefined ? {} : { backgroundHelpers }) } },
    toolNames,
    gated: [],
    free: toolNames,
  } as never).join("\n");
}

describe("the harness on delegate", () => {
  test("in the foreground: parallel and waited for, a brief in English with its context, and no way around anything", () => {
    const text = harness(["delegate"]);
    expect(text).toContain("Several independent questions you need before you can answer (four hosts to check, three logs to read): `delegate` them in one call; up to four run at once and you wait.");
    expect(text).toContain("Give it a brief (`goal`, `context`, `constraints`, `deliverable`) written in English whatever language the person speaks");
    expect(text).toContain("put in `context` what it needs and cannot know: the paths and hosts, decisions already made, what was tried and what came of it");
    expect(text).toContain("It is not a way around anything");
  });

  test("in the background, the habit: one helper for a task that takes a while, so the agent stays free for the person", () => {
    const text = harness(["delegate"], 2);
    expect(text).toContain("**A helper in the background** (`background: true`) is ONE task, so you stay free for the person");
    expect(text).toContain("your turn ends at once, they can keep talking to you, and its result comes to you as a message when it finishes");
  });

  test("what it is for, and what it is not for", () => {
    const text = harness(["delegate"], 2);
    expect(text).toContain("Checking many links, hosts or files, research across them, a long build, a migration rehearsal.");
    expect(text).toContain("Decide before your first call, not halfway through.");
    expect(text).toContain("with nothing to decide midway: in the background");
    expect(text).toContain("Not for a quick answer, and not for a question the person is waiting on now: answer those yourself.");
  });

  test("two only for two independent pieces, with the limit; look first; each result reported as it arrives", () => {
    const text = harness(["delegate"], 2);
    expect(text).toContain("Two at once only for two independent pieces; at most 2 running.");
    expect(text).toContain("Before starting one, look at what is already running (the message you are answering lists any), so the same work is not started twice.");
    expect(text).toContain("Each result reaches you as that helper finishes: report each one when it arrives, in the person's language, and wait for the next.");
    expect(harness(["delegate"], 1)).toContain("you may have one running");
  });

  test("the foreground first, then the background — the habit is read where the decision is made", () => {
    const text = harness(["delegate"], 2);
    expect(text.indexOf("Several independent questions")).toBeLessThan(text.indexOf("**A helper in the background**"));
  });

  test("nothing about the background where the agent may not use it, and nothing at all without delegate", () => {
    expect(harness(["delegate"], 0)).not.toContain("background: true");
    expect(harness(["delegate"])).not.toContain("in the background");
    expect(harness(["read"], 2)).not.toContain("delegate");
  });
});

describe("the toolset an agent is offered", () => {
  const registry = new Map<string, Tool>([["delegate", createDelegateTool({ run: async () => ({}) as never, background: () => ({ refused: "off" }) })]]);
  const agent = fakeAgent({ config: { ...fakeAgent().config, tools: { enabled: ["delegate"], approvalRequired: [], blocked: [] } } });
  const properties = (limit: number | undefined) => {
    const toolset = resolveToolset(agent, registry, DEFAULT_CONFIG.security, limit === undefined ? {} : { backgroundHelpers: () => limit });
    const definition = toolset.definitions.find((d) => d.name === "delegate")!;
    return { toolset, names: Object.keys((definition.parameters as { properties: Record<string, unknown> }).properties) };
  };

  test("has `background` on delegate, and says its limit, only where the agent may run helpers that way", () => {
    expect(properties(2).names).toEqual(["tasks", "background", "tier"]);
    expect(properties(2).toolset.backgroundHelpers).toBe(2);
    expect(properties(0).names).toEqual(["tasks", "tier"]);
    expect(properties(0).toolset.backgroundHelpers).toBeUndefined();
    // A process with no jobs says nothing: no background.
    expect(properties(undefined).names).toEqual(["tasks", "tier"]);
  });

  test("where it may not, a call that sends `background` anyway runs in the foreground", async () => {
    let foreground = 0;
    const tools = new Map<string, Tool>([[
      "delegate",
      createDelegateTool({
        run: async () => {
          foreground += 1;
          return { agentId: "nouva", status: "success", summary: "ok", files: [], spills: [], metrics: { toolCalls: 0, steps: 1, ms: 1 } };
        },
        background: () => ({ refused: "off" }),
      }),
    ]]);
    const toolset = resolveToolset(agent, tools, DEFAULT_CONFIG.security, { backgroundHelpers: () => 0 });
    const result = await toolset.get("delegate")!.execute(
      { tasks: [{ goal: "g", context: "c", deliverable: "d" }], background: true },
      { agentId: "nouva", signal: new AbortController().signal } as ToolContext,
    );
    expect(foreground).toBe(1);
    expect(result.isError).toBe(false);
  });

  test("has `isolated` only in a mission's turn in a worktree of its own (0.8.1), and elsewhere ignores it", async () => {
    const isolate = async () => ({ refused: "no worktree here" });
    const tools = new Map<string, Tool>([[
      "delegate",
      createDelegateTool({
        run: async () => ({ agentId: "nouva", status: "success", summary: "ok", files: [], spills: [], metrics: { toolCalls: 0, steps: 1, ms: 1 } }),
        isolate,
      }),
    ]]);
    const names = (helperWorktrees: boolean) => {
      const definition = resolveToolset(agent, tools, DEFAULT_CONFIG.security, { helperWorktrees }).definitions.find((d) => d.name === "delegate")!;
      return Object.keys((definition.parameters as { properties: Record<string, unknown> }).properties);
    };
    expect(names(true)).toEqual(["tasks", "tier", "isolated"]);
    expect(names(false)).toEqual(["tasks", "tier"]);
    // Sent anyway where it is not offered: the helpers run in the mission's folder, never refused for it.
    const result = await resolveToolset(agent, tools, DEFAULT_CONFIG.security, {}).get("delegate")!.execute(
      { tasks: [{ goal: "g", context: "c", deliverable: "d" }], isolated: true },
      { agentId: "nouva", signal: new AbortController().signal } as ToolContext,
    );
    expect(result.isError).toBe(false);
  });
});
