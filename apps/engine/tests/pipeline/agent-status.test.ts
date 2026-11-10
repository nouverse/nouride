/**
 * What an agent is doing now (0.7.18): waiting for you, working, paused or idle, worked out from what the daemon
 * holds — and why it could not work if asked. `/status` said `running` for an agent mid-answer, one stuck on an
 * approval and one with nothing to do alike.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@/cli/client.ts";
import { agentsCommand } from "@/cli/commands/agents.ts";
import { plain } from "../cli-harness.ts";
import { agentStatus, describeStatus } from "@/modules/pipeline/agent-status.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const idle = { state: "running" as const, enabled: true, turns: [], jobs: 0, missions: { atWork: 0, waiting: 0 }, waiting: 0, credential: true };
const chat = (chatId: string) => ({ gatewayId: "telegram:bot", chatId });

describe("which status wins", () => {
  test("waiting for you over working over asleep over idle — the one only a person can move first", () => {
    expect(agentStatus(idle).activity).toBe("idle");
    expect(agentStatus({ ...idle, state: "paused" }).activity).toBe("asleep");
    expect(agentStatus({ ...idle, state: "paused", jobs: 1 }).activity).toBe("working");
    expect(agentStatus({ ...idle, turns: [chat("1")] }).activity).toBe("working");
    expect(agentStatus({ ...idle, turns: [chat("1")], jobs: 2, waiting: 1 }).activity).toBe("waiting");
  });

  test("a mission at work is working, between its turns too; one waiting for a person is waiting for you (0.8.15)", () => {
    const at = (atWork: number, waiting = 0) => ({ atWork, waiting });
    expect(agentStatus({ ...idle, missions: at(1) }).activity).toBe("working");
    expect(agentStatus({ ...idle, state: "paused", missions: at(1) }).activity).toBe("working");
    expect(agentStatus({ ...idle, missions: at(1), waiting: 1 }).activity).toBe("waiting");
    expect(agentStatus({ ...idle, missions: at(0, 1) })).toMatchObject({ activity: "waiting", missionsWaiting: 1, waiting: 0 });
    expect(agentStatus({ ...idle, turns: [chat("1")], missions: at(1, 1) }).activity).toBe("waiting");
  });

  test("where it works is one entry per conversation", () => {
    expect(agentStatus({ ...idle, turns: [chat("1"), chat("1"), chat("2")] }).working).toEqual([chat("1"), chat("2")]);
  });
});

describe("unavailable", () => {
  test("is a reason beside a status, never a status: off in its pack, a pack that failed, a provider with no key", () => {
    expect(agentStatus({ ...idle, enabled: false })).toMatchObject({ activity: "idle", unavailable: "switched off in its pack" });
    expect(agentStatus({ ...idle, state: "error" }).unavailable).toBe("its pack failed to load");
    expect(agentStatus({ ...idle, credential: false }).unavailable).toBe("its model's provider has no credential");
    // Not known is not a fault.
    expect(agentStatus({ ...idle, credential: null }).unavailable).toBeNull();
  });

  test("an external agent's is its CLI's — not installed, not signed in — and its model profile's key is not asked about", () => {
    expect(agentStatus({ ...idle, credential: null, cli: "Claude Code is not signed in. Sign in on the agent's Brain tab" }).unavailable).toBe(
      "Claude Code is not signed in. Sign in on the agent's Brain tab",
    );
    expect(agentStatus({ ...idle, credential: null, cli: null }).unavailable).toBeNull();
    // A pack that is off is still off, whatever its CLI says.
    expect(agentStatus({ ...idle, enabled: false, cli: "omp is not installed here" }).unavailable).toBe("switched off in its pack");
  });
});

describe("in words", () => {
  test("the same line for /status and `nouride agents`", () => {
    expect(describeStatus(agentStatus(idle))).toBe("idle");
    expect(describeStatus(agentStatus({ ...idle, waiting: 2 }))).toBe("waiting for you (2 approvals)");
    expect(describeStatus(agentStatus({ ...idle, turns: [chat("1"), chat("2")], jobs: 1 }))).toBe("working (in 2 chats, 1 job)");
    expect(describeStatus(agentStatus({ ...idle, jobs: 1, missions: { atWork: 2, waiting: 0 } }))).toBe("working (1 job, 2 missions)");
    expect(describeStatus(agentStatus({ ...idle, waiting: 1, missions: { atWork: 0, waiting: 2 } }))).toBe("waiting for you (1 approval, 2 missions)");
    expect(describeStatus(agentStatus({ ...idle, missions: { atWork: 0, waiting: 1 } }))).toBe("waiting for you (1 mission)");
    expect(describeStatus(agentStatus({ ...idle, jobs: 1, credential: false }))).toBe("working (1 job) · unavailable: its model's provider has no credential");
  });
});

describe("what the pipeline reads it from", () => {
  let bench: Bench | undefined;
  afterEach(() => bench?.dispose());

  test("this agent's approvals and jobs, not another's", async () => {
    const waitingFor = new Set(["nouva"]);
    bench = await pipelineBench({
      agents: ["nouva", "nox"],
      deps: {
        approvals: { pending: (agentId?: string) => (agentId && waitingFor.has(agentId) ? [{ id: "a1" }] : []) } as never,
        jobs: { running: (agentId: string) => (agentId === "nox" ? [{ id: "j1" }, { id: "j2" }] : []) } as never,
      },
    });
    expect(bench.pipeline.agentStatus("nouva")).toMatchObject({ activity: "waiting", waiting: 1, jobs: 0, unavailable: null });
    expect(bench.pipeline.agentStatus("nox")).toMatchObject({ activity: "working", waiting: 0, jobs: 2 });
    waitingFor.clear();
    expect(bench.pipeline.agentStatus("nouva").activity).toBe("idle");
  });

  test("a command its coding CLI left running, and a mission at work, are working (0.8.15)", async () => {
    // Nix, on Claude Code, ran `sleep 30` in the CLI's own background: no turn, no job of Nouride's, and the Office put
    // it on the lobby's sofa until the CLI woke it (2026-11-03).
    let left = [{ id: "cli:nix", command: "nix's Claude Code", startedAt: 0 }];
    let atWork = new Map([["nox", { atWork: 1, waiting: 0 }], ["nouva", { atWork: 0, waiting: 1 }]]);
    bench = await pipelineBench({
      agents: ["nix", "nox", "nouva"],
      deps: {
        externalAgents: { runnerFor: () => null, working: () => left } as never,
        missionCommands: { load: () => ({ running: 0, atOnce: 2 }), forStatus: (agentId: string) => atWork.get(agentId) ?? { atWork: 0, waiting: 0 } } as never,
      },
    });
    expect(bench.pipeline.agentStatus("nix")).toMatchObject({ activity: "working", jobs: 1, missions: 0 });
    expect(bench.pipeline.agentStatus("nox")).toMatchObject({ activity: "working", jobs: 0, missions: 1 });
    expect(bench.pipeline.agentStatus("nouva")).toMatchObject({ activity: "waiting", missions: 0, missionsWaiting: 1 });
    left = [];
    atWork = new Map();
    expect(bench.pipeline.agentStatus("nix").activity).toBe("idle");
    expect(bench.pipeline.agentStatus("nox").activity).toBe("idle");
    expect(bench.pipeline.agentStatus("nouva").activity).toBe("idle");
  });
});

describe("`nouride agents`", () => {
  test("says what each agent is doing, and the pack's state from a daemon too old to say", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
    const row = { displayName: "N", enabled: true, state: "running", provider: "gate", model: "m", tools: [], skills: [] };
    const status = { failures: [], agents: [{ ...row, id: "nouva", activity: agentStatus({ ...idle, waiting: 1 }) }, { ...row, id: "old" }] };
    try {
      await agentsCommand({ get: async () => status } as unknown as Client, []);
    } finally {
      log.mockRestore();
    }
    expect(lines).toContain("    waiting for you (1 approval) · gate/m");
    expect(lines).toContain("    state running · gate/m");
  });

  test("an external agent is shown by its CLI, the CLI's model and its profile, where another shows its model", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
    const row = { id: "coder", displayName: "Coder", enabled: true, state: "running", provider: "gate", model: "m", tools: [], skills: [], external: { cli: "omp", profile: "work" } };
    try {
      await agentsCommand({ get: async () => ({ failures: [], agents: [{ ...row, activity: agentStatus(idle) }] }) } as unknown as Client, []);
    } finally {
      log.mockRestore();
    }
    expect(lines).toContain("    idle · omp · its default model · profile work");
    // The CLI's own model, not the agent's `[llm]` (0.8.1).
    lines.length = 0;
    const named = { ...row, external: { cli: "claude-code", name: "Claude Code", profile: "work", model: null, cliDefault: "Opus 5.5" } };
    const set = { ...row, external: { cli: "codex", name: "Codex", profile: "work", model: "gpt-5.6-luna", cliDefault: "gpt-6-luna" } };
    const again = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
    try {
      await agentsCommand({ get: async () => ({ failures: [], agents: [named, set].map((agent) => ({ ...agent, activity: agentStatus(idle) })) }) } as unknown as Client, []);
    } finally {
      again.mockRestore();
    }
    expect(lines).toContain("    idle · Claude Code · Opus 5.5 (default) · profile work");
    expect(lines).toContain("    idle · Codex · gpt-5.6-luna · profile work");
  });
});
