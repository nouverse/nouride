/**
 * `/effort` (0.8.16): how long a coding CLI thinks, for one chat. Claude Code and Codex say which levels they offer for
 * the model they are on, so a level the CLI would not take is refused here, with the ones it offers. An agent its own
 * model answers (0.8.17) takes any level: it is sent with each request, and a model that refuses it is asked again
 * without, which the chat is told with the answer and `/effort` says after.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { agentHooks } from "@/modules/hooks/builtins/agent.ts";
import { ModelOverrides } from "@/modules/hooks/model-overrides.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";

const effort = agentHooks.find((hook) => hook.command === "/effort")!;
const KEY = { agentId: "nix", gatewayId: "telegram:nix", chatId: "555" };
const ID = sessionIdFor(KEY);

async function chat(options: { external?: boolean; own?: string; offered?: string[] } = {}) {
  // A database of its own, as the daemon's: the chat's level is kept on its conversation's row (076).
  const db = openDatabase(":memory:");
  await migrate(db);
  const overrides = new ModelOverrides(new SessionStore(db));
  const say = async (...args: string[]) =>
    (
      await effort.handler({
        agent: { config: { id: "nix", displayName: "Nix", llm: { model: "m", provider: "p", ...(options.own ? { effort: options.own } : {}) }, ...(options.external === false ? {} : { external: { cli: "claude-code" } }) } },
        gatewayId: "telegram:nix",
        chatId: "555",
        args,
        envelope: { gateway: "telegram", gatewayId: "telegram:nix", chatId: "555", chatType: "dm" },
        deps: {
          sessions: { load: () => ({ id: ID }) },
          modelOverrides: overrides,
          ...(options.offered ? { cliEfforts: () => options.offered! } : {}),
        },
      } as unknown as HookContext)
    ).reply ?? "";
  return { say, overrides };
}

describe("/effort", () => {
  test("sets this chat's level among the ones the CLI offers, and refuses one it does not, naming them", async () => {
    const { say, overrides } = await chat({ offered: ["low", "medium", "high"] });
    expect(await say("high")).toBe("Effort for this chat is now `high`, from the next message.");
    expect(overrides.effortOf(ID)).toBe("high");
    expect(await say("max")).toBe("Its CLI does not offer `max` for the model it is on. It offers: low, medium, high.");
    expect(await say("loud")).toBe("`loud` is not a level: low, medium, high, xhigh, max, or default.");
    expect(overrides.effortOf(ID)).toBe("high");
  });

  test("says what it is now and where it came from; default puts the agent's, else the CLI's own, back", async () => {
    const pack = await chat({ own: "medium", offered: ["low", "medium", "high"] });
    expect(await pack.say()).toBe("Effort for this chat: `medium`, the agent's. It offers: low, medium, high.");
    await pack.say("HIGH");
    expect(await pack.say()).toBe("Effort for this chat: `high`, set in this chat. It offers: low, medium, high.");
    expect(await pack.say("default")).toBe("Back to the agent's effort, `medium`.");
    expect(pack.overrides.effortOf(ID)).toBeUndefined();
    const bare = await chat();
    expect(await bare.say()).toBe("Effort for this chat: the CLI's own. Its CLI says which levels it offers once a session has opened.");
    // Before its first session nothing is known of the levels: a real one is taken, and the CLI says if it is not offered.
    expect(await bare.say("xhigh")).toBe("Effort for this chat is now `xhigh`, from the next message.");
    expect(await bare.say("reset")).toBe("Back to the CLI's own effort.");
  });

  test("an agent its own model answers takes any level, says what it is sent, and default goes back to the agent's", async () => {
    const { say, overrides } = await chat({ external: false, own: "low" });
    expect(await say()).toBe("Effort for this chat: `low`, the agent's.");
    expect(await say("max")).toBe("Effort for this chat is now `max`, from the next message.");
    expect(overrides.effortOf(ID)).toBe("max");
    expect(await say()).toBe("Effort for this chat: `max`, set in this chat.");
    expect(await say("loud")).toBe("`loud` is not a level: low, medium, high, xhigh, max, or default.");
    expect(await say("default")).toBe("Back to the agent's effort, `low`.");
    expect(overrides.effortOf(ID)).toBeUndefined();
    const bare = await chat({ external: false });
    expect(await bare.say()).toBe("Effort for this chat: its provider's default.");
    await bare.say("high");
    expect(await bare.say("reset")).toBe("Back to its provider's default.");
  });

  test("a level its model refused is said, until a level or a model is chosen again", async () => {
    const { say, overrides } = await chat({ external: false });
    await say("high");
    expect(overrides.refused(ID, { effort: "high", model: "gemini-flash" })).toBe(true);
    // Told once, with the answer that met it: the same refusal again is not news.
    expect(overrides.refused(ID, { effort: "high", model: "gemini-flash" })).toBe(false);
    expect(await say()).toBe("Effort for this chat: `high`, set in this chat. `gemini-flash` refused it, so it is sent none.");
    await say("medium");
    expect(await say()).toBe("Effort for this chat: `medium`, set in this chat.");
    expect(overrides.refused(ID, { effort: "medium", model: "gemini-flash" })).toBe(true);
    overrides.set(KEY, "other-model");
    expect(await say()).toBe("Effort for this chat: `medium`, set in this chat.");
  });
});
