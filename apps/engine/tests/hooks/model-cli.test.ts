/**
 * `/model` for an agent a coding CLI answers: its own model is the CLI's, never its pack's `[llm]`.
 *
 * `/model` there read "Current model: `claude-sonnet-5-5`", the pack's, for an agent Claude Code answers on Opus, and
 * `/model reset` said "Back to" the same wrong name. A chat's choice now reaches the CLI's session, so what it goes
 * back to has to be said as what it is.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { agentHooks } from "@/modules/hooks/builtins/agent.ts";
import { ModelOverrides } from "@/modules/hooks/model-overrides.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import type { CliAnswering } from "@/modules/pipeline/brain.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";

const model = agentHooks.find((hook) => hook.command === "/model")!;
const KEY = { agentId: "nix", gatewayId: "telegram:nix", chatId: "555" };
const ID = sessionIdFor(KEY);

async function chat(options: { external?: boolean; answering?: CliAnswering | null } = {}) {
  const db = openDatabase(":memory:");
  await migrate(db);
  const overrides = new ModelOverrides(new SessionStore(db));
  const asked: string[] = [];
  const say = async (...args: string[]) =>
    (
      await model.handler({
        agent: { config: { id: "nix", displayName: "Nix", llm: { model: "claude-sonnet-5-5", provider: "p" }, ...(options.external === false ? {} : { external: { cli: "claude-code" } }) } },
        gatewayId: "telegram:nix",
        chatId: "555",
        args,
        envelope: { gateway: "telegram", gatewayId: "telegram:nix", chatId: "555", chatType: "dm" },
        deps: {
          sessions: { load: () => ({ id: ID }) },
          modelOverrides: overrides,
          ...(options.answering === undefined ? {} : { answering: (_agent: unknown, gatewayId: string, chatId: string) => (asked.push(`${gatewayId}|${chatId}`), options.answering) }),
        },
      } as unknown as HookContext)
    ).reply ?? "";
  return { say, overrides, asked };
}

const CLAUDE: CliAnswering = { cli: "Claude Code", running: null, model: { name: "Opus 5.5", by: "cli" }, context: null };

describe("/model of an agent a coding CLI answers", () => {
  test("names the CLI's model as its own, asked for this chat, and goes back to it", async () => {
    const { say, overrides, asked } = await chat({ answering: CLAUDE });
    expect(await say()).toBe("Current model: `Opus 5.5`");
    expect(asked).toEqual(["telegram:nix|555"]);
    expect(await say("sonnet")).toBe("Model for this chat is now `sonnet`.");
    expect(overrides.get(ID)).toBe("sonnet");
    expect(await say()).toBe("Current model: `sonnet`");
    expect(await say("reset")).toBe("Back to `Opus 5.5`.");
    expect(overrides.get(ID)).toBeUndefined();
  });

  test("where its CLI has not said which model it is on, says the CLI's own: never the pack's", async () => {
    const quiet = await chat({ answering: { cli: "Codex", running: null, model: null, context: null } });
    expect(await quiet.say()).toBe("Current model: `Codex's own`");
    expect(await quiet.say("default")).toBe("Back to `Codex's own`.");
    // Nothing can say what answers it: still not the pack's.
    const unknown = await chat({});
    expect(await unknown.say()).toBe("Current model: `its CLI's own`");
  });
});

describe("/model of an agent its own model answers", () => {
  test("names the pack's model, as before, and asks nothing of a CLI", async () => {
    const { say, asked } = await chat({ external: false, answering: CLAUDE });
    expect(await say()).toBe("Current model: `claude-sonnet-5-5`");
    expect(await say("reset")).toBe("Back to `claude-sonnet-5-5`.");
    expect(asked).toEqual([]);
  });
});
