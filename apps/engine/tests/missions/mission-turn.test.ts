/**
 * A mission's turns through the pipeline every chat uses: each starts from the mission's page and not from the turn
 * before it, holds the mission's own `mission` tool, runs as the person who started it, and parks a call that needs a
 * person instead of waiting on it — then the mission waits for that person when nothing else can move.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ApprovalRequest, MessageEnvelope, Tool } from "@nouride/shared";
import { MissionGateway, MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { Missions } from "@/modules/missions/missions.ts";
import type { MissionsDeps } from "@/modules/missions/deps.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { NotesStore } from "@/modules/notes/store.ts";
import type { ApprovalAsk, ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createDelegateTool } from "@/modules/tools/builtins/delegate.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { ExternalBrains } from "@/modules/pipeline/brain.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

/** A gate that parks: it records what was asked, names the request, and stops waiting at once — as a mission's turn asks it to. */
class ParkingGate implements ApprovalGate {
  readonly available = true;
  readonly asked: ApprovalAsk[] = [];
  async request(ask: ApprovalAsk): Promise<ApprovalOutcome> {
    this.asked.push(ask);
    await ask.asking?.("apr_test");
    return { status: "expired", stillAnswerable: true };
  }
  pending(): ApprovalRequest[] {
    return this.asked.map((ask) => ({ id: "apr_test", agentId: ask.agentId, chatId: ask.chatId, gateway: ask.gatewayId, tool: ask.tool, params: ask.params, status: "pending", requestedAt: 0 }) as unknown as ApprovalRequest);
  }
  canAsk(): boolean {
    return true;
  }
  expireAll(): number {
    return 0;
  }
}

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["write", "plan"]\napproval_required = ["write"]\n';
/** The page this request carries: the user message a mission's turn is given, past the daemon's own framing. */
const lastUser = (body: { messages: { role: string; content: unknown }[] }) =>
  String(body.messages.filter((m) => m.role === "user" && String(m.content).includes("MISSION")).at(-1)?.content ?? "");

const PARKS: NonNullable<Parameters<typeof pipelineBench>[0]>["turns"] = [
  // A step finished before the park, so a second turn follows — one that starts with the call still parked.
  { toolCalls: [{ id: "p1", name: "plan", args: { steps: [{ text: "read the brief", state: "done" }, { text: "write the file", state: "active" }] } }] },
  { toolCalls: [{ id: "w1", name: "write", args: { path: "out.txt", content: "hello" } }] },
  { text: "Parked the write; nothing else to do." },
  { text: "Still waiting on the write." },
];

async function missionDaemon(turns = PARKS, pack = PACK, extraTools: Tool[] = [], externalAgents?: ExternalBrains, prepare: MissionsDeps["prepare"] = async () => {}, security: Record<string, unknown> = {}) {
  const gate = new ParkingGate();
  const told: string[] = [];
  let missions!: Missions;
  let bench!: Bench;
  const gateway = new FakeGateway();
  bench = await pipelineBench({
    turns,
    agentToml: pack,
    config: { security: { approvals: "careful", ...security } },
    gateways: [gateway, new MissionGateway()],
    deps: ({ db, dataDir }) => {
      const notes = new NotesStore(join(dataDir, "notes"));
      missions = new Missions({
        store: new MissionStore(db),
        settings: () => ({ perAgent: 1, maxRunning: 2, limitHours: 8, limitTurns: 50, limitTokens: 50_000_000 }),
        agents: { exists: () => true, asleep: () => false, privateDir: () => join(dataDir, "private", "nouva") },
        notes,
        parked: (mission) => gate.pending().filter((request) => request.chatId === mission.id).map((request) => ({ id: request.id, what: request.tool })),
        tell: async (_mission, text) => void told.push(text),
        queueTurn: (envelope: MessageEnvelope) => bench.pipeline.queueTurn(envelope),
        stopTurn: () => {},
        branchRefusal: async () => null,
        prepare,
        check: async () => ({ passed: true, failed: null }),
      });
      return { approvals: gate, notes, shaper: missions, missionTools: createMissionTools(missions), ...(externalAgents ? { externalAgents } : {}) };
    },
  });
  benches.push(bench);
  const tools = createBuiltinTools({ security: bench.config.security, notes: (bench.pipeline as unknown as { deps: { notes: NotesStore } }).deps.notes });
  for (const tool of extraTools) tools.set(tool.definition.name, tool);
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  return { bench, gate, told, gateway, missions: () => missions };
}

describe("when work is a mission's (0.8.5)", () => {
  test("a chat's turn is told when work is a mission's, and a mission's own turn is not", async () => {
    // The rule (0.8.5; by example and as a draft since 0.8.11), in the harness and not only in the tool's description.
    const d = await missionDaemon([{ text: "On it." }, { text: "Still waiting on the write." }]);
    d.gateway.receive(envelope({ text: "refactor the whole module", timestamp: Date.now() }));
    await d.bench.pipeline.idle();
    const chat = JSON.stringify(d.bench.requests[0]?.messages[0]);
    expect(chat).toContain("Long work, more than about an hour, that goes on with little from the person goes to a mission");

    const started = d.missions().start({ agentId: "nouva", goal: "write hello into out.txt", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    await eventually(() => d.bench.requests.length > 1, 6_000, "the mission's first turn");
    expect(JSON.stringify(d.bench.requests[1]?.messages[0])).not.toContain("more than about an hour");
  });
});

describe("the language a mission's turn writes in", () => {
  test("a chat's turn is asked for its first words in the person's language, a mission's own turn is not", async () => {
    // Nobody reads a mission's turn as it runs and no preamble is wired there, yet the harness asked every one of its
    // turns to open with a sentence in the person's language, beside a page asking for all of it in English.
    const opening = "start your first reply with one short sentence saying what you are about to do, in the person's language";
    const d = await missionDaemon([{ text: "On it." }, { text: "Still waiting on the write." }]);
    d.gateway.receive(envelope({ text: "refactor the whole module", timestamp: Date.now() }));
    await d.bench.pipeline.idle();
    const chat = JSON.stringify(d.bench.requests[0]?.messages[0]);
    expect(chat).toContain(opening);
    expect(chat).toContain("Your working language is English");

    const started = d.missions().start({ agentId: "nouva", goal: "write hello into out.txt", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    await eventually(() => d.bench.requests.length > 1, 6_000, "the mission's first turn");
    const mission = JSON.stringify(d.bench.requests[1]?.messages[0]);
    expect(mission).not.toContain(opening);
    expect(mission).toContain("Your working language is English");
  });
});

describe("a mission's turn", () => {
  test("starts from its page, holds the mission's own actions, runs as its person, and parks what needs one", async () => {
    const d = await missionDaemon();
    const started = d.missions().start({ agentId: "nouva", goal: "write hello into out.txt", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    const id = started.mission.id;
    await eventually(() => d.missions().get(id)?.status === "waiting", 6_000, "the mission waiting for its person");

    const [first, , third, fourth] = d.bench.requests;
    expect(lastUser(first)).toContain(`MISSION ${id}: turn 1 of at most 50`);
    const mission = first.tools.find((tool: { function: { name: string } }) => tool.function.name === "mission");
    expect(mission.function.parameters.properties.action.enum).toEqual(["done", "ask", "fail", "start"]);

    // Parked, not waited on — answerable for a day — and asked as the person who started the mission.
    const [ask] = d.gate.asked;
    expect(ask).toMatchObject({ tool: "write", gatewayId: MISSION_GATEWAY_ID, chatId: id, senderId: "u1", waitMs: 0, answerableMs: 24 * 60 * 60_000 });
    const result = third.messages.find((m: { role: string; content: unknown }) => m.role === "tool" && String(m.content).includes("Parked"));
    expect(String(result.content)).toContain("Parked as approval #apr_test");

    // The second turn starts from the page again: nothing of the first turn's calls is in it.
    expect(lastUser(fourth)).toContain("MISSION");
    expect(JSON.stringify(fourth.messages)).not.toContain("write the file\",\"state\":\"active");
    expect(fourth.messages.some((m: { role: string }) => m.role === "tool")).toBe(false);
    expect(lastUser(fourth)).toContain("Parked approvals: #apr_test");

    const waiting = d.missions().get(id)!;
    expect(waiting.waitKind).toBe("approval");
    expect(d.told.at(-1)).toContain("needs you");
  });

  test("hands its folder to the turn's brain, where an external agent's CLI works", async () => {
    const folders: (string | undefined)[] = [];
    const recording: ExternalBrains = { runnerFor: (_agent, deps) => ({ run: (req) => (folders.push(req.workdir), new TurnExecutor(deps).run(req)) }) };
    const d = await missionDaemon([{ text: "Looked around." }], PACK, [], recording);
    const started = d.missions().start({ agentId: "nouva", goal: "look around", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    await eventually(() => folders.length > 0, 6_000, "the mission's first turn");
    expect(folders[0]).toBe(started.mission.workdir);
  });

  test("in a worktree of its own, offers `delegate` its `isolated`; in its folder, not (0.8.1)", async () => {
    const pack = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["plan", "delegate"]\n';
    const delegate = createDelegateTool({ run: async () => ({}) as never, isolate: async () => ({ refused: "unused" }) });
    const offered = async (prepare?: MissionsDeps["prepare"]) => {
      const d = await missionDaemon([{ text: "Looked around." }], pack, [delegate], undefined, prepare);
      const started = d.missions().start({ agentId: "nouva", goal: "look around", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
      if ("refused" in started) throw new Error(started.refused);
      await eventually(() => d.bench.requests.length > 0, 6_000, "the mission's first turn");
      const tool = d.bench.requests[0].tools.find((t: { function: { name: string } }) => t.function.name === "delegate");
      return Object.keys(tool.function.parameters.properties);
    };
    expect(await offered(async (mission) => `/srv/nouride/agents/nouva/missions/${mission.id}/worktree/app`)).toContain("isolated");
    expect(await offered()).not.toContain("isolated");
  });

  test("ends at its claim: the call after it is never asked for", async () => {
    // A model told "end your turn now" went on for 30 calls on the live box, re-claiming and reading its mission back.
    const d = await missionDaemon([
      { toolCalls: [{ id: "d1", name: "mission", args: { action: "done", summary: "out.txt holds hello.", report: "Wrote out.txt." } }] },
      { toolCalls: [{ id: "p1", name: "plan", args: { steps: [{ text: "check again", state: "active" }] } }] },
      { text: "Checked again." },
    ]);
    const started = d.missions().start({ agentId: "nouva", goal: "write hello into out.txt", checks: ["true"], review: false, startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    const id = started.mission.id;
    await eventually(() => d.missions().get(id)?.status === "done", 6_000, "the mission done");

    expect(d.bench.requests).toHaveLength(1);
    const [turn] = d.bench.turns.forChat(MISSION_GATEWAY_ID, id);
    expect(turn?.reply).toBe("Done: out.txt holds hello.");
  });

  test("after a call is parked, three more rounds — then the turn ends, and with no step moved the mission waits", async () => {
    // On the live box a mission read its pending approval every five seconds for minutes, told not to.
    const reads = Array.from({ length: 6 }, (_, i) => ({ toolCalls: [{ id: `r${i}`, name: "read", args: { path: `poll-${i}.txt` } }] }));
    const d = await missionDaemon(
      [{ toolCalls: [{ id: "w1", name: "write", args: { path: "out.txt", content: "hello" } }] }, ...reads],
      '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["write", "read", "plan"]\napproval_required = ["write"]\n',
    );
    const started = d.missions().start({ agentId: "nouva", goal: "write hello into out.txt", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    await eventually(() => d.missions().get(started.mission.id)?.status === "waiting", 6_000, "the mission waiting for its person");

    // The parking round and three after it; no fifth request, and no wrap-up call either.
    expect(d.bench.requests).toHaveLength(4);
    expect(d.missions().get(started.mission.id)!.waitKind).toBe("approval");
  });

  test("the turn after one that parked a call starts with the same few rounds", async () => {
    const PACK_READS = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["write", "read", "plan"]\napproval_required = ["write"]\n';
    const read = (i: number) => ({ toolCalls: [{ id: `r${i}`, name: "read", args: { path: `poll-${i}.txt` } }] });
    const d = await missionDaemon(
      [
        { toolCalls: [{ id: "p1", name: "plan", args: { steps: [{ text: "write the notes", state: "done" }, { text: "write out.txt", state: "active" }] } }] },
        { toolCalls: [{ id: "w1", name: "write", args: { path: "out.txt", content: "hello" } }] },
        read(1), read(2), read(3),
        // A step finished in that turn, so the mission goes on — into a turn that starts with the call still parked.
        read(4), read(5), read(6),
        read(7), read(8),
      ],
      PACK_READS,
    );
    const started = d.missions().start({ agentId: "nouva", goal: "write hello into out.txt", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    await eventually(() => d.missions().get(started.mission.id)?.status === "waiting", 6_000, "the mission waiting for its person");

    // Five rounds in the first turn, three in the second; then no step finished, and it waits.
    expect(d.bench.requests).toHaveLength(8);
    expect(d.missions().get(started.mission.id)!).toMatchObject({ waitKind: "approval", turnsUsed: 2 });
  });
  test("what one turn read from outside, every later turn of the mission starts as having read (S13)", async () => {
    // Each turn starts fresh, so the mark ended with the turn that read the page — and with it the guards put on
    // what follows outside content: a memory write after a page asks a person, which a later turn wrote in silence.
    const seen: (readonly string[] | undefined)[] = [];
    const peek: Tool = {
      definition: { name: "peek", description: "Read a page.", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: async () => ({ content: "a page from outside", isError: false, untrusted: true }),
    };
    const probe: Tool = {
      definition: { name: "probe", description: "Look around.", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: async (_args, ctx) => {
        seen.push(ctx.untrustedRead);
        return { content: "ok", isError: false };
      },
    };
    const d = await missionDaemon(
      [
        { toolCalls: [{ id: "p1", name: "plan", args: { steps: [{ text: "read the page", state: "done" }, { text: "act on it", state: "active" }] } }] },
        { toolCalls: [{ id: "k1", name: "peek", args: {} }] },
        { text: "Read it." },
        // A step finished, so a second turn follows — one that never read anything itself.
        { toolCalls: [{ id: "q1", name: "probe", args: {} }] },
        { toolCalls: [{ id: "f1", name: "mission", args: { action: "fail", reason: "stop here", report: "Read the page." } }] },
      ],
      '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["plan", "peek", "probe"]\n',
      [peek, probe],
    );
    const started = d.missions().start({ agentId: "nouva", goal: "read the page and act on it", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    expect(started.mission.untrusted).toBe(false);
    await eventually(() => d.missions().get(started.mission.id)?.status === "failed", 6_000, "the mission ended");

    expect(d.missions().get(started.mission.id)!.untrusted).toBe(true);
    expect(seen).toEqual([["outside content this mission read earlier"]]);
  });

  test("is the daemon's own: a pack's sender allowlist does not refuse it", async () => {
    // Its sender is `nouride:system`, which no allowlist names: refused, the mission stayed `running` with no turn, for good.
    const d = await missionDaemon([{ text: "Looked around." }], `${PACK}\n[security]\nsender_allowlist = ["telegram:main:u1"]\n`);
    const started = d.missions().start({ agentId: "nouva", goal: "look around", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    await eventually(() => d.bench.requests.length > 0, 6_000, "the mission's first turn");
  });

  test("is not counted against a sender's rate limit — every mission's sender is the daemon, on one connection", async () => {
    const d = await missionDaemon(
      [
        { toolCalls: [{ id: "p1", name: "plan", args: { steps: [{ text: "look", state: "done" }, { text: "stop", state: "active" }] } }] },
        { text: "Looked." },
        { toolCalls: [{ id: "f1", name: "mission", args: { action: "fail", reason: "stop here", report: "Looked." } }] },
      ],
      PACK,
      [],
      undefined,
      undefined,
      { rate_limit: { messages_per_minute: 1 } },
    );
    const started = d.missions().start({ agentId: "nouva", goal: "look, then stop", startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    // The second turn inside the same minute: refused as the second message of one sender, it was never run.
    await eventually(() => d.missions().get(started.mission.id)?.status === "failed", 6_000, "the mission's second turn");
  });
});
