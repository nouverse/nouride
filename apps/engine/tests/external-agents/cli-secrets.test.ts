/**
 * A credential sent in chat, and a coding CLI (0.8.11, RFC Part C §C.6). A CLI's commands run in its own shell, whose
 * environment is the one its process started with: the note a model's turn gets — "in an exec command the handle is the
 * credential" — was false for it, and `curl -H "Authorization: Bearer $TMP_SECRET_…"` sent an empty token. Now it is told
 * the handle does not reach its shell and that `secret_save` keeps one for its next turn; and its CLI is started again
 * with the secrets it starts with when they changed, at a turn where nothing else of the agent is at work.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import { privateWorkspace } from "@nouride/persona";
import { spawnLongLived } from "@nouride/runtime";
import { TransientSecrets } from "@nouride/secrets";
import type { LoadedAgent, MessageEnvelope } from "@nouride/shared";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import type { ExecutorDeps, TurnBrain, TurnRequest } from "@/modules/llm/executor/types.ts";
import { ActiveTurns } from "@/modules/pipeline/active-turns.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import { secretsNote } from "@/modules/pipeline/messages.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";
import { clockDeps } from "./fixtures/clock.ts";

/** A GitHub token's shape, made here rather than written out — a scanner reads the source too. */
const TOKEN = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
const OWN_SHELL = "The handle does not reach your own shell: your commands run with the environment your CLI started with";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the note beside a credential's handle", () => {
  const taken = [{ handle: "$TMP_SECRET_3F9A1C2B7D4E", label: "a GitHub token" }];

  test("to a coding CLI: not in its shell; `secret_save` keeps it for its next turn — never the exec line", () => {
    const note = secretsNote(taken, { ownShell: true });
    expect(note).toContain(`${OWN_SHELL}, so "$TMP_SECRET_3F9A1C2B7D4E" is empty there.`);
    expect(note).toContain("Where the person wants it used, keep it under a name with secret_save: it is in your commands' environment from your next turn on.");
    expect(note).toContain("Keep one only if the person asks you to.");
    expect(note).not.toContain("In an exec command the handle is the credential");
  });

  test("to a model's turn, as before", () => {
    expect(secretsNote(taken)).toContain("In an exec command the handle is the credential");
    expect(secretsNote(taken)).not.toContain(OWN_SHELL);
  });
});

describe("in a coding CLI's turn", () => {
  test("its message carries the CLI's note, not the exec line", async () => {
    const seen: TurnRequest[] = [];
    const cli = {
      runnerFor: (_agent: LoadedAgent, d: ExecutorDeps): TurnBrain => ({
        run: async (req) => {
          seen.push(req);
          d.onText?.("noted");
          const turn = [req.userMessage, { role: "assistant" as const, content: "noted", timestamp: Date.now() }];
          const compaction = { threshold: 1e9, limit: 1e9, totalLimit: 1e9, source: "test", summaryModel: "", summarizerWindow: 0 };
          return { text: "noted", messages: [...req.history, ...turn], turnMessages: turn, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0, iterations: 0, approvalsRefused: 0, toolSteps: [], stopReason: "stop", contextTokens: 0, truncated: false, compaction, tokenScale: 1 };
        },
      }),
    };
    const bench: Bench = await pipelineBench({ agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n', deps: { externalAgents: cli, heldSecrets: new TransientSecrets() } });
    cleanups.push(bench.dispose);
    bench.pipeline.attach();
    bench.gateway.receive(envelope({ gatewayId: "telegram:main", chatId: "814", chatType: "dm", senderId: "u1", senderName: "Gading", text: `deploy with ${TOKEN}`, timestamp: Date.now() }));
    await eventually(() => seen.length > 0, 5_000, "the CLI's turn");
    const said = JSON.stringify(seen[0]!.userMessage.content);
    expect(said).toContain(OWN_SHELL);
    expect(said).not.toContain("In an exec command the handle is the credential");
    expect(said).not.toContain(TOKEN);
  });

  test("a message steered into its running prompt carries the CLI's note too; a model's keeps its own", () => {
    const steered = (external: boolean) => {
      const deps = { registry: { get: () => ({ config: { displayName: "Nix", ...(external ? { external: { cli: "claude-code" } } : {}) } }) }, turns: { runningFor: () => null } } as unknown as PipelineDeps;
      const turns = new ActiveTurns(deps);
      const key = ActiveTurns.turnKey("nix", "814", "telegram:main");
      const sent = { id: "m2", timestamp: 1, gateway: "telegram", gatewayId: "telegram:main", chatId: "814", chatType: "dm", senderId: "u1", senderName: "Gading", text: "and use $TMP_SECRET_3F9A1C2B7D4E", secrets: [{ handle: "$TMP_SECRET_3F9A1C2B7D4E", label: "a GitHub token" }] } as unknown as MessageEnvelope;
      turns.activeTurns.set(key, { controller: new AbortController(), agentId: "nix", chatId: "814", gatewayId: "telegram:main", steers: [sent], steered: 0 });
      return String(turns.takeSteers(key)!.content);
    };
    expect(steered(true)).toContain(OWN_SHELL);
    expect(steered(false)).toContain("In an exec command the handle is the credential");
  });
});

/** Each prompt says "Working.", takes `ms`, then "Done." — and, with `echo`, says back the prompt it was given. */
const row = (ms: number, echo = false): CliRow => ({
  id: "fake",
  name: "Fake CLI",
  command: process.execPath,
  args: [join(import.meta.dir, "fixtures/fake-cli.ts")],
  install: "it is a test",
  versionArgs: ["--version"],
  env: { FAKE_MODE: "script", FAKE_SCRIPT: JSON.stringify([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working. " } }, { sleep: ms }, ...(echo ? [{ echo: true }] : []), { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }]) },
  modes: { folder: "yolo", risky: "default", all: "default" },
  instructionFile: "AGENTS.md",
});

describe("its CLI, started again when the secrets it starts with changed", () => {
  function setup(ms = 0, options: { echo?: boolean; freshWaitMs?: number; commandsUnder?: () => number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "external-secrets-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
    let secrets: Record<string, string> = {};
    /** What each process of the CLI was started with. */
    const started: Record<string, string>[] = [];
    const service = new ExternalAgents({
      rows: () => [row(ms, options.echo)],
      workspaceDir: () => dir,
      secretsFor: () => secrets,
      ...(options.freshWaitMs !== undefined ? { freshWaitMs: options.freshWaitMs } : {}),
      ...(options.commandsUnder ? { commandsUnder: options.commandsUnder } : {}),
      sessions: { load: () => ({}), save: () => {} },
      spawn: (cmd, opts) => (started.push(opts.env), spawnLongLived(cmd, opts)),
    });
    cleanups.push(() => service.stopAll());
    const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" } }, persona: { identity: "" }, dir } as unknown as LoadedAgent;
    /** What the CLI said, as it said it: "Working. " is its prompt under way, its session held. */
    const said: string[] = [];
    const runner = service.runnerFor(agent, { ...clockDeps, onActivity: () => {}, onText: (delta: string) => void said.push(delta) } as unknown as ExecutorDeps)!;
    const req = (chatId: string, text: string) =>
      ({ agent, toolset: { definitions: [], get: () => undefined }, history: [], userMessage: { role: "user", content: text }, gateway: "telegram", gatewayId: "telegram:coder", chatId, chatType: "dm", senderId: "555", senderName: "Mira" }) as unknown as TurnRequest;
    return { runner, req, started, said, setSecrets: (next: Record<string, string>) => void (secrets = next) };
  }

  test("a credential kept since: the next turn's CLI has it in its environment; unchanged, the same process goes on", async () => {
    const { runner, req, started, setSecrets } = setup();
    await runner.run(req("555", "one"));
    await runner.run(req("555", "two"));
    expect(started).toHaveLength(1);
    expect(started[0]!.TEST_TOKEN).toBeUndefined();
    setSecrets({ TEST_TOKEN: "kept-in-chat" });
    await runner.run(req("555", "three"));
    expect(started).toHaveLength(2);
    expect(started[1]!.TEST_TOKEN).toBe("kept-in-chat");
  });

  /**
   * The turn that found its CLI's secrets changed while another turn worked in it went on, on the old process, without
   * them: a mission Nix started in the turn that kept its keys opened twelve seconds before that turn ended, and asked the
   * person for keys already kept (2026-11-02). It waits for that turn now, and the CLI starts again with them.
   */
  // Four and a half seconds on CI, two prompts of a real process: its own timeout, the suite's.
  test("a turn that finds them changed while another works in the CLI waits for that one, and its shell has them", async () => {
    const { runner, req, started, said, setSecrets } = setup(1_500, { echo: true });
    await runner.run(req("555", "first"));
    said.length = 0;
    const long = runner.run(req("777", "a long one"));
    await eventually(() => said.join("").includes("Working."), 3_000, "the long prompt under way");
    setSecrets({ TEST_TOKEN: "kept-in-chat" });
    await runner.run(req("555", "meanwhile"));
    await long;
    expect(started).toHaveLength(2);
    expect(started[1]!.TEST_TOKEN).toBe("kept-in-chat");
    // Started again with it, its first prompt has nothing to be told.
    expect(said.join("")).not.toContain("not in your shell this turn");
  }, 30_000);

  test("past the wait it goes on, told which variables its shell does not have yet — and the next turn has them", async () => {
    const { runner, req, started, said, setSecrets } = setup(800, { echo: true, freshWaitMs: 200 });
    await runner.run(req("555", "first"));
    said.length = 0;
    const long = runner.run(req("777", "a long one"));
    await eventually(() => said.join("").includes("Working."), 3_000, "the long prompt under way");
    setSecrets({ TEST_TOKEN: "kept-in-chat", OTHER_KEY: "also" });
    said.length = 0;
    await runner.run(req("555", "meanwhile"));
    expect(started).toHaveLength(1);
    const told = said.join("");
    expect(told).toContain("[Kept since your CLI started, and not in your shell this turn: $OTHER_KEY, $TEST_TOKEN. They are kept, so do not ask the person for them again; your shell has them from your next turn.");
    expect(told).not.toContain("kept-in-chat");
    await long;
    await runner.run(req("555", "after"));
    expect(started).toHaveLength(2);
    expect(started[1]!.TEST_TOKEN).toBe("kept-in-chat");
  }, 15_000);

  test("a command the CLI left running is not waited for — it may run for hours — and the turn is told at once", async () => {
    let commands = 0;
    const { runner, req, said, setSecrets } = setup(800, { echo: true, commandsUnder: () => commands });
    await runner.run(req("555", "first"));
    said.length = 0;
    const long = runner.run(req("777", "a long one"));
    await eventually(() => said.join("").includes("Working."), 3_000, "the long prompt under way");
    commands = 1;
    setSecrets({ TEST_TOKEN: "kept-in-chat" });
    said.length = 0;
    const started = Date.now();
    await runner.run(req("555", "meanwhile"));
    // Its own prompt's 800 ms and no more: not the other turn's end.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(said.join("")).toContain("not in your shell this turn: $TEST_TOKEN.");
    await long;
  }, 15_000);

  test("nothing changed: no wait, no note", async () => {
    const { runner, req, said } = setup(0, { echo: true });
    await runner.run(req("555", "one"));
    await runner.run(req("555", "two"));
    expect(said.join("")).not.toContain("not in your shell this turn");
  });
});
