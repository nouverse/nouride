/**
 * A command that fails says so in the chat without its error: the error goes to the log.
 *
 * `/reload`, `/reset` and `/commands` sent `String(err)` back — a group saw the install's paths, a provider profile's
 * name, a platform's API body. And `/reset` said "config reloaded" beside "config reload failed".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { addLogSink, ConfigError } from "@nouride/shared";
import { agentHooks } from "@/modules/hooks/builtins/agent.ts";
import { metaHooks } from "@/modules/hooks/builtins/meta.ts";
import { sessionHooks } from "@/modules/hooks/builtins/session.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";

const DETAIL = 'agents/nouva/config.toml [llm] provider "homelab-secret-profile" is not in /srv/nouride/.nouride/config.toml';
const logged: string[] = [];
addLogSink((entry) => {
  if (entry.level === "warn") logged.push(JSON.stringify(entry));
});
afterEach(() => {
  logged.length = 0;
});

const hook = (list: { command: string }[], command: string) => list.find((h) => h.command === command) as unknown as { handler: (ctx: HookContext) => Promise<{ reply?: string }> };

function ctx(fail: unknown): HookContext {
  const noop = () => {};
  return {
    agent: { config: { id: "nouva" } },
    gatewayId: "telegram:main",
    chatId: "group-1",
    envelope: { gateway: "telegram", gatewayId: "telegram:main", chatId: "group-1", chatType: "group" },
    deps: {
      registry: {
        reload: async () => {
          throw fail;
        },
        isPaused: () => false,
        resume: noop,
      },
      sessions: { load: () => ({ id: "ses_1", messages: [] }), clear: noop },
      modelOverrides: { clear: noop },
      approvals: { expireAll: () => 0 },
      endConversation: async () => ({ expired: 0 }),
      resolveGateway: () => ({ platform: "telegram", syncCommands: async () => { throw fail; } }),
      listHooks: () => [],
    },
  } as unknown as HookContext;
}

describe("a command whose work failed", () => {
  test("/reload says it failed, and why in words a chat may see — the error itself is in the log", async () => {
    const { reply } = await hook(agentHooks, "/reload").handler(ctx(new ConfigError(DETAIL)));
    expect(reply).toBe("Reload failed. My configuration is invalid. Check the logs.");
    expect(logged.join("\n")).toContain("homelab-secret-profile");
  });

  test("/reset does not say the config reloaded when it did not", async () => {
    const { reply } = await hook(sessionHooks, "/reset").handler(ctx(new ConfigError(DETAIL)));
    expect(reply).toMatch(/^Reset\. Context (cleared \([^)]*\)|was already empty)\. The config reload failed\. My configuration is invalid/);
    expect(reply).not.toContain("config reloaded");
    expect(reply).not.toContain("/srv/nouride");
  });

  test("/commands keeps a platform's error body out of the chat", async () => {
    const body = new Error('400 Bad Request: {"ok":false,"description":"Bad Request: token 123:AAEe2e invalid"}');
    const { reply } = await hook(metaHooks, "/commands").handler(ctx(body));
    expect(reply).toBe("Command sync failed. Something went wrong on my side.");
    expect(logged.join("\n")).toContain("Bad Request");
  });
});
