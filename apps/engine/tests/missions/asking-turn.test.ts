/**
 * A mission's question through the pipeline every chat uses, with a scripted model: a plain `ask` ends the turn at the
 * call; one with `keep_working` lets the turn go on, the answer a person gives meanwhile is in the model's next request,
 * and a turn that ends with the question still open leaves the mission waiting.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { newId, type MessageEnvelope } from "@nouride/shared";
import { MissionGateway, MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { Missions } from "@/modules/missions/missions.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { toldBy } from "@/modules/missions/types.ts";
import { NotesStore } from "@/modules/notes/store.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

const QUESTION = "Mermaid adds 735 KB for one flowchart. Take it?";
const PLAN = { toolCalls: [{ id: "p1", name: "plan", args: { steps: [{ text: "the gallery", state: "done" }, { text: "the rest", state: "active" }] } }] };

/** A daemon's missions over a real pipeline, wired as boot wires them: their turns, and words into a turn at work. */
async function daemon(turns: NonNullable<Parameters<typeof pipelineBench>[0]>["turns"], before?: (request: number) => Promise<void>) {
  const told: string[] = [];
  let missions!: Missions;
  let bench!: Bench;
  let requests = 0;
  bench = await pipelineBench({
    turns,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["plan"]\n',
    gateways: [new FakeGateway(), new MissionGateway()],
    ...(before
      ? {
          fetch: (scripted: typeof fetch) =>
            (async (...args: Parameters<typeof fetch>) => {
              requests += 1;
              await before(requests);
              return await scripted(...args);
            }) as typeof fetch,
        }
      : {}),
    deps: ({ db, dataDir }) => {
      const notes = new NotesStore(join(dataDir, "notes"));
      missions = new Missions({
        store: new MissionStore(db),
        settings: () => ({ perAgent: 1, maxRunning: 2, limitHours: 8, limitTurns: 50, limitTokens: 50_000_000 }),
        agents: { exists: () => true, asleep: () => false, privateDir: () => join(dataDir, "private", "nouva") },
        notes,
        parked: () => [],
        tell: async (_mission, text) => void told.push(text),
        queueTurn: (envelope: MessageEnvelope) => bench.pipeline.queueTurn(envelope),
        stopTurn: () => {},
        steerTurn: (mission, words) => {
          const envelope: MessageEnvelope = { id: newId("msg"), timestamp: words.at, gateway: "web", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, chatType: "dm", senderId: SYSTEM_SENDER, senderName: toldBy(words), mentions: [mission.agentId], text: words.text, raw: { via: "tell", mission: mission.id, tell: words.id } };
          const outcome = bench.pipeline.steerInto(mission.agentId, mission.id, MISSION_GATEWAY_ID, envelope);
          return outcome === "taken" ? { taken: true, when: bench.pipeline.steerReach(mission.agentId) } : { taken: false, why: outcome };
        },
        answerReach: (mission) => bench.pipeline.steerReach(mission.agentId),
        branchRefusal: async () => null,
        prepare: async () => {},
        check: async () => ({ passed: true, failed: null }),
      });
      return { notes, shaper: missions, missionTools: createMissionTools(missions) };
    },
  });
  benches.push(bench);
  bench.pipeline.setTools(createBuiltinTools({ security: bench.config.security, notes: (bench.pipeline as unknown as { deps: { notes: NotesStore } }).deps.notes }));
  bench.pipeline.onToldRead((id, ids) => missions.toldRead(id, ids));
  bench.pipeline.attach();
  const start = () => {
    const started = missions.start({ agentId: "nouva", goal: "the viewers and the gallery", checks: ["true"], review: false, startedBy: "u1", gatewayId: "telegram:main", chatId: "chat-1" });
    if ("refused" in started) throw new Error(started.refused);
    return started.mission.id;
  };
  return { bench, told, missions: () => missions, start };
}

describe("a mission's question, through the pipeline", () => {
  test("a plain ask ends the turn at the call: the call after it is never asked for, and the mission waits", async () => {
    const d = await daemon([{ toolCalls: [{ id: "a1", name: "mission", args: { action: "ask", question: QUESTION } }] }, PLAN, { text: "Went on." }]);
    const id = d.start();
    await eventually(() => d.missions().get(id)?.status === "waiting", 6_000, "the mission waiting");
    expect(d.bench.requests).toHaveLength(1);
    expect(d.missions().get(id)).toMatchObject({ waitKind: "input" });
    expect(d.bench.turns.forChat(MISSION_GATEWAY_ID, id)[0]?.reply).toBe(`Asked: ${QUESTION}`);
    expect(d.told.filter((text) => text.includes(QUESTION))).toHaveLength(1);
  });

  test("with keep_working the turn goes on, and an answer given meanwhile is in the model's next request", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => void (release = resolve));
    const d = await daemon(
      [
        { toolCalls: [{ id: "a1", name: "mission", args: { action: "ask", question: QUESTION, keep_working: true } }] },
        PLAN,
        { toolCalls: [{ id: "d1", name: "mission", args: { action: "done", summary: "The gallery is in, and Mermaid with it.", report: "Both built." } }] },
      ],
      // The model is at work on its second request while the person reads the question and answers it.
      async (request) => (request === 2 ? await held : undefined),
    );
    const id = d.start();
    await eventually(() => d.told.some((text) => text.includes("asks, and works on meanwhile")), 6_000, "the question in the chat");
    // In the chat while the turn is at work, and the mission is not waiting.
    expect(d.missions().get(id)).toMatchObject({ status: "running", waitKind: null });
    expect(d.missions().answer(id, "ya, masukin", "Gading")).toMatchObject({ said: "Answered. It reads this before its next step.", where: "next_step" });
    release();
    await eventually(() => d.missions().get(id)?.status === "done", 6_000, "the mission done");

    expect(d.bench.requests).toHaveLength(3);
    // What the turn was told after asking, and then the answer, before its next step.
    expect(JSON.stringify(d.bench.requests[1])).toContain("the question is in their chat now, and this mission stays at work");
    const third = JSON.stringify(d.bench.requests[2]);
    expect(third).toContain("Gading told this mission while you were working");
    expect(third).toContain(`Answer to your question \\"${QUESTION}\\": ya, masukin`);
    // Read in that turn, and the mission never waited for it.
    expect(d.missions().get(id)!.told[0]).toMatchObject({ read: 1 });
    expect(d.told.filter((text) => text.includes("waits for it now"))).toEqual([]);
    expect(d.missions().get(id)!.waitedMs).toBe(0);
  });

  test("with keep_working and no answer, the turn does what it can and the mission then waits, said once", async () => {
    const d = await daemon([{ toolCalls: [{ id: "a1", name: "mission", args: { action: "ask", question: QUESTION, keep_working: true } }] }, PLAN, { text: "The gallery is in. The rest needs the answer." }]);
    const id = d.start();
    await eventually(() => d.missions().get(id)?.status === "waiting", 6_000, "the mission waiting");
    // The turn went past the ask: three requests, the checklist moved.
    expect(d.bench.requests).toHaveLength(3);
    expect(d.missions().get(id)).toMatchObject({ waitKind: "input" });
    expect(d.told.filter((text) => text.includes("asks, and works on meanwhile"))).toHaveLength(1);
    expect(d.told.filter((text) => text.includes("has done what it could without your answer, and waits for it now"))).toHaveLength(1);
  });
});
