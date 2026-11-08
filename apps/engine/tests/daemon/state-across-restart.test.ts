/**
 * What `/stop` and the alert cooldown leave behind for the next process.
 *
 * Both lived in memory, and a nightly update is a restart: an agent somebody stopped was answering again the next
 * morning, and an alert sent a minute before the update went out again a minute after. A restart here is what it is on
 * a box: a second registry, or a second notifier, built on a new connection to the same database (`daemon_state` since
 * 0.8.18; a JSON file each before).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, removePath } from "@nouride/runtime";
import { AgentRegistry } from "@nouride/persona";
import { addLogSink, type Gateway, type LogEntry, type OutboundMessage } from "@nouride/shared";
import { parseConfig } from "@/modules/config/global/index.ts";
import { Notifier } from "@/commons/notify.ts";
import { migrate } from "@/db/index.ts";
import { alertCooldownsState, pausedAgentsState } from "@/commons/daemon-state.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { tempDir, writeAgentPack } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function dirs() {
  const agentsDir = tempDir("agents");
  const dataDir = tempDir("data");
  cleanup.push(() => removePath(agentsDir), () => removePath(dataDir));
  return { agentsDir, dataDir };
}

/** The data directory's database, opened as a start opens it: a connection of its own, the schema brought up to date. */
function rowsOf(dataDir: string): DaemonStateStore {
  const db = openDatabase(join(dataDir, "nouride.db"));
  void migrate(db);
  cleanup.push(() => db.close());
  return new DaemonStateStore(db);
}

async function boot(agentsDir: string, dataDir: string): Promise<AgentRegistry> {
  const config = parseConfig({});
  return await AgentRegistry.create({ agentsDir, llmDefaults: config.llm.defaults, pauses: pausedAgentsState(rowsOf(dataDir)) });
}

describe("a paused agent", () => {
  test("is still paused after a restart, and resumed for good by /start", async () => {
    const { agentsDir, dataDir } = dirs();
    for (const id of ["nouva", "nero"]) await writeAgentPack(agentsDir, { id, soul: "Be brief." });

    const before = await boot(agentsDir, dataDir);
    expect(before.pause("nouva")).toBe(true);

    const lines: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "agents.registry" && lines.push(entry)));
    const after = await boot(agentsDir, dataDir);
    expect(after.isPaused("nouva")).toBe(true);
    expect(after.status("nouva")).toBe("paused");
    expect(after.active().map((agent) => agent.config.id)).toEqual(["nero"]);
    expect(lines.find((entry) => entry.message.startsWith("agents still paused"))?.data).toEqual({ agent_ids: ["nouva"] });

    expect(after.resume("nouva")).toBe(true);
    expect((await boot(agentsDir, dataDir)).isPaused("nouva")).toBe(false);
  });

  test("kept in the database, in its row, and no longer in a file beside it (0.8.18)", async () => {
    const { agentsDir, dataDir } = dirs();
    await writeAgentPack(agentsDir, { id: "nouva", soul: "Be brief." });
    (await boot(agentsDir, dataDir)).pause("nouva");
    expect(JSON.parse(rowsOf(dataDir).get("paused-agents")!)).toEqual({ paused: ["nouva"] });
    expect(existsSync(join(dataDir, "paused-agents.json"))).toBe(false);
  });

  test("whose pack fails to load stays paused — fixed, it comes back paused; one deleted is forgotten", async () => {
    const { agentsDir, dataDir } = dirs();
    for (const id of ["nouva", "nero"]) await writeAgentPack(agentsDir, { id, soul: "Be brief." });
    const first = await boot(agentsDir, dataDir);
    first.pause("nouva");
    first.pause("nero");

    await writeAgentPack(agentsDir, { id: "nouva", soul: "Be brief.", configToml: "[llm\nbroken" });
    removePath(join(agentsDir, "nero"));
    const broken = await boot(agentsDir, dataDir);
    expect(broken.loadFailures().map((failure) => failure.id)).toEqual(["nouva"]);
    expect(JSON.parse(rowsOf(dataDir).get("paused-agents")!)).toEqual({ paused: ["nouva"] });

    await writeAgentPack(agentsDir, { id: "nouva", soul: "Be brief.", configToml: "" });
    expect((await boot(agentsDir, dataDir)).isPaused("nouva")).toBe(true);
  });

  test("a row that cannot be read starts with nothing paused, and says so", async () => {
    const { agentsDir, dataDir } = dirs();
    await writeAgentPack(agentsDir, { id: "nouva", soul: "Be brief." });
    rowsOf(dataDir).set("paused-agents", "{ not json");
    const lines: LogEntry[] = [];
    addLogSink((entry) => void (entry.level === "warn" && lines.push(entry)));
    expect((await boot(agentsDir, dataDir)).isPaused("nouva")).toBe(false);
    expect(lines.map((entry) => entry.message)).toContain("the paused agents could not be read, starting without them");
  });
});

describe("an alert's cooldown", () => {
  function owner() {
    const sent: OutboundMessage[] = [];
    const gateway = { id: "telegram:nouva", platform: "telegram", status: "connected", send: async (msg: OutboundMessage) => void sent.push(msg) } as unknown as Gateway;
    return { gateways: new Map([[gateway.id, gateway]]), sent };
  }
  const notifier = (dataDir: string, gateways: Map<string, Gateway>, now: () => number) =>
    new Notifier({ gateways, owner: { gatewayId: "telegram:nouva", chatId: "owner" }, alertCooldownMs: 300_000, cooldowns: alertCooldownsState(rowsOf(dataDir)), now });

  test("holds through a restart: what went out a minute before is not sent again a minute after", async () => {
    const { dataDir } = dirs();
    const { gateways, sent } = owner();
    let clock = 1_000_000;
    expect(await notifier(dataDir, gateways, () => clock).alert("disk_low", "the disk is nearly full")).toBe(true);

    clock += 120_000;
    const restarted = notifier(dataDir, gateways, () => clock);
    expect(await restarted.alert("disk_low", "the disk is nearly full")).toBe(false);
    // Another kind was never held back.
    expect(await restarted.alert("cost_cap", "the daily cap is reached")).toBe(true);
    expect(sent.map((msg) => msg.text)).toEqual(["⚠️ the disk is nearly full", "⚠️ the daily cap is reached"]);

    clock += 300_000;
    expect(await notifier(dataDir, gateways, () => clock).alert("disk_low", "the disk is nearly full")).toBe(true);
  });

  test("a time from the future is not kept — a clock set back must not silence a kind for good", async () => {
    const { dataDir } = dirs();
    const { gateways } = owner();
    rowsOf(dataDir).set("alert-cooldowns", JSON.stringify({ disk_low: 9_000_000_000_000 }));
    expect(await notifier(dataDir, gateways, () => 1_000_000).alert("disk_low", "the disk is nearly full")).toBe(true);
  });

  test("only what is still cooling down is written down", async () => {
    const { dataDir } = dirs();
    const { gateways } = owner();
    let clock = 1_000_000;
    const n = notifier(dataDir, gateways, () => clock);
    await n.alert("old_kind", "an old one");
    clock += 400_000;
    await n.alert("new_kind", "a new one");
    expect(Object.keys(JSON.parse(rowsOf(dataDir).get("alert-cooldowns")!))).toEqual(["new_kind"]);
  });
});
