/**
 * What a mission's commands left running ends with the mission.
 *
 * On a live box three build workers of a mission that had ended done ran on for eighteen hours, each at a whole core,
 * with no job on record. With real processes: a command's group is read as it ends (`@nouride/runtime`), kept for its
 * mission, and ended at the mission's end; a program that set itself apart is never touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeftRunning, ToolContext } from "@nouride/shared";
import { groupMembers, runCommand, signalGroup, stillLeft } from "@nouride/runtime";
import { GRACE_MS, GROUPS_KEPT, leftEndedNotice, MissionLeft, type LeftDeps } from "@/modules/missions/left-running.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { openAndMigrate } from "@/db/index.ts";
import { JobStore, type JobCompletion } from "@/modules/jobs/jobs.store.ts";
import { createExecTool } from "@/modules/tools/builtins/exec.ts";
import { missionLeft } from "@/boot/mission-left.ts";
import { childEnvOf } from "../helpers.ts";
import { eventually } from "../wait.ts";
import { missionsHarness } from "./harness.ts";

const RUN = { cwd: "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 };
const groups: number[] = [];
const strays: number[] = [];
afterEach(() => {
  for (const group of groups.splice(0)) signalGroup(group, "SIGKILL");
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
});

/** A command that ends at once and leaves `sleepers` behind in its group; what the run noted of it. */
async function leaves(script: string): Promise<{ left: LeftRunning | null; out: string }> {
  let left: LeftRunning | null = null;
  const run = await runCommand(["sh", "-c", script], { ...RUN, onLeft: (seen) => void (left = seen) });
  if (left) groups.push((left as LeftRunning).group);
  return { left, out: run.stdout };
}

// No wait between asking and making: a test holds what happens, not how long it takes.
const real: LeftDeps = { stillLeft, signal: signalGroup, signalAs: async () => {}, wait: async () => {} };

describe("what a command left running", () => {
  test("is read as it ends: the processes still in its own group, by name", async () => {
    const { left } = await leaves("sleep 41 > /dev/null 2>&1 & sleep 42 > /dev/null 2>&1 & exit 0");
    expect(left).not.toBeNull();
    expect(left!.members.map((one) => one.name).sort()).toEqual(["sleep", "sleep"]);
    expect(groupMembers(left!.group).map((one) => one.pid).sort()).toEqual(left!.members.map((one) => one.pid).sort());
  });

  test("nothing is noted of a command that left nothing", async () => {
    expect((await leaves("echo done")).left).toBeNull();
    expect((await leaves("sleep 0.05 & wait")).left).toBeNull();
  });

  test("a group is still the one seen only while a process seen in it lives: a later one of its number is nobody's", async () => {
    const { left } = await leaves("sleep 43 > /dev/null 2>&1 & exit 0");
    expect(stillLeft(left!).map((one) => one.name)).toEqual(["sleep"]);
    // The same number, another start: a process that came later. Nothing is proven, so nothing is handed back.
    expect(stillLeft({ group: left!.group, members: left!.members.map((one) => ({ ...one, started: "later" })) })).toEqual([]);
    expect(stillLeft({ group: 2_000_000_000, members: left!.members })).toEqual([]);
    expect(signalGroup(2_000_000_000, "SIGTERM")).toBe("gone");
  });
});

describe("a mission's end", () => {
  test("ends what its commands left, asked first and then made to, and says what by name", async () => {
    const left = new MissionLeft(real);
    const first = (await leaves("sleep 44 > /dev/null 2>&1 & sleep 45 > /dev/null 2>&1 & exit 0")).left!;
    // One that does not end when asked.
    const stubborn = (await leaves("(trap '' TERM; sleep 46 > /dev/null 2>&1) > /dev/null 2>&1 & exit 0")).left!;
    left.note("msn_a", first);
    left.note("msn_a", stubborn);
    expect(left.noted("msn_a")).toBe(2);
    const ended = await left.end({ id: "msn_a", agentId: "nix" });
    expect(ended.join(" ")).toContain("sleep");
    await eventually(() => groupMembers(first.group).length === 0 && groupMembers(stubborn.group).length === 0, 5_000, "both groups gone");
    expect(left.noted("msn_a")).toBe(0);
    // Nothing left to end the second time.
    expect(await left.end({ id: "msn_a", agentId: "nix" })).toEqual([]);
  });

  test("leaves another mission's, and what ended by itself meanwhile", async () => {
    const left = new MissionLeft(real);
    const other = (await leaves("sleep 47 > /dev/null 2>&1 & exit 0")).left!;
    const gone = (await leaves("sleep 0.2 > /dev/null 2>&1 & exit 0")).left;
    left.note("msn_other", other);
    if (gone) left.note("msn_a", gone);
    await eventually(() => !gone || groupMembers(gone.group).length === 0, 3_000, "the short one over");
    expect(await left.end({ id: "msn_a", agentId: "nix" })).toEqual([]);
    expect(groupMembers(other.group)).toHaveLength(1);
  });

  test("a program that set itself apart in a session of its own is never noted, and outlives the mission", async () => {
    // `setsid` is util-linux's: where there is none, nothing sets itself apart this way and there is nothing to hold.
    if (process.platform !== "linux") return;
    const { left, out } = await leaves("setsid sleep 48 > /dev/null 2>&1 & echo $!; exit 0");
    const pid = Number(out.trim());
    strays.push(pid);
    expect(left).toBeNull();
    const kept = new MissionLeft(real);
    expect(await kept.end({ id: "msn_a", agentId: "nix" })).toEqual([]);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  test("where the processes are the agent's own user's, the signal is sent as that agent", async () => {
    const sent: string[] = [];
    const left = new MissionLeft({
      stillLeft: (seen) => seen.members,
      signal: () => "refused",
      signalAs: async (agentId, group, signal) => void sent.push(`${agentId} ${group} ${signal}`),
      wait: async (ms) => void sent.push(`wait ${ms}`),
    });
    left.note("msn_a", { group: 4242, members: [{ pid: 4243, started: "1", name: "node" }, { pid: 4244, started: "1", name: "node" }, { pid: 4245, started: "2", name: "next-server" }] });
    expect(await left.end({ id: "msn_a", agentId: "nexa" })).toEqual(["node (2)", "next-server"]);
    expect(sent).toEqual(["nexa 4242 SIGTERM", `wait ${GRACE_MS}`, "nexa 4242 SIGKILL"]);
  });

  test("a failed signal is a line in the log, never a mission's end that throws", async () => {
    const left = new MissionLeft({ stillLeft: (seen) => seen.members, signal: () => { throw new Error("no"); }, signalAs: async () => {}, wait: async () => {} });
    left.note("msn_a", { group: 4242, members: [{ pid: 4243, started: "1", name: "node" }] });
    expect(await left.end({ id: "msn_a", agentId: "nexa" })).toEqual(["node"]);
  });

  test("only so many groups are kept for a mission: the oldest goes", () => {
    const left = new MissionLeft(real);
    for (let i = 0; i < GROUPS_KEPT + 5; i += 1) left.note("msn_a", { group: 10_000 + i, members: [] });
    expect(left.noted("msn_a")).toBe(GROUPS_KEPT);
  });

  test("the chat is told what was ended, and how to keep something running past a mission", () => {
    expect(leftEndedNotice("The site build (msn_ab12cd)", ["node (3)"])).toBe(
      "The site build (msn_ab12cd): 3 processes its commands had left running were ended with it (node (3)). To keep something running after a mission ends, start it as a service of its own: a process manager, a container, or the system's.",
    );
    expect(leftEndedNotice("Mission msn_ab12cd", ["sleep"])).toStartWith("Mission msn_ab12cd: 1 process its commands had left running was ended with it (sleep).");
  });
});

describe("the mission and the command", () => {
  test("a mission that ends, done, failed or stopped, is asked to end what its commands left; one that waits is not", async () => {
    const h = await missionsHarness();
    const done = await h.start();
    h.turn(done);
    h.missions.wait(h.store.get(done.id)!, "limit", "its turn limit");
    expect(h.endedLeft).toEqual([]);
    h.missions.end(h.store.get(done.id)!, "done");
    const stopped = await h.start();
    h.missions.end(h.store.get(stopped.id)!, "stopped", "stopped by Gading");
    const failed = await h.start();
    h.missions.end(h.store.get(failed.id)!, "failed", "its checks failed");
    expect(h.endedLeft).toEqual([`${done.id} done`, `${stopped.id} stopped`, `${failed.id} failed`]);
  });

  test("`exec` hands over what a command left where the turn gives a taker, and reads nothing where it gives none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-left-"));
    const taken: { chat: string; left: LeftRunning }[] = [];
    const asked: string[] = [];
    const tool = createExecTool({
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
      blocked: [],
      policy: { mode: "full", ask: "off", askFallback: "deny", sensitivePaths: "ask", allowlist: [], blocked: [] },
      childEnv: childEnvOf({}),
      // As the daemon wires it: a mission's own turn has a taker, any other has none.
      leftBy: (ctx) => (asked.push(ctx.gatewayId), ctx.gatewayId === MISSION_GATEWAY_ID ? (left) => void taken.push({ chat: ctx.chatId, left }) : undefined),
    } as Parameters<typeof createExecTool>[0]);
    const ctx = (gatewayId: string, chatId: string): ToolContext => ({ agentId: "nova", sessionId: "ses_1", chatId, gateway: "web", gatewayId, senderId: "dev", chatType: "dm", workspaceDir: dir, agentDir: dir, workspaceRoots: [dir], signal: new AbortController().signal });
    try {
      await tool.execute({ command: "sleep 51 > /dev/null 2>&1 & echo started" }, ctx(MISSION_GATEWAY_ID, "msn_a"));
      expect(taken.map((one) => `${one.chat} ${one.left.members.map((member) => member.name).join()}`)).toEqual(["msn_a sleep"]);
      groups.push(taken[0]!.left.group);
      const chat = await tool.execute({ command: "sleep 52 > /dev/null 2>&1 & echo $!" }, ctx("telegram:main", "814"));
      strays.push(Number(String(chat.content).match(/\d+/)?.[0]));
      expect(taken).toHaveLength(1);
      expect(asked).toEqual([MISSION_GATEWAY_ID, "telegram:main"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A long command is made a job without being asked, a build above all: on the box's sandbox a hundred jobs of one
  // mission each ended leaving a process, and the mission's end ended none of them.
  test("a mission's job that ends by itself hands over what it left; another chat's job, and one that was stopped, hand over nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-left-jobs-"));
    const db = await openAndMigrate(join(dir, "nouride.db"));
    const completions: JobCompletion[] = [];
    const jobs = new JobStore({ db, logDir: join(dir, "logs"), maxConcurrentPerAgent: 5, onComplete: (completion) => void completions.push(completion) });
    const taken: { chat: string; left: LeftRunning }[] = [];
    jobs.setLeftBy((job) => (job.gatewayId === MISSION_GATEWAY_ID ? (left) => void taken.push({ chat: job.chatId, left }) : undefined));
    const start = (gatewayId: string, chatId: string, script: string) => jobs.start({ agentId: "nova", gatewayId, chatId, argv: ["sh", "-c", script], sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } } });
    try {
      start(MISSION_GATEWAY_ID, "msn_a", "sleep 55 > /dev/null 2>&1 & echo built");
      await eventually(() => completions.length === 1, 8_000, "the mission's job over");
      expect(taken.map((one) => `${one.chat} ${one.left.members.map((member) => member.name).join()}`)).toEqual(["msn_a sleep"]);
      groups.push(taken[0]!.left.group);
      const other = start("telegram:main", "814", "sleep 56 > /dev/null 2>&1 & echo $!");
      await eventually(() => completions.length === 2, 8_000, "another chat's job over");
      strays.push(Number(readFileSync(other.logPath, "utf8").match(/\d+/)?.[0]));
      // Stopped while it runs: its whole group is ended, and there is nothing of it to hand over.
      const running = start(MISSION_GATEWAY_ID, "msn_a", "sleep 57 > /dev/null 2>&1 & sleep 58");
      jobs.kill(running.id, "the test");
      await eventually(() => completions.length === 3, 12_000, "the stopped job over");
      expect(taken).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // The daemon's own wiring (`boot/mission-left.ts`), with a real process: noted from a mission's turn alone, ended at
  // the mission's end, and its chat told.
  test("the daemon notes what a mission's own turn left, ends it as the mission ends, and tells its chat", async () => {
    const told: string[] = [];
    const wired = missionLeft({ asAgent: () => async () => undefined, tell: async (mission, text) => void told.push(`${mission.id}: ${text}`) });
    const ctx = (gatewayId: string, chatId: string) => ({ gatewayId, chatId }) as ToolContext;
    expect(wired.commandLeft(ctx("telegram:main", "814"))).toBeUndefined();
    const take = wired.commandLeft(ctx(MISSION_GATEWAY_ID, "msn_d20ba6b0706043ada14f"));
    expect(take).toBeDefined();
    const left = (await leaves("sleep 53 > /dev/null 2>&1 & exit 0")).left!;
    take!(left);
    wired.endLeft({ id: "msn_d20ba6b0706043ada14f", agentId: "nova", title: "The site build" } as never);
    await eventually(() => told.length > 0 && groupMembers(left.group).length === 0, 8_000, "ended and told");
    expect(told).toEqual(["msn_d20ba6b0706043ada14f: The site build (msn_d20ba6): 1 process its commands had left running was ended with it (sleep). To keep something running after a mission ends, start it as a service of its own: a process manager, a container, or the system's."]);
    // A mission that left nothing ends with no word of it.
    wired.endLeft({ id: "msn_other", agentId: "nova", title: null } as never);
    const boot = readFileSync(join(import.meta.dir, "../../src/boot/missions.ts"), "utf8");
    expect(boot).toContain("endLeft: left.endLeft,");
    expect(boot).toContain("commandLeft: left.commandLeft,");
    const machine = readFileSync(join(import.meta.dir, "../../src/boot/turn-machine.ts"), "utf8");
    // Both builders of `exec`: every agent's shared one, and a pack's own with its blocked patterns.
    expect(machine.match(/commandLeft: missions\.commandLeft,/g)).toHaveLength(2);
    // And the jobs: a long command is made one without being asked.
    expect(machine).toContain("wireJobs({ jobs, registry, config: () => ctx.config, pipeline, commandLeft: missions.commandLeft })");
    expect(told).toHaveLength(1);
  }, 15_000);
});
