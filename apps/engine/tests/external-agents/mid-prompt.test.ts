/**
 * A message for a coding CLI's turn handed over while its prompt runs (0.8.10, `external-agents/steering.ts`): through
 * `_session/steering` where the CLI offers it, held while a tool call is open — at most the hold — and, where the CLI
 * does not take it, the turn's next prompt as before. Before, every one waited for the prompt to end: hours, in a
 * mission, while the person had been told "before my next step".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow, SteerOutcome } from "@nouride/acp";
import type { ChatMessage, LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { runAgentCommandsThrough } from "@nouride/runtime";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { MidPrompt, merged } from "@/modules/external-agents/steering.ts";
import { situationOf, untold } from "@/modules/external-agents/situation.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { eventually } from "../wait.ts";
import { CLOCK, clockDeps } from "./fixtures/clock.ts";
import { stderrSaid } from "./fixtures/stderr.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  runAgentCommandsThrough(null);
});

const say = (text: string): ChatMessage => ({ role: "user", content: text });
/** What was poked has run: its sleeps are the fake clock's, so a few rounds of the microtask queue see it through. */
const settled = async () => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
};

describe("a message held for a running prompt", () => {
  function mid(o: { busy?: () => boolean; replying?: () => boolean; outcome?: SteerOutcome; holdMs?: number; waiting?: string[] }) {
    const waiting = o.waiting ?? ["also this"];
    const sent: string[] = [];
    const taken: string[] = [];
    let clock = 0;
    const prompt = new MidPrompt({
      take: () => (waiting.length > 0 ? say(waiting.splice(0).join(" + ")) : null),
      send: async (message) => (sent.push(String(message.content)), o.outcome ?? "injected"),
      busy: o.busy ?? (() => false),
      ...(o.replying ? { replying: o.replying } : {}),
      taken: (message) => void taken.push(String(message.content)),
      holdMs: o.holdMs ?? 1_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    return { prompt, sent, taken, waiting };
  }

  test("taken into the prompt at once where nothing runs, and said in the turn", async () => {
    const m = mid({});
    m.prompt.poke();
    expect(await m.prompt.end()).toBeNull();
    expect(m.sent).toEqual(["also this"]);
    expect(m.taken).toEqual(["also this"]);
  });

  test("held while a tool call is open, sent once it ends", async () => {
    let open = 3;
    const m = mid({ busy: () => (open -= 1) > 0 });
    m.prompt.poke();
    await settled();
    expect(await m.prompt.end()).toBeNull();
    expect(open).toBe(0);
    expect(m.sent).toEqual(["also this"]);
  });

  test("held while the line in the agent's own words is written for it, sent once that is said — the two read together", async () => {
    let writing = 3;
    const m = mid({ replying: () => (writing -= 1) > 0 });
    m.prompt.poke();
    await settled();
    expect(await m.prompt.end()).toBeNull();
    expect(writing).toBe(0);
    expect(m.sent).toEqual(["also this"]);
  });

  test("held while a tool call is open, sent the moment it ends — not at the next look (Codex's steps, 10 ms apart)", async () => {
    let open = true;
    const sent: string[] = [];
    // Looks that never come round on their own: only the call ending sends it.
    const prompt = new MidPrompt({
      take: () => say("btw, 17 + 25?"),
      send: async (message) => (sent.push(String(message.content)), "injected"),
      busy: () => open,
      taken: () => {},
      sleep: () => new Promise<void>(() => {}),
    });
    prompt.poke();
    await settled();
    expect(sent).toEqual([]);
    open = false;
    prompt.wake();
    await settled();
    expect(sent).toEqual(["btw, 17 + 25?"]);
  });

  test("past the hold, sent anyway — a command that never ends does not keep a person's words from it", async () => {
    const m = mid({ busy: () => true, holdMs: 2_000 });
    m.prompt.poke();
    await settled();
    await m.prompt.end();
    expect(m.sent).toEqual(["also this"]);
  });

  test("the prompt ending while it is held leaves it the turn's, for the next prompt", async () => {
    let ended: Promise<ChatMessage | null> | undefined;
    const m = mid({ busy: () => ((ended ??= m.prompt.end()), true) });
    m.prompt.poke();
    expect(await ended).toBeNull();
    expect(m.sent).toEqual([]);
    // Not taken from the turn: its own `steer` takes it, as before.
    expect(m.waiting).toEqual(["also this"]);
  });

  test("not taken by the CLI — no prompt running, or refused — it is the next prompt, in the order they came", async () => {
    for (const outcome of ["promptRequired", "failed"] as const) {
      const m = mid({ outcome, waiting: ["first"] });
      m.prompt.poke();
      await settled();
      m.waiting.push("second");
      m.prompt.poke();
      await settled();
      const left = await m.prompt.end();
      expect(String(left?.content)).toBe("first\n\nsecond");
      expect(m.taken).toEqual([]);
    }
    // A turn the CLI started for them by itself (codex-acp): taken.
    const codex = mid({ outcome: "startedNewTurn" });
    codex.prompt.poke();
    await settled();
    expect(await codex.prompt.end()).toBeNull();
    expect(codex.taken).toEqual(["also this"]);
  });

  test("merged with what is not text, in order", () => {
    const both = merged(say("first"), { role: "user", content: [{ type: "text", text: "second" }] });
    expect(both.content).toEqual([{ type: "text", text: "first" }, { type: "text", text: "\n\n" }, { type: "text", text: "second" }]);
  });
});

describe("a coding CLI's turn, steered while its prompt runs", () => {
  function setup(env: Record<string, string>, steerHoldMs?: number, replying?: () => boolean) {
    const dir = mkdtempSync(join(tmpdir(), "mid-prompt-"));
    dirs.push(dir);
    mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
    const row: CliRow = {
      id: "fake",
      name: "Fake CLI",
      command: process.execPath,
      args: [FAKE],
      install: "it is a test",
      versionArgs: ["--version"],
      profileEnv: "FAKE_HOME",
      env: { FAKE_MODE: "steer", FAKE_STEER_WAIT_MS: "1500", ...env },
      modes: { folder: "yolo", risky: "default", all: "default" },
      instructionFile: "AGENTS.md",
    };
    const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => dir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} }, ...(steerHoldMs !== undefined ? { steerHoldMs } : {}) });
    services.push(service);
    const deltas: string[] = [];
    const steps: string[] = [];
    const deps = { ...clockDeps, approvals: { available: true }, onText: (delta: string) => void deltas.push(delta), onActivity: (kind: string) => void steps.push(kind) } as unknown as ExecutorDeps;
    const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" } }, persona: { identity: "" }, dir } as unknown as LoadedAgent;
    // The turn's buffer and its listener, as `turn.ts` hands them over.
    const waiting: string[] = [];
    let poke: (() => void) | undefined;
    const send = (text: string) => {
      waiting.push(text);
      poke?.();
    };
    const req = {
      agent,
      toolset: { definitions: [], get: () => undefined },
      history: [],
      userMessage: say("first"),
      gateway: "telegram",
      gatewayId: "telegram:coder",
      chatId: "555",
      senderId: "555",
      steer: () => (waiting.length > 0 ? say(waiting.splice(0).join("\n\n")) : null),
      steerListen: (listener: () => void) => ((poke = listener), () => void (poke = undefined)),
      ...(replying ? { steerReplying: replying } : {}),
    } as unknown as TurnRequest;
    /**
     * The CLI's command is open, as the turn sees it — not "Working.", which a busy machine reads a moment before the call
     * the CLI wrote next: sent then, the words went in with the call not yet seen, and it looked like one on top of it.
     */
    const commandOpen = () => eventually(() => steps.includes("tool"), 10_000, "the CLI's command to be open");
    return { service, agent, runner: service.runnerFor(agent, deps)!, req, deltas, send, commandOpen };
  }

  test("taken into the prompt that is running: one prompt, its answer the steered one, the words in the transcript", async () => {
    const t = setup({ FAKE_STEER: "injected" });
    const running = t.runner.run(t.req);
    await eventually(() => t.deltas.join("").includes("Working."), 10_000, "the prompt to start");
    t.send("use the second tab");
    const result = await running;
    expect(result.text).toBe("Working.Steered: use the second tab");
    expect(result.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["first", "use the second tab"]);
    expect(await stderrSaid(await t.service.connection(t.agent), (line) => line.startsWith("steer:"), 1)).toEqual(["steer:use the second tab"]);
  });

  test("no prompt running by the CLI's account, or a refusal: the turn's next prompt, as before", async () => {
    for (const outcome of ["promptRequired", "failed"]) {
      const t = setup({ FAKE_STEER: outcome });
      const running = t.runner.run(t.req);
      await eventually(() => t.deltas.join("").includes("Working."), 10_000, "the prompt to start");
      t.send("and the totals");
      const result = await running;
      // The first prompt answered on its own, the words then its next prompt — what is here and the clock, first's alone.
      expect(result.text).toBe(`Working.Done: ${untold(situationOf(t.req), undefined)}[telegram] first\n\n${CLOCK}\n\nWorking.Done: and the totals`);
    }
  }, 20_000);

  // Three seconds on CI, a fake CLI's whole prompt: its own timeout, the suite's.
  test("a CLI that does not offer it is never sent one: the next prompt, once the running one ends", async () => {
    const t = setup({ FAKE_STEER_OFFER: "no" });
    const running = t.runner.run(t.req);
    await eventually(() => t.deltas.join("").includes("Working."), 10_000, "the prompt to start");
    t.send("and the totals");
    const result = await running;
    expect(result.text).toEndWith("Done: and the totals");
    expect((await t.service.connection(t.agent)).stderrTail.filter((line) => line.startsWith("steer:"))).toEqual([]);
  }, 30_000);

  test("held while its command runs, sent when it ends — never on top of it", async () => {
    const t = setup({ FAKE_STEER: "injected", FAKE_TOOL_MS: "800", FAKE_STEER_WAIT_MS: "4000" });
    const running = t.runner.run(t.req);
    await t.commandOpen();
    t.send("check the logs too");
    const result = await running;
    // A step between the two: a paragraph, as `UpdateReader` says a CLI's messages around its steps.
    expect(result.text).toBe("Working.\n\nSteered: check the logs too");
    const said = await stderrSaid(await t.service.connection(t.agent), (line) => line === "tool-done" || line.startsWith("steer:"), 2);
    expect(said).toEqual(["tool-done", "steer:check the logs too"]);
  });

  test("a prompt that ends while the line in the agent's words is written: the next prompt reads the words once it is said", async () => {
    let writing = true;
    const t = setup({ FAKE_STEER: "injected", FAKE_STEER_WAIT_MS: "300" }, undefined, () => writing);
    const took: boolean[] = [];
    const steer = t.req.steer!;
    t.req.steer = () => {
      const message = steer();
      if (message) took.push(writing);
      return message;
    };
    const running = t.runner.run(t.req);
    await eventually(() => t.deltas.join("").includes("Working."), 10_000, "the prompt to start");
    t.send("and the totals");
    // The line takes longer than the prompt has left: it ends, holding the words, and the next prompt waits for the line.
    setTimeout(() => (writing = false), 900);
    const result = await running;
    expect(took).toEqual([false]);
    expect(result.text).toEndWith("Done: and the totals");
  });

  test("steps back to back, milliseconds apart: sent as the first ends, not after the last — a look every half second missed every gap", async () => {
    const t = setup({ FAKE_STEER: "injected", FAKE_TOOL_MS: "400", FAKE_TOOLS: "3", FAKE_STEER_WAIT_MS: "4000" });
    const running = t.runner.run(t.req);
    await t.commandOpen();
    t.send("btw, 17 + 25?");
    await running;
    // The first two lines: the steps it cut short go on ending in the fake after its prompt has answered.
    const said = await stderrSaid(await t.service.connection(t.agent), (line) => line === "tool-done" || line.startsWith("steer:"), 2);
    expect(said.slice(0, 2)).toEqual(["tool-done", "steer:btw, 17 + 25?"]);
  });

  // A three-second command held past its four-second wait: its own timeout, the suite's.
  test("past the hold, sent while the command still runs", async () => {
    const t = setup({ FAKE_STEER: "injected", FAKE_TOOL_MS: "3000", FAKE_STEER_WAIT_MS: "4000" }, 300);
    const running = t.runner.run(t.req);
    await t.commandOpen();
    t.send("now, please");
    await running;
    const said = await stderrSaid(await t.service.connection(t.agent), (line) => line === "tool-done" || line.startsWith("steer:"), 2);
    expect(said[0]).toBe("steer:now, please");
  }, 30_000);
});
