/**
 * `/status` for an agent a coding CLI answers (0.8.8).
 *
 * On Telegram, `/status` to Nix — Claude Code over ACP — said `Model: claude-sonnet-5-5`, `Provider: nougate-anthropic`,
 * `Messages: 101 in context` and `Tokens: 0 in (cache not reported) / 0 out`, after hours of work on the CLI's own
 * model. It says now what answers, that the CLI keeps its own context, and the tokens the CLI reported.
 */

import { describe, expect, test } from "bun:test";
import { sessionHooks } from "@/modules/hooks/builtins/session.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import type { CliAnswering } from "@/modules/pipeline/brain.ts";

const status = sessionHooks.find((hook) => hook.command === "/status")!;

function ctx(options: { external: boolean; answering?: CliAnswering; spent?: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null } }): HookContext {
  const asked: string[] = [];
  return {
    agent: {
      config: {
        id: "nix",
        displayName: "Nix",
        llm: { model: "claude-sonnet-5-5", provider: "nougate-anthropic" },
        ...(options.external ? { external: { cli: "claude-code" } } : {}),
      },
    },
    gatewayId: "telegram:nix",
    chatId: "555",
    envelope: { gateway: "telegram", gatewayId: "telegram:nix", chatId: "555", chatType: "dm" },
    deps: {
      registry: { status: () => "running" },
      sessions: { load: () => ({ id: "ses_1", startedAt: 0, messages: Array.from({ length: 101 }, () => ({ role: "user", content: "x" })) }) },
      modelOverrides: { get: () => undefined },
      daemon: { startedAt: Date.now(), version: "0.8.8" },
      sessionUsage: (_id: string, _since: number, onlyCli?: boolean) => (asked.push(`usage onlyCli=${onlyCli === true}`), { lastInputTokens: 0, ...(options.spent ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: null }) }),
      answering: (_agent: unknown, gatewayId: string, chatId: string) => (asked.push(`${gatewayId}|${chatId}`), options.answering ?? null),
    },
    asked,
  } as unknown as HookContext;
}

const reply = async (c: HookContext) => (await status.handler(c)).reply ?? "";

const CLAUDE: CliAnswering = {
  cli: "Claude Code",
  running: "@agentclientprotocol/claude-agent-acp 0.95.0",
  model: { name: "Opus 5.5", by: "cli" },
  context: { used: 85_200, size: 200_000 },
};

describe("/status of an agent a coding CLI answers", () => {
  test("says the CLI answers, on its model — never the pack's `[llm]` as if it answered", async () => {
    const c = ctx({ external: true, answering: CLAUDE, spent: { inputTokens: 1_200_000, outputTokens: 40_000, cachedInputTokens: 1_100_000 } });
    const text = await reply(c);
    expect(text).toContain("Answered by: Claude Code (@agentclientprotocol/claude-agent-acp 0.95.0)");
    expect(text).toContain("Model: Opus 5.5 (Claude Code's own, as its last session opened)");
    expect(text).not.toContain("Model: claude-sonnet-5-5");
    expect(text).not.toContain("Provider:");
    // The pack's model is named once, for what it does: answer a turn the CLI cannot.
    expect(text).toContain("Fallback: claude-sonnet-5-5 on nougate-anthropic, only for a turn Claude Code cannot answer");
    // This conversation's CLI session: asked by the connection and the chat the command came in — and its tokens the CLI's
    // alone, not a turn the pack's own model answered.
    expect((c as unknown as { asked: string[] }).asked).toEqual(["telegram:nix|555", "usage onlyCli=true"]);
  });

  test("says the CLI keeps its own context, and labels the transcript as the daemon's", async () => {
    const text = await reply(ctx({ external: true, answering: CLAUDE }));
    expect(text).toContain("Context: kept by Claude Code itself, 85.2k of 200.0k tokens at its last report");
    expect(text).toContain("Transcript: 101 messages, the daemon's record of this chat");
    expect(text).not.toContain("in context");
  });

  test("says the tokens the CLI reported, the cache among them, as outside the daily caps", async () => {
    const text = await reply(ctx({ external: true, answering: CLAUDE, spent: { inputTokens: 1_200_000, outputTokens: 40_000, cachedInputTokens: 1_100_000 } }));
    expect(text).toContain("Tokens: 1.20M in (1.10M cached) / 40.0k out, as Claude Code reported them, on its own account, outside the daily caps");
  });

  test("what is not known is said so: a CLI stopped, no model said, no context, no tokens reported", async () => {
    const text = await reply(ctx({ external: true, answering: { cli: "Codex", running: null, model: null, context: null } }));
    expect(text).toContain("Answered by: Codex, not running now; it starts at the next message");
    expect(text).toContain("Model: Codex chooses it");
    expect(text).toContain("Context: kept by Codex itself, not reported in this conversation since the daemon started");
    expect(text).toContain("Tokens: none reported by Codex in this conversation yet");
    expect(text).not.toContain("0 in");
  });

  test("a model the pack sets is said as the pack's", async () => {
    const text = await reply(ctx({ external: true, answering: { ...CLAUDE, model: { name: "claude-opus-5-5", by: "pack" } } }));
    expect(text).toContain("Model: claude-opus-5-5 (set in the pack)");
  });

  test("an agent its own model answers reads as it did", async () => {
    const text = await reply(ctx({ external: false, answering: CLAUDE, spent: { inputTokens: 1_000, outputTokens: 10, cachedInputTokens: null } }));
    expect(text).toContain("Model: claude-sonnet-5-5");
    expect(text).toContain("Provider: nougate-anthropic");
    expect(text).toContain("Messages: 101 in context");
    expect(text).toContain("Tokens: 1.0k in (cache not reported) / 10 out");
    expect(text).not.toContain("Answered by");
  });
});
