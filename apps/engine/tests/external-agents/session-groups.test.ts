/**
 * What a coding CLI's session started and left running, for the mission that session was (`session-groups.ts`).
 *
 * The machine is a table of processes a test moves on as the code waits, sorted by the runtime's own `sortLeft`: what
 * is decided, which session is followed, how long its process is waited for, what is given to be ended and what is
 * named as left, is what is read. The processes are the ones measured on a live box with Claude Code: a session's own
 * process under the CLI, the shell a command leads its session in, what a command left when its shell ended, and a
 * build's daemon that set itself apart. The turn that opens a session is run against a coding CLI started as a real
 * process, whose children a test says.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { sortLeft, type GroupProcess } from "@nouride/runtime";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { SESSION_GONE_MS, SETTLE_MS, SessionGroups, type GroupOs } from "@/modules/external-agents/session-groups.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { clockDeps } from "./fixtures/clock.ts";
import { stderrSaid } from "./fixtures/stderr.ts";

const p = (pid: number, name: string, parent: number, group: number, session: number): GroupProcess => ({ pid, name, parent, group, session, started: `9${pid}` });
const claude = p(7010, "claude", 7001, 7001, 7001);
const tail = p(7189, "tail", 1, 7188, 7188);
const gradle = p(7300, "java", 1, 7300, 7300);

/** A machine of the test's own: the processes of each group, changed by `at` as the code waits. */
function machine(options: { refuses?: boolean; at?: (waited: number, table: Map<string, GroupProcess[]>) => void } = {}) {
  const table = new Map<string, GroupProcess[]>();
  const all = new Map<number, GroupProcess>();
  const said: string[] = [];
  let waited = 0;
  const os: GroupOs = {
    make: (name) => {
      said.push(`make ${name}`);
      if (options.refuses) return null;
      if (!table.has(name)) table.set(name, []);
      return name;
    },
    join: (dir, pid) => {
      said.push(`join ${dir} ${pid}`);
      const one = all.get(pid);
      if (one) table.get(dir)!.push(one);
      return true;
    },
    processes: (dir) => [...(table.get(dir) ?? [])],
    close: (dir) => {
      said.push(`close ${dir}`);
      return table.delete(dir);
    },
    sort: (processes, roots) => sortLeft(processes, roots, (group) => [...all.values()].filter((one) => one.group === group)),
    wait: async (ms) => {
      waited += ms;
      options.at?.(waited, table);
    },
  };
  return { os, table, said, has: (...processes: GroupProcess[]) => processes.forEach((one) => all.set(one.pid, one)), waited: () => waited };
}

describe("a session followed for the work it is", () => {
  test("the process the CLI started for it is moved into the work's group, made once", () => {
    const m = machine();
    m.has(claude);
    const groups = new SessionGroups(m.os);
    groups.follow("nix|mission:msn_1", "m-msn_1", [7010]);
    expect(m.said).toEqual(["make m-msn_1", "join m-msn_1 7010"]);
    expect(groups.followed("nix|mission:msn_1")).toBe(true);
    expect(m.table.get("m-msn_1")).toEqual([claude]);
  });

  test("a later session of the same work, opened after a failed turn, joins the same group", () => {
    const m = machine();
    const again = p(7050, "claude", 7001, 7001, 7001);
    m.has(claude, again);
    const groups = new SessionGroups(m.os);
    groups.follow("nix|mission:msn_1", "m-msn_1", [7010]);
    groups.follow("nix|mission:msn_1", "m-msn_1", [7050]);
    expect(m.said.filter((line) => line.startsWith("make"))).toEqual(["make m-msn_1"]);
    expect(m.table.get("m-msn_1")!.map((one) => one.pid)).toEqual([7010, 7050]);
  });

  test("where it cannot be told which process serves it, or the CLI started none, nothing is followed", () => {
    const m = machine();
    const groups = new SessionGroups(m.os);
    // Opened beside another session: a child born then is either's.
    groups.follow("nix|mission:msn_1", "m-msn_1", null);
    // A CLI that serves every session from the one process.
    groups.follow("kuro|mission:msn_2", "m-msn_2", []);
    expect(m.said).toEqual([]);
    expect(groups.followed("nix|mission:msn_1")).toBe(false);
    expect(groups.followed("kuro|mission:msn_2")).toBe(false);
  });

  test("where the commands have no cgroup, nothing is followed and nothing is answered for", async () => {
    const m = machine({ refuses: true });
    m.has(claude);
    const groups = new SessionGroups(m.os);
    groups.follow("nix|mission:msn_1", "m-msn_1", [7010]);
    expect(groups.followed("nix|mission:msn_1")).toBe(false);
    expect(await groups.left("nix|mission:msn_1")).toBeNull();
  });

  test("a process that ended before it could be read is nobody to wait for", async () => {
    const m = machine();
    // The CLI ran a check of its own as the session opened: gone by the time the group is read.
    const groups = new SessionGroups(m.os);
    groups.follow("nix|mission:msn_1", "m-msn_1", [7005]);
    expect(await groups.left("nix|mission:msn_1")).toEqual({ left: [], apart: [] });
    // Nothing to wait out but what it kept: no session's process was ever there.
    expect(m.waited()).toBe(SETTLE_MS);
  });
});

describe("what a followed session left, its work over", () => {
  test("waits for the session's process to end and for what it kept to end with it, then gives what is left and what set itself apart", async () => {
    const shell = p(7400, "bash", 7010, 7400, 7400);
    const m = machine({
      at: (waited, table) => {
        // The session closes: its process ends at 600 ms, and the background shell it kept three seconds after.
        if (waited >= 600) table.set("m-msn_1", table.get("m-msn_1")!.filter((one) => one.pid !== 7010).map((one) => (one.pid === 7400 ? { ...one, parent: 1 } : one)));
        if (waited >= 600 + SETTLE_MS) table.set("m-msn_1", table.get("m-msn_1")!.filter((one) => one.pid !== 7400));
      },
    });
    m.has(claude, shell, tail, gradle);
    const groups = new SessionGroups(m.os);
    groups.follow("nix|mission:msn_1", "m-msn_1", [7010]);
    m.table.get("m-msn_1")!.push(shell, tail, gradle);
    const left = await groups.left("nix|mission:msn_1");
    expect(left).toEqual({
      left: [{ group: 7188, members: [{ pid: 7189, started: "97189", name: "tail" }] }],
      apart: [{ pid: 7300, started: "97300", name: "java" }],
    });
    expect(m.waited()).toBe(600 + SETTLE_MS);
    // Done with: the group is let go, and it answers for nothing twice.
    expect(m.said.at(-1)).toBe("close m-msn_1");
    expect(groups.followed("nix|mission:msn_1")).toBe(false);
    expect(await groups.left("nix|mission:msn_1")).toBeNull();
  });

  test("a session's process that does not end is waited for so long and no longer, and what it holds is left to it", async () => {
    const shell = p(7400, "bash", 7010, 7400, 7400);
    const build = p(7401, "node", 7400, 7400, 7400);
    const m = machine();
    m.has(claude, shell, build, tail);
    const groups = new SessionGroups(m.os);
    groups.follow("nix|mission:msn_1", "m-msn_1", [7010]);
    m.table.get("m-msn_1")!.push(shell, build, tail);
    const left = await groups.left("nix|mission:msn_1");
    // The command still at work under it is the CLI's; what an earlier command left is not.
    expect(left).toEqual({ left: [{ group: 7188, members: [{ pid: 7189, started: "97189", name: "tail" }] }], apart: [] });
    expect(m.waited()).toBe(SESSION_GONE_MS);
  });

  test("a conversation that was never followed answers nothing", async () => {
    expect(await new SessionGroups(machine().os).left("nix|telegram:nix:555")).toBeNull();
  });

  test("a machine that cannot be read is a line in the log: nothing is given, and the group is let go", async () => {
    const m = machine();
    m.has(claude);
    const groups = new SessionGroups({ ...m.os, sort: () => { throw new Error("no"); } });
    groups.follow("nix|mission:msn_1", "m-msn_1", [7010]);
    m.table.set("m-msn_1", []);
    expect(await groups.left("nix|mission:msn_1")).toBeNull();
    expect(m.said.at(-1)).toBe("close m-msn_1");
  });
});

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A coding CLI started as a real process; its children are what the test says they are at each look. */
function withCli(children: () => number[], install?: { dir: string; kept: Record<string, string>; opened: Record<string, string> }) {
  const dir = install?.dir ?? mkdtempSync(join(tmpdir(), "external-session-groups-"));
  if (!install) dirs.push(dir);
  mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
  const kept = install?.kept ?? {};
  // What each kept session opened on, kept across a restart as the daemon keeps it: without it a kept session is let go.
  const opened = install?.opened ?? {};
  const m = machine();
  const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", modes: { folder: "yolo", risky: "default", all: "default" }, instructionFile: "AGENTS.md" };
  const service = new ExternalAgents({
    rows: () => [row],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: { load: () => ({ ...kept }), save: (sessions) => void Object.assign(kept, sessions) },
    instructions: { load: () => ({ ...opened }), save: (instructions) => void Object.assign(opened, instructions) },
    // As boot says it: a mission's conversation is followed under its id, a chat's is not.
    followed: (gatewayId, chatId) => (gatewayId === "mission" ? `m-${chatId}` : null),
    groupOs: m.os,
    childrenOf: () => children(),
  });
  services.push(service);
  const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" } }, persona: { identity: "" }, dir } as unknown as LoadedAgent;
  const deps = { ...clockDeps, onText: () => {}, onActivity: () => {}, approvals: { available: true, request: async () => ({ status: "approved", by: "555", decision: "allow-once" }) } } as unknown as ExecutorDeps;
  const req = (extra: Partial<TurnRequest>) =>
    ({ agent, toolset: { definitions: [], get: () => undefined }, history: [], userMessage: { role: "user", content: "say hi" }, gateway: "telegram", gatewayId: "telegram:coder", chatId: "555", senderId: "555", senderName: "Mira", ...extra }) as unknown as TurnRequest;
  return { service, m, runner: service.runnerFor(agent, deps)!, req, folder: privateWorkspace(dir, "coder"), install: { dir, kept, opened } };
}

describe("a turn that opens a session", () => {
  test("a mission's: the process the CLI started while it opened is followed under the mission, and what it left is answered for", async () => {
    // The CLI's own children before the session opens, and after: the one born in between serves it.
    let looks = 0;
    const { service, m, runner, req, folder } = withCli(() => ((looks += 1) === 1 ? [7002] : [7002, 7010]));
    m.has(claude, tail);
    await runner.run(req({ gatewayId: "mission", chatId: "msn_1", workdir: join(folder, "missions", "msn_1") } as Partial<TurnRequest>));
    expect(m.said).toEqual(["make m-msn_1", "join m-msn_1 7010"]);
    // A second turn of the mission works in the session already open: nothing is opened, nothing moved.
    await runner.run(req({ gatewayId: "mission", chatId: "msn_1", workdir: join(folder, "missions", "msn_1") } as Partial<TurnRequest>));
    expect(m.said).toEqual(["make m-msn_1", "join m-msn_1 7010"]);
    // The mission over: what a command of its left is given, by the conversation.
    m.table.set("m-msn_1", [tail]);
    expect(await service.leftBy("coder", "mission", "msn_1")).toEqual({ left: [{ group: 7188, members: [{ pid: 7189, started: "97189", name: "tail" }] }], apart: [] });
  });

  test("a mission's session reopened after a restart: the process started for it joins the mission's group again", async () => {
    let looks = 0;
    const first = withCli(() => ((looks += 1) === 1 ? [7002] : [7002, 7010]));
    first.m.has(claude);
    const mission = { gatewayId: "mission", chatId: "msn_1", workdir: join(first.folder, "missions", "msn_1") } as Partial<TurnRequest>;
    await first.runner.run(first.req(mission));
    expect(Object.keys(first.install.kept)).toHaveLength(1);
    await first.service.stopAll();
    // The daemon again, over what it kept: the session is reopened, not made anew, by a CLI started anew.
    let again = 0;
    const second = withCli(() => ((again += 1) === 1 ? [8002] : [8002, 8010]), first.install);
    second.m.has(p(8010, "claude", 8001, 8001, 8001));
    await second.runner.run(second.req(mission));
    expect(second.m.said).toEqual(["make m-msn_1", "join m-msn_1 8010"]);
    // Reopened, by the CLI's own word: the session it kept, not a new one.
    const cli = await second.service.connection({ config: { id: "coder", external: { cli: "fake" } }, dir: first.install.dir } as unknown as LoadedAgent);
    expect(await stderrSaid(cli, (line) => line.startsWith("loaded:"), 1)).toHaveLength(1);
  });

  test("a chat's: nothing is followed, and nothing is answered for", async () => {
    // Its session's process is born as a mission's is: it is the conversation that is not followed.
    let looks = 0;
    const { service, m, runner, req } = withCli(() => ((looks += 1) === 1 ? [7002] : [7002, 7010]));
    m.has(claude);
    await runner.run(req({}));
    expect(looks).toBe(0);
    expect(m.said).toEqual([]);
    expect(await service.leftBy("coder", "telegram:coder", "555")).toBeNull();
  });

  test("two sessions opened at the same time: a process born then is either's, and neither is followed", async () => {
    let looks = 0;
    const { service, m, runner, req, folder } = withCli(() => ((looks += 1) <= 2 ? [7002] : [7002, 7010, 7011]));
    m.has(claude, p(7011, "claude", 7001, 7001, 7001));
    await Promise.all([
      runner.run(req({ gatewayId: "mission", chatId: "msn_1", workdir: join(folder, "missions", "msn_1") } as Partial<TurnRequest>)),
      runner.run(req({ gatewayId: "mission", chatId: "msn_2", workdir: join(folder, "missions", "msn_2") } as Partial<TurnRequest>)),
    ]);
    expect(m.said).toEqual([]);
    expect(await service.leftBy("coder", "mission", "msn_1")).toBeNull();
    expect(await service.leftBy("coder", "mission", "msn_2")).toBeNull();
  });
});
