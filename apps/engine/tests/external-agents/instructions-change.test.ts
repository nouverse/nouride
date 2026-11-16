/**
 * A persona change reaching a coding CLI already going (0.8.8). A CLI reads its instruction file as a session opens and
 * keeps what it read: Nox's SOUL.md, saved on the Files tab, was written into its instruction file and never reached the
 * session it was working in, and `agent reload` set the model in that session and nothing else. A session opened on
 * other instructions is now let go at its conversation's next turn, which opens one that reads them; a turn running then
 * is not cut off. Against the fake CLI, started as a real process.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { externalInstructionsState, externalSessionsState } from "@/commons/daemon-state.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import { stateRows } from "../helpers.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { registerAgentRoutes } from "@/modules/web/control/routes/agents.ts";
import { registerFileRoutes } from "@/modules/web/control/routes/files.ts";
import { eventually } from "../wait.ts";
import { stderrSaid } from "./fixtures/stderr.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const said = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** Each prompt says "Working.", takes `ms`, then "Done." — no permission asked; `env` another of the fake's modes. */
const row = (ms: number, env: Record<string, string> = {}): CliRow => ({
  id: "fake",
  name: "Fake CLI",
  command: process.execPath,
  args: [FAKE],
  install: "it is a test",
  versionArgs: ["--version"],
  profileEnv: "FAKE_HOME",
  env: { FAKE_MODE: "script", FAKE_SCRIPT: JSON.stringify([said("Working. "), { sleep: ms }, said("Done.")]), ...env },
  modes: { folder: "yolo", risky: "default", all: "default" },
  instructionFile: "AGENTS.md",
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "external-instructions-"));
  dirs.push(dir);
  mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
  return dir;
}

/** Each install's state rows, by its folder: a service made again over the same folder reads what the last one wrote. */
const states = new Map<string, StateRows>();
const stateOf = (dir: string): StateRows => states.get(dir) ?? states.set(dir, stateRows()).get(dir)!;

/** The service as boot makes it, its sessions and what they opened on in the database: a second one over the same is a restart. */
function start(dir: string, ms = 0, more: { env?: Record<string, string>; quietMs?: number; commandsUnder?: (pid: number) => number } = {}) {
  const service = new ExternalAgents({
    rows: () => [row(ms, more.env)],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: externalSessionsState(stateOf(dir)),
    instructions: externalInstructionsState(stateOf(dir)),
    ...(more.quietMs !== undefined ? { quietMs: more.quietMs } : {}),
    ...(more.commandsUnder ? { commandsUnder: more.commandsUnder } : {}),
  });
  services.push(service);
  return service;
}

/** The pack as a reload leaves it: a new object, the runner made for it at the turn, as the pipeline makes one. */
const agent = (dir: string, persona: Record<string, string> = {}) =>
  ({ config: { id: "coder", displayName: "Coder", external: { cli: "fake" } }, persona: { identity: "# IDENTITY\nCoder", soul: "Be brief.", ...persona }, dir }) as unknown as LoadedAgent;

const deps = { onActivity: () => {} } as unknown as ExecutorDeps;

function turn(service: ExternalAgents, pack: LoadedAgent, chatId: string, text: string, onText?: (delta: string) => void, over: Record<string, unknown> = {}, more: Partial<ExecutorDeps> = {}) {
  const req = {
    agent: pack,
    toolset: { definitions: [], get: () => undefined },
    history: [],
    userMessage: { role: "user", content: text },
    gateway: "telegram",
    gatewayId: "telegram:coder",
    chatId,
    senderId: "555",
    senderName: "Mira",
    ...over,
  } as unknown as TurnRequest;
  return service.runnerFor(pack, { ...deps, ...more, ...(onText ? { onText } : {}) } as ExecutorDeps)!.run(req);
}

const instructionFile = (dir: string) => readFileSync(join(privateWorkspace(dir, "coder"), "AGENTS.md"), "utf8");
/** What the CLI said of its sessions — opened (`cwd:`), reopened, closed — once `want` lines of them have come. */
const sessionsSaid = async (service: ExternalAgents, dir: string, want: number) =>
  (await stderrSaid(await service.connection(agent(dir)), (line) => /^(cwd|loaded|closed):/.test(line), want)).map((line) => line.replace(/^cwd:.*/, "opened"));

describe("a session opened on other instructions is let go at its conversation's next turn (0.8.8)", () => {
  test("a persona change between turns: the next turn opens a new session, after the file says it; the old one is closed", async () => {
    const dir = workspace();
    const service = start(dir);
    await turn(service, agent(dir), "555", "one");
    await turn(service, agent(dir), "555", "two");
    const cli = await service.connection(agent(dir));
    expect(cli.sessionOf("telegram:coder|555")).toBe("s1");

    // Saved on the Files tab, or approved through `persona`: the pack reloaded with it.
    const changed = agent(dir, { soul: "Be thorough." });
    expect((await turn(service, changed, "555", "three")).text).toBe("Working. Done.");
    expect(instructionFile(dir)).toContain("Be thorough.");
    expect(cli.sessionOf("telegram:coder|555")).toBe("s2");
    expect(service.keptSession("coder", "telegram:coder|555")).toBe("s2");
    expect(await sessionsSaid(service, dir, 3)).toEqual(["opened", "closed:s1", "opened"]);

    // The same instructions again: the new session is kept.
    await turn(service, agent(dir, { soul: "Be thorough." }), "555", "four");
    expect(cli.sessionOf("telegram:coder|555")).toBe("s2");
  });

  test("MEMORY.md alone keeps the session — the agent's own notes; `renew` lets every one go at its next turn", async () => {
    const dir = workspace();
    const service = start(dir);
    await turn(service, agent(dir), "555", "one");
    await turn(service, agent(dir, { memory: "## Learned\n- the build needs bun 1.4" }), "555", "two");
    const cli = await service.connection(agent(dir));
    expect(cli.sessionOf("telegram:coder|555")).toBe("s1");

    // `agent reload`, or a person's save of MEMORY.md: what the sessions opened on is no longer known.
    service.renew("coder");
    await turn(service, agent(dir, { memory: "## Learned\n- the build needs bun 1.4" }), "555", "three");
    expect(cli.sessionOf("telegram:coder|555")).toBe("s2");
    expect(instructionFile(dir)).toContain("the build needs bun 1.4");
  });

  test("a turn running when the persona changes is not cut off; another conversation's next turn opens anew meanwhile, and its own after it", async () => {
    const dir = workspace();
    const service = start(dir, 600);
    await turn(service, agent(dir), "111", "first in 111");
    await turn(service, agent(dir), "222", "first in 222");
    const cli = await service.connection(agent(dir));
    expect([cli.sessionOf("telegram:coder|111"), cli.sessionOf("telegram:coder|222")]).toEqual(["s1", "s2"]);

    let started = false;
    const running = turn(service, agent(dir), "222", "long one", () => void (started = true));
    await eventually(() => started, 4_000, "the turn in 222 working");
    const changed = agent(dir, { soul: "Be thorough." });
    service.renew("coder");
    await turn(service, changed, "111", "second in 111");
    expect(cli.sessionOf("telegram:coder|111")).toBe("s3");

    const result = await running;
    expect(result.text).toBe("Working. Done.");
    expect(result.stopReason).toBe("stop");
    expect(cli.stderrTail.filter((line) => line === "cancel:s2" || line === "closed:s2")).toEqual([]);

    await turn(service, changed, "222", "second in 222");
    expect(cli.sessionOf("telegram:coder|222")).toBe("s4");
    await eventually(() => cli.stderrTail.includes("closed:s2"), 4_000, "222's old session closed after its turn");
  });

  test("after a restart a kept session is reopened on the same instructions, and let go on others — an upgrade's harness text — or on none known", async () => {
    const dir = workspace();
    const first = start(dir);
    await turn(first, agent(dir), "555", "before the restart");
    await first.stopAll();
    expect(Object.keys(JSON.parse(stateOf(dir).get("external-instructions")!) as object)).toEqual(["coder|telegram:coder|555"]);

    // The same: reopened in the new process.
    const same = start(dir);
    await turn(same, agent(dir), "555", "after it");
    expect(await sessionsSaid(same, dir, 1)).toEqual(["loaded:s1"]);
    await same.stopAll();

    // What the session opened on is not what this version writes: a new one, the kept one not reopened.
    stateOf(dir).set("external-instructions", JSON.stringify({ "coder|telegram:coder|555": "an older harness" }));
    const upgraded = start(dir);
    await turn(upgraded, agent(dir), "555", "after the upgrade");
    expect(await sessionsSaid(upgraded, dir, 1)).toEqual(["opened"]);
    await upgraded.stopAll();

    // A session kept by a version that wrote none down.
    stateOf(dir).set("external-instructions", "{}");
    const unknown = start(dir);
    await turn(unknown, agent(dir), "555", "from 0.8.7");
    expect(await sessionsSaid(unknown, dir, 1)).toEqual(["opened"]);
  });
});

describe("what a session let go for other instructions does not cost (0.8.8, Nox's review)", () => {
  const CHAT_TOOLS = { definitions: [{ name: "mission" }, { name: "work" }], get: () => undefined };

  test("a scheduled job's turn in a chat, without the chat's tools, keeps that chat's session: the per-turn lines are not compared", async () => {
    const dir = workspace();
    const service = start(dir);
    await turn(service, agent(dir), "555", "chat one", undefined, { toolset: CHAT_TOOLS });
    await turn(service, agent(dir), "555", "the job's run", undefined, { systemEvent: true });
    await turn(service, agent(dir), "555", "chat two", undefined, { toolset: CHAT_TOOLS });
    const cli = await service.connection(agent(dir));
    expect(cli.sessionOf("telegram:coder|555")).toBe("s1");
    expect(cli.stderrTail.filter((line) => line.startsWith("closed:"))).toEqual([]);
  });

  test("a turn lent `work` or `mission` has the dashboard-links line in its instructions; a job's run without them has not (0.8.11)", async () => {
    const dir = workspace();
    const service = start(dir);
    await turn(service, agent(dir), "555", "chat one", undefined, { toolset: CHAT_TOOLS });
    expect(instructionFile(dir)).toContain("give the link your tool's result carries. Never write a dashboard address yourself");
    await turn(service, agent(dir), "555", "the job's run", undefined, { systemEvent: true });
    expect(instructionFile(dir)).not.toContain("Never write a dashboard address yourself");
  });

  test("what a session said by itself that no turn read is read in it first; it is let go at the turn after", async () => {
    const dir = workspace();
    const service = start(dir, 0, { env: { FAKE_MODE: "background", FAKE_LATER_MS: "300" }, quietMs: 150 });
    const mission = { gatewayId: "web:mission", chatId: "msn_1" };
    await turn(service, agent(dir), "msn_1", "build it", undefined, mission);
    const cli = await service.connection(agent(dir));
    await eventually(() => cli.stderrTail.includes("went-on:s1"), 4_000, "the CLI going on by itself");
    service.renew("coder");
    expect((await turn(service, agent(dir), "msn_1", "and now?", undefined, mission)).text).toStartWith("Finished: ");
    expect(cli.sessionOf("web:mission|msn_1")).toBe("s1");
    // At once, before its next going-on: it owes nothing now, and is let go.
    await turn(service, agent(dir), "msn_1", "next", undefined, mission);
    expect(await sessionsSaid(service, dir, 3)).toEqual(["opened", "closed:s1", "opened"]);
  });

  test("a command its prompt left running keeps the session while it runs; once it ended, the next turn lets it go", async () => {
    const dir = workspace();
    let commands = 0;
    // The report comes long after the test: the command is still running as far as the CLI says.
    const service = start(dir, 0, { env: { FAKE_MODE: "background", FAKE_LATER_MS: "60000" }, commandsUnder: () => commands });
    await turn(service, agent(dir), "555", "start the build", () => void (commands = 1));
    service.renew("coder");
    await turn(service, agent(dir), "555", "how is it going?");
    const cli = await service.connection(agent(dir));
    expect(cli.sessionOf("telegram:coder|555")).toBe("s1");
    expect(cli.stderrTail.filter((line) => line.startsWith("closed:"))).toEqual([]);
    commands = 0;
    await turn(service, agent(dir), "555", "done?");
    expect(cli.sessionOf("telegram:coder|555")).toBe("s2");
  });

  test("a /new between a turn's prompts closes its session once the turn is done with it, not under it", async () => {
    const dir = workspace();
    const service = start(dir);
    let steered = false;
    const steer = () => (steered ? null : ((steered = true), { role: "user", content: "and this too", timestamp: Date.now() }));
    // Said where the steer's answer is about to follow: the window between two prompts.
    const onPreamble = async () => (service.forgetSession("coder", "telegram:coder", "555"), true);
    const result = await turn(service, agent(dir), "555", "go", undefined, { steer }, { onPreamble } as Partial<ExecutorDeps>);
    const cli = await service.connection(agent(dir));
    expect(result.iterations).toBe(2);
    expect(result.text).toContain("Done.");
    expect(await sessionsSaid(service, dir, 2)).toEqual(["opened", "closed:s1"]);
    await turn(service, agent(dir), "555", "after /new");
    expect(cli.sessionOf("telegram:coder|555")).toBe("s2");
  });
});

describe("what lets an agent's sessions go by name (0.8.8)", () => {
  const principal = async (c: { set: (key: never, value: never) => void }, next: () => Promise<void>) => {
    c.set("principal" as never, { kind: "token", actor: "cli", role: "admin" } as never);
    await next();
  };

  test("`agent reload`: config and instructions both", async () => {
    const renewed: string[] = [];
    const app = new Hono();
    app.use("*", principal as never);
    registerAgentRoutes(app as never, { registry: { get: () => ({}), loadFailures: () => [], reload: async () => ({}) }, externalAgents: { renew: (id: string) => renewed.push(id) } } as never);
    expect((await app.request("/agents/nox/reload", { method: "POST" })).status).toBe(200);
    expect(renewed).toEqual(["nox"]);
  });

  test("a Files tab save of MEMORY.md, the one file its sessions are not compared by; not SOUL.md, which they are", async () => {
    const renewed: string[] = [];
    const app = new Hono();
    app.use("*", principal as never);
    registerFileRoutes(app as never, { files: { write: async () => ({ ok: true, reloaded: true }) }, externalAgents: { renew: (id: string) => renewed.push(id) } } as never);
    const save = (name: string) => app.request(`/agents/nox/files/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) });
    expect((await save("SOUL.md")).status).toBe(200);
    expect(renewed).toEqual([]);
    expect((await save("MEMORY.md")).status).toBe(200);
    expect(renewed).toEqual(["nox"]);
  });
});
