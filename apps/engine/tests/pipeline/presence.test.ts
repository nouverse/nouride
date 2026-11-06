/**
 * A bot shows its agent (0.8.0): online while it works or waits for a person, idle, do not disturb asleep — only on a
 * connection that is one agent's own and can show one, and only when it changes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Gateway, GatewayPresence, GlobalConfig } from "@nouride/shared";
import { startPresence } from "@/boot/presence.ts";
import { presenceFor, type AgentActivity, type AgentStatus } from "@/modules/pipeline/agent-status.ts";

const timers: ReturnType<typeof setInterval>[] = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
});

describe("a bot's presence", () => {
  test("follows its agent: working and waiting online, idle idle, asleep do not disturb", () => {
    const shown = (["working", "waiting", "idle", "asleep"] as AgentActivity[]).map(presenceFor);
    expect(shown).toEqual(["online", "online", "idle", "dnd"]);
  });

  test("is set on an agent's own connection that can show one, and again only when it changes", () => {
    const set: [string, GatewayPresence][] = [];
    const bot = (id: string, shows: boolean) => ({ id, ...(shows ? { setPresence: (p: GatewayPresence) => void set.push([id, p]) } : {}) }) as unknown as Gateway;
    const gateways = new Map([
      ["discord:nova", bot("discord:nova", true)],
      ["discord:shared", bot("discord:shared", true)],
      ["telegram:nova", bot("telegram:nova", false)],
    ]);
    const config = { gateways: [{ id: "discord:nova", enabled: true, agent: "nova" }, { id: "discord:shared", enabled: true }, { id: "telegram:nova", enabled: true, agent: "nova" }] } as unknown as GlobalConfig;
    let activity: AgentActivity = "asleep";
    const status = () => ({ activity }) as AgentStatus;
    timers.push(startPresence({ gateways, config: () => config, status }));
    expect(set).toEqual([["discord:nova", "dnd"]]);
  });
});
