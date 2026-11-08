/**
 * `/effort … lock` (0.8.17): a level made the agent's own, `[llm] effort` in its pack, for every chat and every mission.
 * `/effort <level>` is one conversation's, and a mission runs in a conversation of its own: a person set `max` in their
 * chat and the mission they started ran at the pack's level. The write is the Model tab's, and an admin's.
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
const ID = sessionIdFor({ agentId: "nix", gatewayId: "telegram:nix", chatId: "555" });

type Written = { agentId: string; effort: string; actor: string };

async function chat(options: { admin?: boolean; port?: boolean; fails?: string; external?: boolean; offered?: string[] } = {}) {
  // A database of its own, as the daemon's: the chat's level is kept on its conversation's row (076).
  const db = openDatabase(":memory:");
  await migrate(db);
  const overrides = new ModelOverrides(new SessionStore(db));
  const written: Written[] = [];
  const asked: unknown[] = [];
  const port = {
    mayChange: (envelope: unknown) => {
      asked.push(envelope);
      return options.admin ?? true;
    },
    set: async (agentId: string, level: string, actor: string) => {
      written.push({ agentId, effort: level, actor });
      return options.fails ? { ok: false as const, error: options.fails } : { ok: true as const };
    },
  };
  const say = async (...args: string[]) =>
    (
      await effort.handler({
        agent: { config: { id: "nix", displayName: "Nix", llm: { model: "m", provider: "p" }, ...(options.external ? { external: { cli: "claude-code" } } : {}) } },
        gatewayId: "telegram:nix",
        chatId: "555",
        senderId: "42",
        args,
        envelope: { gateway: "telegram", gatewayId: "telegram:nix", chatId: "555", senderId: "42", chatType: "dm" },
        deps: {
          sessions: { load: () => ({ id: ID }) },
          modelOverrides: overrides,
          ...(options.port === false ? {} : { agentEffort: port }),
          ...(options.offered ? { cliEfforts: () => options.offered! } : {}),
        },
      } as unknown as HookContext)
    ).reply ?? "";
  return { say, overrides, written, asked };
}

describe("/effort … lock", () => {
  test("an admin's `/effort max lock` writes it as the agent's own, by who said it, and this chat follows it", async () => {
    const { say, overrides, written, asked } = await chat();
    await say("high");
    expect(await say("max", "LOCK")).toBe("`max` is now Nix's own effort, for every chat and mission, and kept across a restart. `/effort <level>` still sets one chat's.");
    expect(written).toEqual([{ agentId: "nix", effort: "max", actor: "telegram:nix:42" }]);
    expect(asked).toHaveLength(1);
    // This chat's `high` would hide the agent's new level in the one chat that set it.
    expect(overrides.effortOf(ID)).toBeUndefined();
  });

  test("`/effort lock` locks the level this chat set; with none it says so and writes nothing", async () => {
    const set = await chat();
    await set.say("xhigh");
    expect(await set.say("lock")).toContain("`xhigh` is now Nix's own effort");
    expect(set.written.map((w) => w.effort)).toEqual(["xhigh"]);
    const none = await chat();
    expect(await none.say("lock")).toBe("This chat has no level of its own to lock: `/effort <level> lock` sets the agent's.");
    expect(none.written).toEqual([]);
  });

  test("`/effort unlock` and `/effort default lock` take the agent's own away", async () => {
    const { say, written } = await chat();
    const away = "Nix has no effort of its own now: every chat and mission follows the install's `[llm.defaults] effort`, else its provider's default.";
    expect(await say("unlock")).toBe(away);
    expect(await say("default", "lock")).toBe(away);
    expect(written.map((w) => w.effort)).toEqual(["default", "default"]);
    expect(await (await chat({ external: true })).say("unlock")).toContain("else the CLI's own.");
  });

  test("a sender who is not an admin is refused, and nothing is written; this chat's level stays", async () => {
    const { say, overrides, written } = await chat({ admin: false });
    await say("high");
    expect(await say("max", "lock")).toBe("Only an admin can lock an effort: it is written in the agent's config, for every chat. `/effort <level>` sets this chat's.");
    expect(await say("unlock")).toContain("Only an admin");
    expect(written).toEqual([]);
    expect(overrides.effortOf(ID)).toBe("high");
  });

  test("a level that is not one, or one its CLI does not offer, is refused before the admin is asked or anything written", async () => {
    const { say, written, asked } = await chat({ external: true, offered: ["low", "high"] });
    expect(await say("loud", "lock")).toBe("`loud` is not a level: low, medium, high, xhigh, max.");
    expect(await say("max", "lock")).toBe("Its CLI does not offer `max` for the model it is on. It offers: low, high.");
    expect(written).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a write that fails says why, and this chat keeps its own level", async () => {
    const { say, overrides } = await chat({ fails: "the agent's config.toml could not be written" });
    await say("high");
    expect(await say("max", "lock")).toBe("Not locked: the agent's config.toml could not be written");
    expect(overrides.effortOf(ID)).toBe("high");
  });

  test("other words after a level, or after lock and unlock, get the usage and write nothing", async () => {
    const { say, overrides, written } = await chat();
    for (const words of [["max", "forever"], ["lock", "max"], ["unlock", "now"], ["max", "lock", "please"]]) {
      expect(await say(...words)).toStartWith("`/effort <level>` sets this chat's · `/effort <level> lock` the agent's own");
    }
    expect(written).toEqual([]);
    expect(overrides.effortOf(ID)).toBeUndefined();
  });

  test("a daemon that writes no pack from a chat says where the agent's own is set", async () => {
    const { say } = await chat({ port: false });
    expect(await say("max", "lock")).toBe("An agent's own effort is not set from a chat on this daemon: its Model tab sets it.");
  });
});
