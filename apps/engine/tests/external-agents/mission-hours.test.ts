/**
 * A coding CLI's mission turn past its hours, end to end (0.8.8): the missions' minute check on a hand-moved clock, a
 * CLI started as a real process in a prompt that runs until it is cancelled, and the mission's `stopTurn` wired to the
 * turn's signal as the pipeline wires it. The CLI is asked to cancel (`session/cancel`), the turn ends cut short, and
 * the mission waits on its limit.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedAgent, MessageEnvelope } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { outcomeOf } from "@/modules/pipeline/turn-shape.ts";
import { missionsHarness } from "../missions/harness.ts";
import { eventually } from "../wait.ts";
import { stderrSaid } from "./fixtures/stderr.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const dirs: string[] = [];
const services: ExternalAgents[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a coding CLI's mission turn past its hours", () => {
  test("is cancelled in the CLI at the minute's check, and the mission waits on its limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mission-hours-"));
    dirs.push(dir);
    mkdirSync(privateWorkspace(dir, "nova"), { recursive: true });
    const service = new ExternalAgents({
      rows: () => [{ id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", env: { FAKE_MODE: "slow" }, instructionFile: "AGENTS.md" }],
      workspaceDir: () => dir,
      secretsFor: () => ({}),
      sessions: { load: () => ({}), save: () => {} },
    });
    services.push(service);
    const agent = { config: { id: "nova", displayName: "Nova", external: { cli: "fake" } }, persona: { identity: "" }, dir } as unknown as LoadedAgent;
    const deltas: string[] = [];
    const runner = service.runnerFor(agent, { approvals: { available: true }, onText: (delta: string) => void deltas.push(delta), onActivity: () => {} } as unknown as ExecutorDeps)!;

    // The turn's signal is what `/stop` and the mission's `stopTurn` abort, as `cancelTurnsForAgent` does.
    const controller = new AbortController();
    const h = await missionsHarness({ runsOnCli: (id) => id === "nova", settings: { limitHours: 1 }, stopTurn: () => controller.abort("stopped-by-person") });
    const mission = await h.start();
    const envelope = [...h.queued].reverse().find((one: MessageEnvelope) => one.chatId === mission.id)!;
    const shape = h.missions.shapeFor("nova", envelope)!;
    const running = runner.run({
      agent,
      toolset: { definitions: [], get: () => undefined },
      history: [],
      userMessage: { role: "user", content: shape.text },
      gateway: "web",
      gatewayId: MISSION_GATEWAY_ID,
      chatId: mission.id,
      senderId: "nouride:system",
      signal: controller.signal,
    } as unknown as TurnRequest);
    await eventually(() => deltas.length > 0, 10_000, "the CLI to start the prompt");

    h.tick(61 * 60_000);
    h.missions.tick();
    const result = await running;
    const connection = await service.connection(agent);
    expect(await stderrSaid(connection, (line) => line.startsWith("cancel:"), 1)).toEqual(["cancel:s1"]);
    expect(result.stopReason).toBe("stop");
    expect(result.text).toBe("On it.");
    shape.ended(outcomeOf(result, true));
    expect(h.store.get(mission.id)).toMatchObject({ status: "waiting", waitKind: "limit", reason: "its time limit (1h of work)", turnsUsed: 1 });
  });
});
