/**
 * The other agents, as a coding CLI is told them (0.8.11, RFC Part C §C.3): the OTHER AGENTS lines a model's prompt has,
 * in its first prompt, said again only when the room's agents change. A CLI had their names alone, after `ask_agent:`
 * in its first line: in a room it did not know the token that tags one — on Discord the id, not the name — so it handed
 * work over through `ask_agent`, which nobody in the room saw, and it was not told the hop limit. Against the fake CLI,
 * started as a real process: its answer is "Done: " and the prompt it was given.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent, ToolDefinition } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { situationOf, untold } from "@/modules/external-agents/situation.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { clockDeps } from "./fixtures/clock.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROW: CliRow = {
  id: "fake",
  name: "Fake CLI",
  command: process.execPath,
  args: [FAKE],
  install: "it is a test",
  versionArgs: ["--version"],
  profileEnv: "FAKE_HOME",
  env: { FAKE_MODE: "" },
  modes: { folder: "yolo", risky: "default", all: "default" },
  instructionFile: "AGENTS.md",
};

const tool = (name: string): ToolDefinition => ({ name, description: name, parameters: { type: "object" } });
const toolset = (...names: string[]) => ({ definitions: names.map(tool), get: () => undefined });

/** A Discord room with Nox and Nouva, each tagged by its own bot's id; the orchestrator's front desk set, as config can. */
const ROOM = (names = ["nox", "nouva"]) => ({
  names,
  mentions: { nox: "<@1100>", nouva: "<@2200>", nexa: "<@3300>" },
  about: { nox: "the infra agent", nouva: "the writer", nexa: "the analyst" },
  maxHops: 4,
  channel: "mention" as const,
  frontDesk: true,
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "external-agents-"));
  dirs.push(dir);
  mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
  const service = new ExternalAgents({ rows: () => [ROW], workspaceDir: () => dir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} } });
  services.push(service);
  const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" } }, persona: { identity: "" }, dir } as unknown as LoadedAgent;
  const runner = service.runnerFor(agent, { ...clockDeps, onActivity: () => {} } as unknown as ExecutorDeps)!;
  const req = (text: string, extra: Partial<TurnRequest> = {}) =>
    ({
      agent,
      toolset: toolset("ask_agent"),
      history: [],
      userMessage: { role: "user", content: text },
      gateway: "discord",
      gatewayId: "discord:coder",
      chatId: "room-1",
      chatType: "group",
      senderId: "555",
      senderName: "Mira",
      otherAgents: ROOM(),
      ...extra,
    }) as unknown as TurnRequest;
  return { runner, req };
}

describe("in a room", () => {
  test("the first prompt has each agent's own tag, what it is for and the hop limit — and no front desk", async () => {
    const { runner, req } = setup();
    const said = (await runner.run(req("ask the infra agent to check the disk"))).text;
    expect(said).toContain("OTHER AGENTS\n- You share this chat with: nox (write <@1100>), nouva (write <@2200>).");
    expect(said).toContain("- nox: the infra agent");
    expect(said).toContain("- After 4 exchanges between agents the mentions stop being delivered");
    expect(said).toContain("- A mention hands the work over: they will see the message and act on it.");
    // Set for the orchestrator in config; a CLI is never one, so it is never the room's front desk.
    expect(said).not.toContain("You are the orchestrator");
  });

  test("said once a session — and again when the room's agents change", async () => {
    const { runner, req } = setup();
    await runner.run(req("one"));
    const second = (await runner.run(req("two"))).text;
    expect(second).not.toContain("OTHER AGENTS");
    const third = (await runner.run(req("three", { otherAgents: ROOM(["nox", "nouva", "nexa"]) } as Partial<TurnRequest>))).text;
    expect(third).toContain("- You share this chat with: nox (write <@1100>), nouva (write <@2200>), nexa (write <@3300>).");
  });
});

describe("in a turn the daemon started", () => {
  const job = (extra: Partial<TurnRequest> = {}) =>
    ({ toolset: toolset("ask_agent"), gateway: "discord", gatewayId: "discord:coder", chatId: "room-1", chatType: "group", systemEvent: true, ...extra }) as unknown as TurnRequest;

  test("a job's turn in a room is told the other agents too — nobody is speaking, but they are there", () => {
    expect(situationOf(job({ otherAgents: ROOM() } as Partial<TurnRequest>)).agents).toContain("- You share this chat with: nox (write <@1100>), nouva (write <@2200>).");
  });

  test("one that carries none keeps what the session was told", () => {
    const told = situationOf(job({ systemEvent: false, senderId: "555", otherAgents: ROOM() } as Partial<TurnRequest>));
    expect(situationOf(job(), told).agents).toBe(told.agents);
    expect(told.agents).toContain("OTHER AGENTS");
  });
});

describe("in a DM", () => {
  const dm = (...tools: string[]) =>
    ({ toolset: toolset(...tools), gateway: "telegram", gatewayId: "telegram:coder", chatId: "555", chatType: "dm", otherAgents: { ...ROOM(), channel: "bus" as const } }) as unknown as TurnRequest;

  test("`ask_agent` lent: the bus, not a tag — it is the only voice there", () => {
    const told = untold(situationOf(dm("ask_agent")), undefined);
    expect(told).toContain("- Writing @their-name here does nothing.");
    expect(told).toContain("- To hand work to one of them, call `ask_agent`.");
  });

  test("not lent: that nothing reaches them — and `delegate` named as no way only where it is lent", () => {
    const none = untold(situationOf(dm()), undefined);
    expect(none).toContain("- You have no way to reach them from this conversation. If the work genuinely needs one of");
    expect(none).not.toContain("`delegate` is not it");
    expect(untold(situationOf(dm("delegate")), undefined)).toContain("`delegate` is not it: that runs a");
  });

  test("none where it shares the daemon with no other agent", () => {
    const alone = { ...dm("ask_agent"), otherAgents: { ...ROOM([]), channel: "bus" as const } } as unknown as TurnRequest;
    expect(situationOf(alone).agents).toBe("");
  });
});
