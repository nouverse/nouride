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

function ctx(options: { external: boolean; answering?: CliAnswering; spent?: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null }; picked?: string }): HookContext {
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
      modelOverrides: { get: () => options.picked },
      cliModels: () => [{ value: "default", name: "Default (recommended)" }, { value: "fable", name: "Fable 5.2" }],
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
  test("names the CLI's own version, and its connector's as what carries it", async () => {
    // The connector's version alone read as Claude Code's: 0.100.0 "up to date" over a Claude Code two models behind.
    const text = await reply(ctx({ external: true, answering: { ...CLAUDE, version: "2.1.323", running: "@agentclientprotocol/claude-agent-acp 0.107.0" } }));
    expect(text).toContain("Answered by: Claude Code 2.1.323 (in @agentclientprotocol/claude-agent-acp 0.107.0)");
    // Stopped, its own version is still said: it is read from the files installed, not from a running CLI.
    expect(await reply(ctx({ external: true, answering: { ...CLAUDE, version: "2.1.323", running: null } }))).toContain("Answered by: Claude Code 2.1.323, not running now");
  });

  test("an agent with several accounts is told which one it is on now", async () => {
    expect(await reply(ctx({ external: true, answering: { ...CLAUDE, account: "work" } }))).toContain("Account: work, of the ones it moves between when one reaches its limit");
    expect(await reply(ctx({ external: true, answering: CLAUDE }))).not.toContain("Account:");
  });

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

  test("a chat put on another model with /model says that one, by what it stands for, and where /model default goes back", async () => {
    // Seen on a box: after `/model fable` the chat answered on Fable 5.2 and `/status` there still said Sonnet 5.5.
    const text = await reply(ctx({ external: true, answering: CLAUDE, picked: "fable" }));
    expect(text).toContain("Model: `fable` (Fable 5.2), picked in this chat. `/model default` goes back to Opus 5.5\n");
    expect(text).not.toContain("as its last session opened");
    // A name the CLI has not listed is said as written; with no model known, the way back is the CLI's own.
    expect(await reply(ctx({ external: true, answering: { ...CLAUDE, model: null }, picked: "o9" }))).toContain("Model: `o9`, picked in this chat. `/model default` goes back to Claude Code's own\n");
    // No pick: the agent's own, as before. An agent its own model answers keeps its own words for a pick.
    expect(await reply(ctx({ external: true, answering: CLAUDE }))).toContain("Model: Opus 5.5 (Claude Code's own, as its last session opened)");
    expect(await reply(ctx({ external: false, picked: "gpt-x" }))).toContain("Model: gpt-x (overridden for this chat)");
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
