/**
 * An external agent's turn, end to end against a coding CLI started as a real process (0.8.1): the CLI's work lands as
 * the executor's would — the same steps, reply and plan; its permission is asked as a Nouride approval and its answer
 * decides the call; the preset and model are the CLI's own settings; `/stop` cancels it; a CLI that is not signed in
 * makes the agent unavailable, saying why.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { runAgentCommandsThrough } from "@nouride/runtime";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { situationOf, untold } from "@/modules/external-agents/situation.ts";
import { CLOCK, clockDeps } from "./fixtures/clock.ts";
import { ownKey, type OwnChat } from "@/modules/external-agents/own-words.ts";
import { cliLeftRunningState, externalEffortsState, externalModelsState } from "@/commons/daemon-state.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import type { PlanStep } from "@/modules/notes/store.ts";
import type { ApprovalAsk, ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { stateRows } from "../helpers.ts";
import { eventually } from "../wait.ts";
import { stderrSaid } from "./fixtures/stderr.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
/** Each install's state rows, by its folder: a service made again over the same folder reads what the last one wrote. */
const states = new Map<string, StateRows>();
const stateOf = (dir: string): StateRows => states.get(dir) ?? states.set(dir, stateRows()).get(dir)!;
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  runAgentCommandsThrough(null);
});

const row = (mode = "", efforts?: Record<string, string[]>): CliRow => ({
  id: "fake",
  name: "Fake CLI",
  command: process.execPath,
  args: [FAKE],
  install: "it is a test",
  versionArgs: ["--version"],
  profileEnv: "FAKE_HOME",
  env: { FAKE_MODE: mode, ...(efforts ? { FAKE_EFFORTS: JSON.stringify(efforts) } : {}) },
  modes: { folder: "yolo", risky: "default", all: "default" },
  instructionFile: "AGENTS.md",
});

function setup(options: { mode?: string; efforts?: Record<string, string[]>; effort?: string; answer?: ApprovalOutcome; permissions?: "folder" | "risky" | "all"; model?: string; persona?: Record<string, string>; onText?: (delta: string) => void; onPreamble?: ExecutorDeps["onPreamble"]; stopGraceMs?: number; profileInstruction?: boolean; quietMs?: number; commandsUnder?: (pid: number) => number; kept?: Record<string, string>; left?: { load(): Record<string, OwnChat>; save(left: Record<string, OwnChat>): void }; onAsk?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "external-runner-"));
  dirs.push(dir);
  // The agent's own folder, which boot makes for every agent.
  mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
  const plans: PlanStep[][] = [];
  const service = new ExternalAgents({
    rows: () => [{ ...row(options.mode, options.efforts), ...(options.profileInstruction ? { profileInstructionFile: "AGENTS.md" } : {}) }],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: { load: () => ({ ...options.kept }), save: () => {} },
    models: externalModelsState(stateOf(dir)),
    efforts: externalEffortsState(stateOf(dir)),
    keepPlan: async (_key, _task, steps) => void plans.push(steps),
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
    ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
    ...(options.commandsUnder ? { commandsUnder: options.commandsUnder } : {}),
    ...(options.left ? { leftRunning: options.left } : {}),
  });
  services.push(service);
  const asks: ApprovalAsk[] = [];
  const steps: string[] = [];
  const deltas: string[] = [];
  const usages: unknown[] = [];
  const deps = {
    ...clockDeps,
    onUsage: (usage: unknown) => void usages.push(usage),
    approvals: {
      available: true,
      request: async (ask: ApprovalAsk) => {
        asks.push(ask);
        options.onAsk?.();
        await ask.asking?.("apr_1");
        return options.answer ?? { status: "approved", by: "555", decision: "allow-once" };
      },
    } as unknown as ApprovalGate,
    onText: (delta: string) => {
      deltas.push(delta);
      options.onText?.(delta);
    },
    onActivity: (kind: string, text: string) => void steps.push(`${kind}:${text.replace(/ · \d+ms$/, "")}`),
    ...(options.onPreamble ? { onPreamble: options.onPreamble } : {}),
  } as unknown as ExecutorDeps;
  const agent = {
    config: {
      id: "coder",
      displayName: "Coder",
      external: { cli: "fake", ...(options.permissions ? { permissions: options.permissions } : {}), ...(options.model ? { model: options.model } : {}) },
      ...(options.effort ? { llm: { effort: options.effort } } : {}),
    },
    persona: { identity: "", ...options.persona },
    dir,
  } as unknown as LoadedAgent;
  const req = (text: string, extra: Partial<TurnRequest> = {}) =>
    ({
      agent,
      toolset: { definitions: [], get: () => undefined },
      history: [{ role: "user", content: "earlier" }],
      userMessage: { role: "user", content: text },
      gateway: "telegram",
      gatewayId: "telegram:coder",
      chatId: "555",
      senderId: "555",
      senderName: "Mira",
      ...extra,
    }) as unknown as TurnRequest;
  return { service, agent, runner: service.runnerFor(agent, deps)!, req, asks, steps, deltas, plans, usages, folder: privateWorkspace(dir, "coder") };
}

describe("a turn of an external agent", () => {
  test("its work lands as a model's would — steps, reply, plan — and Nouride keeps the transcript", async () => {
    const { runner, req, steps, deltas, plans, asks } = setup();
    // Where it came from, as a model's prompt says it: the platform, a DM, the agents `ask_agent` reaches (0.8.1).
    const asked = req("push the fix", { chatType: "dm", otherAgents: { names: ["nouva", "nox"], about: {}, mentions: {}, maxHops: 3, channel: "bus" } } as Partial<TurnRequest>);
    const result = await runner.run(asked);
    // Opened with who is here (`situation.ts`), whose words have a test of their own below.
    const opening = untold(situationOf(asked), undefined);
    expect(steps).toEqual([
      "reasoning:Looking first.",
      "tool:echo hi",
      "tool_done:Bash ok: hi",
      "tool:git push",
      "waiting:waiting for approval: fake:Bash",
      "tool_done:Bash ok",
    ]);
    // The turn's notes after its words, the clock first (0.8.10).
    expect(deltas.join("")).toBe(`Done: ${opening}[telegram · DM · ask_agent: nouva, nox] Mira: push the fix\n\n${CLOCK}`);
    expect(result.text).toBe(`Done: ${opening}[telegram · DM · ask_agent: nouva, nox] Mira: push the fix\n\n${CLOCK}`);
    // Its record says the CLI answered, not the agent's own model (0.8.1) — and, set none, the CLI's own default.
    expect(result.answeredBy).toBe("Fake CLI · small");
    expect(result.toolSteps).toEqual([{ name: "Bash", ok: true }, { name: "Bash", ok: true }]);
    expect(result.toolCalls).toBe(2);
    expect(result.messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:earlier", "user:push the fix", `assistant:Done: ${opening}[telegram · DM · ask_agent: nouva, nox] Mira: push the fix\n\n${CLOCK}`]);
    expect(plans).toEqual([[{ text: "push it", state: "done" }]]);
    expect(asks[0]).toMatchObject({ tool: "fake:Bash", params: { command: "git push" }, reason: "Fake CLI asks to run the command above", chatId: "555" });
  });

  test("an update it sends that no reader can take is passed over: this turn and the next end as they should (0.8.1)", async () => {
    // A plan without its entries threw in the reader, which ended the reading of the CLI's stdout: the turn waited
    // forever, and the CLI died at its next write, failing another conversation's turn.
    const { runner, req } = setup({ mode: "badplan" });
    expect((await runner.run(req("one"))).text).toEndWith(`Mira: one\n\n${CLOCK}`);
    expect((await runner.run(req("two", { chatId: "556" }))).text).toEndWith(`Mira: two\n\n${CLOCK}`);
  });

  test("a person's no is the CLI's call refused, and counted", async () => {
    const { runner, req, steps } = setup({ answer: { status: "denied", by: "555" } });
    const result = await runner.run(req("push"));
    expect(steps).toContain("tool_done:Bash failed");
    expect(result.approvalsRefused).toBe(1);
  });

  test("in a mission the question is parked, answerable for as long as the turn says", async () => {
    const { runner, req, asks } = setup({ answer: { status: "expired", stillAnswerable: true } });
    await runner.run(req("push", { parkApprovalsMs: 86_400_000 }));
    expect(asks[0]).toMatchObject({ waitMs: 0, answerableMs: 86_400_000 });
  });

  test("the preset is the CLI's mode and the model its option, set once on the session it opened", async () => {
    // Where each agent is its own user — the only place Free in its folder runs as itself.
    runAgentCommandsThrough({ prefix: () => ["env"], put: () => [] });
    const { service, runner, req } = setup({ permissions: "folder", model: "big" });
    await runner.run(req("one"));
    // The record names the pack's model, not the default the session opened on.
    expect((await runner.run(req("two"))).answeredBy).toBe("Fake CLI · big");
    const connection = await service.connection({ config: { id: "coder", external: { cli: "fake" } }, dir: "" } as unknown as LoadedAgent);
    expect(await stderrSaid(connection, (line) => line.startsWith("mode:") || line.startsWith("model:"), 2)).toEqual(["mode:yolo", "model:big"]);
  });

  test("where agents are not their own users, a pack's Free in its folder asks as Ask when risky does (0.8.1)", async () => {
    // There the CLI is the daemon's user, which reads the database and the secret store: run unasked, nothing held it.
    // The Brain tab said it asked as Risky does; only a pack that named no preset got that.
    const { service, runner, req } = setup({ permissions: "folder" });
    await runner.run(req("one"));
    const connection = await service.connection({ config: { id: "coder", external: { cli: "fake" } }, dir: "" } as unknown as LoadedAgent);
    expect(await stderrSaid(connection, (line) => line.startsWith("mode:"), 1)).toEqual(["mode:default"]);
    expect([service.preset("folder"), service.preset(), service.preset("all")]).toEqual(["risky", "risky", "all"]);
    runAgentCommandsThrough({ prefix: () => ["env"], put: () => [] });
    expect([service.preset("folder"), service.preset(), service.preset("risky")]).toEqual(["folder", "folder", "risky"]);
  });

  test("nothing asks before it deletes only in `folder`, where it is its own user — what a mission's page says (0.8.8)", () => {
    const { service } = setup();
    const agent = (permissions?: "folder" | "risky" | "all", external = true) => ({ config: { id: "coder", ...(external ? { external: { cli: "fake", ...(permissions ? { permissions } : {}) } } : {}) } }) as unknown as LoadedAgent;
    // The daemon's own user: `folder` asks as `risky` does.
    expect(service.freeToDelete(agent("folder"))).toBe(false);
    runAgentCommandsThrough({ prefix: () => ["env"], put: () => [] });
    expect([agent("folder"), agent(), agent("risky"), agent("all")].map((one) => service.freeToDelete(one))).toEqual([true, true, false, false]);
    // An agent its own model answers, or none at all, is held by the approvals.
    expect(service.freeToDelete(agent(undefined, false))).toBe(false);
    expect(service.freeToDelete(undefined)).toBe(false);
    // A CLI of the person's own with no `folder` mode keeps its default there, which may ask.
    const modeless = new ExternalAgents({ rows: () => [{ ...row(), modes: {} }], workspaceDir: () => "/nonexistent", secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} } });
    expect(modeless.freeToDelete(agent("folder"))).toBe(false);
  });

  test("the models the CLI offers are kept as its session said them, and outlive a restart, for the Brain tab to suggest (0.8.1)", async () => {
    // On the live box the Brain tab's model field was empty text: a person had to know the CLI's names for its models.
    const { service, runner, req } = setup();
    expect(service.models.of("coder")).toEqual([]);
    await runner.run(req("one"));
    expect(service.models.of("coder")).toEqual([{ value: "small", current: "small" }, { value: "big" }]);
    const dir = dirs.at(-1)!;
    const restarted = new ExternalAgents({ workspaceDir: () => dir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} }, models: externalModelsState(stateOf(dir)) });
    expect(restarted.models.of("coder")).toEqual([{ value: "small", current: "small" }, { value: "big" }]);
  });

  describe("the effort, the agent's one `[llm] effort`, set where the CLI offers it under `thought_level` (0.8.7)", () => {
    const efforts = (connection: { readonly stderrTail: readonly string[] }, want: number) => stderrSaid(connection, (line) => line.startsWith("model:") || line.startsWith("reasoning:"), want);
    const kept = (steps: string[]) => steps.filter((step) => step.includes("kept its own effort"));

    test("a CLI that offers the value is set to it by its option's own id, once, and the Brain tab is told what it offers", async () => {
      const { service, agent, runner, req, steps } = setup({ efforts: { small: ["low", "high"] }, effort: "high" });
      await runner.run(req("one"));
      await runner.run(req("two"));
      expect(await efforts(await service.connection(agent), 1)).toEqual(["reasoning:high"]);
      expect(kept(steps)).toEqual([]);
      expect(service.efforts.of("coder")).toEqual([{ value: "low" }, { value: "high", current: "high" }]);
    });

    test("a value its model does not offer leaves the CLI's own, said once, and is not mapped to a near one", async () => {
      const { service, agent, runner, req, steps } = setup({ efforts: { small: ["low", "high"] }, effort: "max" });
      await runner.run(req("one"));
      await runner.run(req("two"));
      expect(kept(steps)).toEqual(["note:Fake CLI kept its own effort: max not offered"]);
      expect((await service.connection(agent)).stderrTail.filter((line) => line.startsWith("reasoning:"))).toEqual([]);
      expect(service.efforts.of("coder")).toEqual([{ value: "low", current: "low" }, { value: "high" }]);
    });

    test("a CLI that offers no effort at all keeps its own, said, and nothing is set", async () => {
      const { service, runner, req, steps } = setup({ effort: "high" });
      await runner.run(req("one"));
      expect(kept(steps)).toEqual(["note:Fake CLI kept its own effort: high not offered"]);
      expect(service.efforts.of("coder")).toEqual([]);
    });

    test("/effort's level for a chat goes over the pack's; taken away, the pack's comes back, else the CLI's own", async () => {
      // 0.8.16: a chat's `/effort` reaches the running session, and `/effort default` does not leave the chat's level.
      const own = setup({ efforts: { small: ["low", "high", "max"] } });
      await own.runner.run(own.req("one", { effort: "high" }));
      await own.runner.run(own.req("two", { effort: "high" }));
      await own.runner.run(own.req("three"));
      expect(await efforts(await own.service.connection(own.agent), 2)).toEqual(["reasoning:high", "reasoning:low"]);
      const pack = setup({ efforts: { small: ["low", "high", "max"] }, effort: "max" });
      await pack.runner.run(pack.req("one", { effort: "high" }));
      await pack.runner.run(pack.req("two"));
      expect(await efforts(await pack.service.connection(pack.agent), 2)).toEqual(["reasoning:high", "reasoning:max"]);
      expect(kept([...own.steps, ...pack.steps])).toEqual([]);
    });

    test("the model first, then the effort among what the new model offers: one the old did not offer is set once it does", async () => {
      const { service, agent, runner, req, steps } = setup({ efforts: { small: ["low"], big: ["low", "high", "max"] }, model: "small", effort: "max" });
      await runner.run(req("one"));
      (agent.config.external as { model?: string }).model = "big";
      await runner.run(req("two"));
      await runner.run(req("three"));
      expect(await efforts(await service.connection(agent), 3)).toEqual(["model:small", "model:big", "reasoning:max"]);
      expect(kept(steps)).toEqual(["note:Fake CLI kept its own effort: max not offered"]);
      expect(service.efforts.of("coder")).toEqual([{ value: "low" }, { value: "high" }, { value: "max", current: "max" }]);
    });
  });

  test("/stop is a cancel: the turn ends as a stopped one, not an error", async () => {
    const { runner, req, deltas } = setup({ mode: "slow" });
    const controller = new AbortController();
    const running = runner.run(req("a long job", { signal: controller.signal }));
    await eventually(() => deltas.length > 0, 10_000, "the CLI to start the prompt");
    controller.abort("stopped-by-person");
    const result = await running;
    expect(result.stopReason).toBe("stop");
    // What it said before the stop is kept, as a model's partial reply is.
    expect(result.text).toBe("On it.");
  });

  test("its instruction file carries Nouride's block — who it is, which CLI, its persona pack in a prompt's order — and the person's lines", async () => {
    // One persona pack whoever answers (0.8.1): a person edited SOUL.md on the Files tab and expected a CLI agent to
    // read it, and a separate instruction field on the Brain tab read as a second persona.
    const persona = { identity: "# Coder\nWrites the household's code.", soul: "Answer in Indonesian.", agents: "Run the tests before a push.", memory: "The repo is nouride." };
    const { runner, req, folder } = setup({ persona });
    writeFileSync(join(folder, "AGENTS.md"), "# My notes\n\nKeep commits small.\n");
    await runner.run(req("one"));
    const written = readFileSync(join(folder, "AGENTS.md"), "utf8");
    expect(written.startsWith("# My notes\n\nKeep commits small.\n\n<!-- nouride:begin")).toBe(true);
    expect(written).toContain("<!-- nouride:begin (Nouride writes this part from the agent's persona files; change them on its Files tab, not here) -->");
    // Not the adapter's version, which the agent took for its CLI's (0.8.1); and its own tools named against Nouride's.
    expect(written).toContain("You are Coder, an agent in Nouride, answered by Fake CLI. People message you from chat;");
    expect(written).not.toContain("9.9.9");
    expect(written).toContain("Nouride's own tools are the `nouride` MCP server's");
    expect(written).toContain("Where the files below name a tool you do not have (`exec`, `read`, `write`, `edit`, `web_fetch`), use your own that does it.");
    // Each file under a heading — its own first line where it is one, else its name (0.8.5): joined bare, a file that did
    // not open with one read as the end of the one before it.
    expect(written).toContain("\n\n# Coder\nWrites the household's code.\n\n# SOUL.md\n\nAnswer in Indonesian.\n\n# AGENTS.md\n\nRun the tests before a push.\n\n# MEMORY.md\n\nThe repo is nouride.\n<!-- nouride:end -->\n");
    // The block is replaced where it stands, the person's lines after it kept, and nothing written when nothing changed.
    writeFileSync(join(folder, "AGENTS.md"), `${written}\nAdded later by hand.\n`);
    await runner.run(req("two"));
    const again = readFileSync(join(folder, "AGENTS.md"), "utf8");
    expect(again).toBe(`${written}\nAdded later by hand.\n`);
    expect(again.match(/nouride:begin/g)).toHaveLength(1);
  });

  test("a mission's turns work in its folder — made as the agent at the first — in one session; the instructions stay in the agent's own", async () => {
    const { service, runner, req, folder } = setup();
    const workdir = join(folder, "missions", "m1");
    const mission = { gatewayId: "mission", chatId: "m1", workdir };
    await runner.run(req("first turn", mission));
    await runner.run(req("second turn", mission));
    const connection = await service.connection({ config: { id: "coder", external: { cli: "fake" } }, dir: "" } as unknown as LoadedAgent);
    expect(await stderrSaid(connection, (line) => line.startsWith("cwd:"), 1)).toEqual([`cwd:${workdir}`]);
    expect(existsSync(workdir)).toBe(true);
    expect(existsSync(join(workdir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(folder, "AGENTS.md"))).toBe(true);
  });

  /**
   * Codex reads `AGENTS.md` from a repository's root down, and from its profile (`CODEX_HOME`) — never from the agent's
   * folder while it works in a mission's repository. There it answered as plain Codex, without the agent's name, voice
   * or memory (0.8.1–0.8.3). Its block goes in its profile now, and leaves the agent's folder, where it was read twice.
   */
  test("a CLI that reads instructions from its profile gets the block there — a mission reads it too — and the agent's folder loses the old one", async () => {
    const persona = { identity: "# Coder\nWrites the household's code.", soul: "Answer in Indonesian." };
    const { runner, req, folder } = setup({ persona, profileInstruction: true });
    const old = "<!-- nouride:begin (Nouride writes this part from the agent's persona files; change them on its Files tab, not here) -->\nYou are Coder, as 0.8.3 wrote it.\n<!-- nouride:end -->";
    writeFileSync(join(folder, "AGENTS.md"), `# My notes\n\nKeep commits small.\n\n${old}\n`);
    const workdir = join(folder, "missions", "m1");
    await runner.run(req("first turn", { gatewayId: "mission", chatId: "m1", workdir }));

    const profile = readFileSync(join(folder, ".cli", "fake", "default", "AGENTS.md"), "utf8");
    expect(profile).toContain("You are Coder, an agent in Nouride, answered by Fake CLI.");
    expect(profile).toContain("\n\n# Coder\nWrites the household's code.\n\n# SOUL.md\n\nAnswer in Indonesian.\n<!-- nouride:end -->\n");
    // The person's own lines stay where they were; Nouride's block, read a second time in every chat, goes.
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toBe("# My notes\n\nKeep commits small.\n");
    // And still nothing in the mission's folder, which may be a person's repository.
    expect(existsSync(join(workdir, "AGENTS.md"))).toBe(false);
  });

  test("a stop that came before the session opened is kept: no prompt reaches the CLI (0.8.1)", async () => {
    // The stop was listened for only once the CLI had started, so one that came while it started was lost.
    const { runner, req, steps } = setup();
    const controller = new AbortController();
    controller.abort("stopped-by-person");
    const result = await runner.run(req("push the fix", { signal: controller.signal }));
    expect({ text: result.text, calls: result.toolCalls, steps }).toEqual({ text: "", calls: 0, steps: [] });
  });

  test("a CLI that does not stop when asked is stopped, and the turn ends as stopped — not the agent unavailable (0.8.1)", async () => {
    const { service, runner, req, deltas } = setup({ mode: "deaf", stopGraceMs: 100 });
    const controller = new AbortController();
    const running = runner.run(req("a long job", { signal: controller.signal }));
    await eventually(() => deltas.length > 0, 10_000, "the CLI to start the prompt");
    controller.abort("stopped-by-person");
    const result = await running;
    expect({ stop: result.stopReason, text: result.text, unavailable: service.unavailable("coder") }).toEqual({ stop: "stop", text: "On it.", unavailable: null });
  });

  test("a message steered in, whose prompt was then stopped, stays in the transcript (0.8.1)", async () => {
    const controller = new AbortController();
    const { runner, req } = setup({ onText: (delta) => delta.includes("also this") && controller.abort("stopped-by-person") });
    let steered = false;
    const steer = () => (steered ? null : ((steered = true), { role: "user" as const, content: "also this" }));
    const result = await runner.run(req("first", { signal: controller.signal, steer }));
    expect(result.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["earlier", "first", "also this"]);
  });

  test("a message steered in gets its own answer, said before the next prompt's work — not one message for both (0.8.5)", async () => {
    // Live: "pushed it" and the answer to the question asked meanwhile came as one message, minutes after the first.
    const said: { words: string; own: boolean; after: number }[] = [];
    const { runner, req, steps } = setup({ onPreamble: async (words, options) => (said.push({ words, own: options?.own === true, after: steps.length }), true) });
    let steered = false;
    const steer = () => (steered ? null : ((steered = true), { role: "user" as const, content: "also this" }));
    const result = await runner.run(req("first", { steer }));
    // The first prompt's six steps, then its answer, then the second prompt's work.
    expect(said).toEqual([{ words: expect.stringMatching(/^Done: .*first\n\n\(Sent [^\n]*\)$/s), own: true, after: 6 }]);
    expect(steps).toHaveLength(12);
    expect(result.text).toBe("Done: also this");
    // The conversation keeps both answers.
    expect(result.turnMessages.at(-1)?.content).toMatch(/^Done: .*first\n\n\(Sent [^\n]*\)\n\nDone: also this$/s);
  });

  test("a DM's person, matched in [[people]], is named and told who they are — once a session, then only what changed (0.8.5)", async () => {
    // Nix, asked "do you remember my name?", guessed from one message a steer had labelled: a DM gave its CLI nothing — a
    // platform's display name is withheld there, and the person `[[people]]` matched never reached the prompt.
    const { runner, req } = setup();
    const recall = (fact: string) => ({
      profiles: [{ name: "Gading", facts: [{ section: "Work", text: fact, learned: "2026-10-27" }] }],
      shared: [],
      upcoming: [],
      followUps: [],
      recent: [{ id: "ep-1", day: "2026-10-27", time: "23:00", agents: ["nouva"], summary: "Talked about the Box.", theirs: true }],
      waiting: [],
    });
    const as = (text: string, fact: string) => req(text, { chatType: "dm", senderName: undefined, person: { name: "Gading", notes: "Owns this install." }, recall: recall(fact) } as Partial<TurnRequest>);

    const first = await runner.run(as("hi", "Builds Nouride."));
    expect(first.text).toContain("You are talking to Gading. Owns this install.");
    expect(first.text).toContain("What you know about Gading:\nWork:\n- 2026-10-27 · Builds Nouride.");
    expect(first.text).toEndWith(`[telegram · DM] Gading: hi\n\n${CLOCK}`);
    // The conversations of the last days change with every one the household has; `memory_search` reaches them.
    expect(first.text).not.toContain("Talked about the Box.");

    const second = await runner.run(as("again", "Builds Nouride."));
    // Who is here and how to write here, told already; the clock, every turn.
    expect(second.text).toBe(`Done: [telegram · DM] Gading: again\n\n${CLOCK}`);

    const third = await runner.run(as("and now", "Builds Nouride and Nougate."));
    expect(third.text).toContain("- 2026-10-27 · Builds Nouride and Nougate.");
    expect(third.text).not.toContain("You are talking to Gading");
  });

  test("a scheduled job's turn is told how to write where its words go; who is here stands as told (0.8.10)", async () => {
    // A job's session, which no person opened, was told nothing: a report it sent to Telegram had the tables that
    // platform's line is there to stop.
    const TELEGRAM = "Formatting: this is usually read on a phone, so do not use tables.";
    const { runner, req } = setup();
    const job = (text: string) => req(text, { systemEvent: true, formatting: TELEGRAM } as Partial<TurnRequest>);
    const person = (text: string) => req(text, { formatting: TELEGRAM } as Partial<TurnRequest>);
    expect((await runner.run(job("the morning report"))).text).toBe(`Done: [Nouride: who is here, the other agents and how to write here, said again only when it changes]\n${TELEGRAM}\n\n[telegram] the morning report\n\n${CLOCK}`);
    // A person speaks in it next: who is here is new to the session, how to write is not.
    const spoke = await runner.run(person("and you?"));
    expect(spoke.text).toContain(situationOf(person("and you?")).who);
    expect(spoke.text).not.toContain(TELEGRAM);
    // The job's next run says nothing again, and leaves who is here as it was told: the person after it is not told again.
    expect((await runner.run(job("the evening report"))).text).toBe(`Done: [telegram] the evening report\n\n${CLOCK}`);
    expect((await runner.run(person("still there?"))).text).toBe(`Done: [telegram] Mira: still there?\n\n${CLOCK}`);
  });

  test("its instructions say when work is a mission's, where its chat can start one (0.8.5)", async () => {
    // Claude Code reads an MCP tool's description only once it looks the tool up: the rule has to be where it reads.
    const mission = { definitions: [{ name: "mission", description: "", parameters: {} }], get: () => undefined };
    const { runner, req, folder } = setup();
    await runner.run(req("one"));
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).not.toContain("more than about an hour");
    await runner.run(req("two", { toolset: mission } as unknown as Partial<TurnRequest>));
    const written = readFileSync(join(folder, "AGENTS.md"), "utf8");
    expect(written).toContain("Long work, more than about an hour, that goes on with little from the person goes to a mission: long development");
    expect(written).toContain("Shorter work is not a mission's: a few minutes is done here; longer, it goes to a helper or another agent in the background.");
    expect(written).toContain('With the `mission` tool: action "start" drafts it (a goal, a brief and checks that prove it done); "edit" changes the draft until the person starts it. Who signs it off: the person in this chat following the work');
  });

  test("its instructions say its CLI's own memory is not Nouride's, where memory_write is lent (0.8.10)", async () => {
    // Nix kept five notes in Claude Code's own memory for four days, read by that profile and no other agent.
    const memory = { definitions: [{ name: "memory_write", description: "", parameters: {} }], get: () => undefined };
    const { runner, req, folder } = setup();
    await runner.run(req("one"));
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).not.toContain("may keep a memory of its own");
    await runner.run(req("two", { toolset: memory } as unknown as Partial<TurnRequest>));
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toContain(
      "Your coding CLI may keep a memory of its own; Nouride and the other agents do not read it. What should last goes in MEMORY.md with `memory_write` (about=agent), and what you learn about a person with about=person.",
    );
  });

  test("its instructions name the work tool where the turn holds it", async () => {
    // Its tools deferred, an agent answered by Claude Code did not find `work` and tried the `nouride` CLI instead.
    const work = { definitions: [{ name: "work", description: "", parameters: {} }], get: () => undefined };
    const { runner, req, folder } = setup();
    await runner.run(req("one"));
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).not.toContain("`work`");
    await runner.run(req("two", { toolset: work } as unknown as Partial<TurnRequest>));
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toContain("The `work` tool shows your own missions, background jobs and approvals.");
  });

  test("a preset or model changed between turns reaches the session already open (0.8.1)", async () => {
    // Set only when a session opened: a chat moved off "Free in its folder" kept running unasked.
    runAgentCommandsThrough({ prefix: () => ["env"], put: () => [] });
    const { service, agent, runner, req } = setup({ permissions: "folder", model: "big" });
    await runner.run(req("one"));
    const external = agent.config.external as { permissions?: string; model?: string };
    external.permissions = "all";
    delete external.model;
    await runner.run(req("two"));
    await runner.run(req("three"));
    const connection = await service.connection(agent);
    // The CLI's own default back, as its session named it when it opened; each set once.
    expect(await stderrSaid(connection, (line) => line.startsWith("mode:") || line.startsWith("model:"), 4)).toEqual(["mode:yolo", "model:big", "mode:default", "model:small"]);
  });

  test("the idle sweep leaves a CLI whose turn is still opening its session (0.8.1)", async () => {
    // A turn counted only while it prompted: a sweep while it wrote the instructions or synced skills stopped the CLI.
    const { service, runner, req } = setup();
    const sync = service.syncSkills.bind(service);
    service.syncSkills = async (agent, cliRow) => {
      await service.stopIdle(Date.now() + 3_600_000);
      return sync(agent, cliRow);
    };
    expect((await runner.run(req("hello"))).text).toEndWith(`Mira: hello\n\n${CLOCK}`);
  });

  test("a conversation ended after its CLI has exited lets the session go without throwing (0.8.1)", async () => {
    const { service, agent, runner, req } = setup();
    await runner.run(req("first"));
    await (await service.connection(agent)).close("exited with code 137");
    expect(() => service.forgetSession("coder", "telegram:coder", "555")).not.toThrow();
    expect(service.keptSession("coder", "telegram:coder|555")).toBeUndefined();
  });

  test("an old \"not found\" on a running CLI's stderr does not make a later failure \"not installed\" (0.8.1)", async () => {
    const { service, runner, req } = setup({ mode: "overloaded" });
    await expect(runner.run(req("hello"))).rejects.toThrow("Fake CLI did not start: session/prompt: the model is overloaded");
    expect(service.unavailable("coder")).toBeNull();
  });

  test("an instruction file that is a link is left alone and not read; the turn goes on (0.8.1)", async () => {
    // Read with the daemon's rights, a link there read whatever it named into a file the agent's CLI reads.
    const { runner, req, steps, folder } = setup();
    const elsewhere = mkdtempSync(join(tmpdir(), "external-elsewhere-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "notes.txt"), "not the agent's");
    symlinkSync(join(elsewhere, "notes.txt"), join(folder, "AGENTS.md"));
    expect((await runner.run(req("hello"))).text).toEndWith(`Mira: hello\n\n${CLOCK}`);
    expect(steps.some((step) => step.startsWith("note:could not write AGENTS.md") && step.includes("is a link"))).toBe(true);
    expect(readFileSync(join(elsewhere, "notes.txt"), "utf8")).toBe("not the agent's");
  });

  test("a conversation that ends — /new, /reset — lets its CLI session go: the next message opens a new one, the old closed", async () => {
    // The session was kept by the chat, so after /new the CLI went on with everything said before it — Nouride's
    // context empty, the CLI's not — and with the skills its session had opened with (0.8.1).
    const { service, runner, req } = setup();
    await runner.run(req("first"));
    await runner.run(req("second"));
    const connection = await service.connection({ config: { id: "coder", external: { cli: "fake" } }, dir: "" } as unknown as LoadedAgent);
    const opened = async (want: number) => (await stderrSaid(connection, (line) => line.startsWith("cwd:"), want)).length;
    expect(await opened(1)).toBe(1);
    service.forgetSession("coder", "telegram:coder", "555");
    await runner.run(req("after /new"));
    expect(await opened(2)).toBe(2);
    await eventually(() => connection.stderrTail.includes("closed:s1"), 4_000, "the old session closed in the CLI");
  });

  test("a CLI that is not signed in makes the agent unavailable, saying so; a turn that works clears it", async () => {
    const { service, runner, req } = setup({ mode: "auth" });
    await expect(runner.run(req("hello"))).rejects.toThrow("Fake CLI is not signed in. Sign in on the agent's Brain tab");
    expect(service.unavailable("coder")).toBe("Fake CLI is not signed in. Sign in on the agent's Brain tab");
    service.setUnavailable("coder", null);
    expect(service.unavailable("coder")).toBeNull();
  });

  test("a CLI that is not installed says how to install it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "external-missing-"));
    dirs.push(dir);
    mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
    const service = new ExternalAgents({
      rows: () => [{ ...row(), command: "no-such-cli-anywhere", args: [] }],
      workspaceDir: () => dir,
      secretsFor: () => ({}),
      sessions: { load: () => ({}), save: () => {} },
    });
    services.push(service);
    const agent = { config: { id: "coder", external: { cli: "fake" } }, dir } as unknown as LoadedAgent;
    const runner = service.runnerFor(agent, { approvals: {} } as unknown as ExecutorDeps)!;
    await expect(runner.run({ agent, toolset: { definitions: [], get: () => undefined }, history: [], userMessage: { role: "user", content: "hi" }, gatewayId: "g", chatId: "c" } as unknown as TurnRequest)).rejects.toThrow("Fake CLI is not installed here: it is a test");
    expect(service.unavailable("coder")).toContain("is not installed here");
  });
});

describe("what an external agent's CLI says by itself, between turns (0.8.6)", () => {
  // Claude Code goes on by itself when a command it left running ends, with no prompt running; Nouride dropped what it
  // said, so Nix's "I'll tell you when it is done" never came (the live box, 2026-10-27).
  const woken = (service: ExternalAgents) => {
    const chats: OwnChat[] = [];
    service.onOwnWords = (chat) => void chats.push(chat);
    return chats;
  };

  test("wakes the agent's own chat once, and the turn woken for it says it, prompting nothing", async () => {
    const { service, runner, req, steps } = setup({ mode: "background", quietMs: 150 });
    const chats = woken(service);
    expect((await runner.run(req("build it", { chatType: "dm" }))).text).toBe("Started it.");
    await eventually(() => chats.length > 0, 4_000, "the chat to be woken");
    expect(chats).toEqual([{ agentId: "coder", gatewayId: "telegram:coder", chatId: "555" }]);
    steps.length = 0;
    const followed = await runner.run(req("[went on by itself]", { systemEvent: true, ownWords: true }));
    expect(followed.text).toStartWith("Finished: ");
    expect(followed.text).toEndWith(`Mira: build it\n\n${CLOCK}`);
    // Nothing was prompted: the CLI answers a prompt with "Started it." and goes on again.
    expect(followed.iterations).toBe(0);
    expect(steps).toEqual(["tool:cat out.log", "tool_done:Read ok"]);
    expect(followed.messages.map((message) => `${message.role}:${message.content}`).slice(-2)).toEqual(["user:[went on by itself]", `assistant:${followed.text}`]);
    expect(chats).toHaveLength(1);
  });

  test("a prompt that opens before that turn reads what it said first, as a message of its own, and the woken turn says nothing", async () => {
    const posted: string[] = [];
    // What it left running is let go when its words come (`LeftRunning.reported`) — the sign they have: the chat is woken
    // at its first step, and a busy machine can read the words a moment after (flaky until 0.8.10).
    let running = 0;
    const left = { saved: {} as Record<string, OwnChat>, load: () => ({}), save: (now: Record<string, OwnChat>) => void (left.saved = now) };
    const { service, runner, req } = setup({ mode: "background", quietMs: 150, onPreamble: async (words) => (posted.push(words), true), commandsUnder: () => running, left, onText: () => void (running = 1) });
    const chats = woken(service);
    await runner.run(req("build it"));
    expect(Object.keys(left.saved)).toEqual(["coder|s1"]);
    await eventually(() => chats.length > 0 && Object.keys(left.saved).length === 0, 4_000, "the CLI to have said what came of it");
    const next = await runner.run(req("and now?"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toStartWith("Finished: ");
    expect(posted[0]).toEndWith(`Mira: build it\n\n${CLOCK}`);
    expect(next.text).toBe("Started it.");
    expect(next.messages.at(-1)?.content).toBe(`${posted[0]}\n\nStarted it.`);
    const late = await runner.run(req("[went on by itself]", { systemEvent: true, ownWords: true }));
    expect(late.text).toBe("");
  });

  test("a session another agent asked it in, or a mission's, wakes nothing: its words wait for that session's next prompt", async () => {
    for (const where of [{ asked: true }, { gatewayId: "web:mission", chatId: "msn_1" }] as Partial<TurnRequest>[]) {
      const { service, agent, runner, req } = setup({ mode: "background", quietMs: 150 });
      const chats = woken(service);
      await runner.run(req("build it", where));
      const connection = await service.connection(agent);
      await eventually(() => connection.stderrTail.includes("went-on:s1"), 4_000, "the CLI to have gone on by itself");
      expect(chats).toEqual([]);
      const next = await runner.run(req("and now?", where));
      expect(next.text).toStartWith("Finished: ");
      expect(next.text).toEndWith("Started it.");
    }
  });

  test("one agent's words are never another's, though both CLIs number their sessions alike", async () => {
    const { service, agent, runner, req } = setup({ mode: "background", quietMs: 150 });
    const chats = woken(service);
    await runner.run(req("build it"));
    await eventually(() => chats.length > 0, 4_000, "the chat to be woken");
    mkdirSync(privateWorkspace(agent.dir, "other"), { recursive: true });
    const other = { ...agent, config: { ...agent.config, id: "other", displayName: "Other" } } as LoadedAgent;
    const theirs = await service.runnerFor(other, { approvals: {}, onActivity: () => {} } as unknown as ExecutorDeps)!.run(req("hi", { agent: other, gatewayId: "telegram:other" }));
    expect(theirs.text).toBe("Started it.");
  });

  test("a reopened session's history, replayed as it opens, is not something it says now", async () => {
    const { service, runner, req } = setup({ mode: "background", quietMs: 150, kept: { "coder|telegram:coder|555": "s9" } });
    const chats = woken(service);
    const result = await runner.run(req("build it"));
    expect(result.text).toBe("Started it.");
    expect(chats).toEqual([]);
  });

  test("a conversation ended lets go of what its CLI said by itself", async () => {
    const { service, agent, runner, req } = setup({ mode: "background", quietMs: 150 });
    const chats = woken(service);
    await runner.run(req("build it"));
    await eventually(() => chats.length > 0, 4_000, "the chat to be woken");
    const sessionId = (await service.connection(agent)).sessionOf("telegram:coder|555")!;
    service.forgetSession("coder", "telegram:coder", "555");
    expect(service.ownWords.take(ownKey("coder", sessionId))).toEqual([]);
  });

  test("the idle sweep leaves a CLI that still runs a command it started, a restart waits for it, and it is stopped once that has ended", async () => {
    let running = 1;
    const { service, agent, runner, req } = setup({ commandsUnder: () => running });
    await runner.run(req("hello"));
    const connection = await service.connection(agent);
    expect(await service.stopIdle(Date.now() + 3_600_000)).toBe(0);
    expect(connection.closed).toBeNull();
    // And a restart waits for it, as for a background job — and for what the CLI says of it, seconds after it ends.
    const left = [{ id: "cli:coder", command: "coder's Fake CLI", startedAt: connection.lastUsed }];
    expect(service.working(1_000_000)).toEqual(left);
    running = 0;
    expect(service.working(1_029_000)).toEqual(left);
    expect(service.working(1_031_000)).toEqual([]);
    expect(await service.stopIdle(Date.now() + 3_600_000)).toBe(1);
  });

  describe("a command it left running, which a stop cut off", () => {
    /** The file the daemon keeps them in, in memory, saved as the service saves it. */
    const disk = (initial: Record<string, OwnChat> = {}) => {
      let saved = initial;
      return { load: () => saved, save: (left: Record<string, OwnChat>) => void (saved = left), now: () => saved };
    };
    const chat = { agentId: "coder", gatewayId: "telegram:coder", chatId: "555" };

    test("is kept on disk from the prompt that left it running, and let go once it ends", async () => {
      let running = 0;
      const left = disk();
      const { service, runner, req } = setup({ commandsUnder: () => running, left, onText: () => void (running = 1) });
      await runner.run(req("build it in the background"));
      expect(left.now()).toEqual({ "coder|s1": chat });
      running = 0;
      service.working(Date.now() + 60_000);
      expect(left.now()).toEqual({});
    });

    test("is let go once the CLI says what came of it", async () => {
      let running = 0;
      const left = disk();
      const { service, runner, req } = setup({ mode: "background", quietMs: 150, commandsUnder: () => running, left, onText: () => void (running = 1) });
      const chats = woken(service);
      await runner.run(req("build it"));
      expect(left.now()).toEqual({ "coder|s1": chat });
      expect(left.now()).toEqual({ "coder|s1": chat });
      // Woken at its first step; let go when its words come, which a busy machine reads a moment after (flaky until 0.8.10).
      await eventually(() => chats.length > 0 && Object.keys(left.now()).length === 0, 4_000, "the CLI to have said what came of it");
      expect(left.now()).toEqual({});
    });

    test("a prompt that leaves nothing new running, or an asked agent's, keeps nothing", async () => {
      let running = 1;
      let grows = false;
      const left = disk();
      const { runner, req } = setup({ commandsUnder: () => running, left, onText: () => void (grows && (running += 1)) });
      await runner.run(req("hello"));
      expect(left.now()).toEqual({});
      grows = true;
      // Another agent's chat: what its CLI left running there is the asker's to report.
      await runner.run(req("check", { asked: true, chatId: "556" }));
      expect(running).toBe(2);
      expect(left.now()).toEqual({});
    });

    test("is kept in a row that outlives the process, and an entry in it that is not a chat is dropped", () => {
      const rows = stateRows();
      cliLeftRunningState(rows).save({ "coder|s1": chat });
      expect(cliLeftRunningState(rows).load()).toEqual({ "coder|s1": chat });
      rows.set("cli-left-running", JSON.stringify({ "coder|s1": chat, "coder|s2": { agentId: "coder" }, "coder|s3": "555" }));
      expect(cliLeftRunningState(rows).load()).toEqual({ "coder|s1": chat });
    });

    test("what the last process left is told once, at the start, each chat once", () => {
      const left = disk({ "coder|s1": chat, "coder|s2": chat, "coder|s3": { ...chat, chatId: "556" } });
      const { service } = setup({ left });
      expect(service.interrupted()).toEqual([chat, { ...chat, chatId: "556" }]);
      expect(service.interrupted()).toEqual([]);
      expect(left.now()).toEqual({});
    });
  });
});

describe("the tokens a CLI's turn spent (0.8.7)", () => {
  test("what it reports over ACP is the turn's; what it does not report is unknown, not 0", async () => {
    const reported = setup({ mode: "usage" });
    expect((await reported.runner.run(reported.req("push the fix"))).externalTokens).toBe(1234);
    const silent = setup();
    const result = await silent.runner.run(silent.req("push the fix"));
    expect(result.externalTokens).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test("each prompt's report is recorded as the CLI's — its cache inside the input — and one it did not make is not (0.8.8)", async () => {
    const reported = setup({ mode: "usage" });
    const result = await reported.runner.run(reported.req("push the fix"));
    expect(reported.usages).toEqual([
      { inputTokens: 1000, outputTokens: 234, cachedInputTokens: 800, cacheCreationInputTokens: 100, cli: true, model: "small", agentId: "coder", provider: "fake" },
    ]);
    // The mission's count is the CLI's total as it was, once: recorded and counted from two places, never added up.
    expect(result.externalTokens).toBe(1234);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const silent = setup();
    await silent.runner.run(silent.req("push the fix"));
    expect(silent.usages).toEqual([]);
  });
});

describe("what a CLI's turn has spent while it runs (0.8.8)", () => {
  test("its running estimate is there for its conversation while the prompt runs, and gone when the turn ends", async () => {
    // A mission's token limit reads it every minute: msn_3d28e0's one prompt spent 140M tokens, seen only at its end.
    let during = -1;
    let elsewhere = -1;
    const run = setup({ mode: "usage", onAsk: () => {
      during = run.service.spentNow("coder", "telegram:coder", "555");
      elsewhere = run.service.spentNow("coder", "telegram:coder", "777");
    } });
    const told: string[] = [];
    run.service.onSpent = (agentId, gatewayId, chatId) => void told.push(`${agentId} ${gatewayId} ${chatId}`);
    await run.runner.run(run.req("push the fix"));
    // A mission reads its limits as it is told: once for each context the CLI said, with the conversation it is in.
    expect(told).toEqual(["coder telegram:coder 555"]);
    // The context it said before the step that asks: one model call's worth, its own conversation's only.
    expect(during).toBe(42_000);
    expect(elsewhere).toBe(0);
    expect(run.service.spentNow("coder", "telegram:coder", "555")).toBe(0);
  });
});

describe("what answers a CLI agent, as `/status` asks (0.8.8)", () => {
  test("the CLI, what answered its handshake, the model it opened on and the context it last said — per conversation", async () => {
    const { service, agent, runner, req } = setup({ mode: "usage" });
    // Before its first turn: nothing runs, no model is known, no context was said.
    expect(service.answering(agent, "telegram:coder", "555")).toEqual({ cli: "Fake CLI", running: null, model: null, context: null });
    await runner.run(req("push the fix"));
    expect(service.answering(agent, "telegram:coder", "555")).toEqual({
      cli: "Fake CLI",
      running: "fake-cli 9.9.9",
      model: { name: "small", by: "cli" },
      context: { used: 42_000, size: 200_000 },
    });
    // Another conversation's CLI session said nothing of its context.
    expect(service.answering(agent, "telegram:coder", "777")?.context).toBeNull();
    // A conversation that ended takes its context with it.
    service.forgetSession("coder", "telegram:coder", "555");
    expect(service.answering(agent, "telegram:coder", "555")?.context).toBeNull();
  });

  test("a model the pack sets is said as the pack's", () => {
    const { service, agent } = setup({ model: "big" });
    expect(service.answering(agent, "telegram:coder", "555")?.model).toEqual({ name: "big", by: "pack" });
  });
});
