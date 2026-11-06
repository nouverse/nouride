/**
 * The JSON files 0.8.17 kept at the root of `data/`, moved into `daemon_state` by the first start that has the table
 * (`boot/state-files.ts`, 0.8.18, D6). Each file is written as 0.8.17 wrote it, on a database of 0.8.17's schema brought
 * up to this one, as the upgrade does. What a start reads back is asserted through each state's own reader: a row under
 * a name its reader does not ask for is a state lost at the upgrade.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { DaemonStateStore, STATE_FILES, type StateName } from "@/commons/daemon-state.store.ts";
import {
  agentsSeenState,
  alertCooldownsState,
  cliAccountsState,
  cliLeftRunningState,
  externalEffortsState,
  externalInstructionsState,
  externalModelsState,
  externalSessionsState,
  externalVersionsState,
  morningLinesState,
  pausedAgentsState,
  spendAlertsState,
} from "@/commons/daemon-state.ts";
import { readAdvisories } from "@/boot/advisories.ts";
import { moveStateFiles } from "@/boot/state-files.ts";
import { tempDir } from "../helpers.ts";

const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "daemon" && lines.push(entry)));
beforeEach(() => void lines.splice(0));

const nix = { agentId: "nix", gatewayId: "telegram:nouva", chatId: "555" };
const said = { key: "3f2a9c0d1e4b5a67", message: "exec_secrets.github_token is unscoped", data: { agent_id: "nix" }, since: 1_790_000_000_000 };

/** What a 0.8.17 install holds, file by file, in the shapes its readers took. */
const OF_0818: Record<(typeof STATE_FILES)[number], unknown> = {
  "paused-agents": { paused: ["nouva"] },
  "spend-alerts": { day: 20_396, steps: ["threshold"] },
  "alert-cooldowns": { "gateway_dead:telegram:nouva": 1_790_000_000_000 },
  "morning-lines": { gading: "2026-11-04" },
  "agents-seen": { nouva: 1_780_000_000_000, nix: 1_785_000_000_000 },
  "external-sessions": { "nix|telegram:nouva|555": "0b1f6e2a" },
  "external-instructions": { "nix|telegram:nouva|555": "f3a9" },
  "external-versions": { "claude-code": "2.0.31" },
  "external-models": { nix: [{ value: "default", current: "claude-sonnet-4-5" }, { value: "opus", name: "Opus" }] },
  "external-efforts": { nix: [{ value: "high", current: "high" }, { value: "low" }] },
  "cli-accounts": { "claude-code": ["team"] },
  "cli-left-running": { "nix|s1": nix },
  advisories: { version: 1, said: [said] },
};

/** A data directory as 0.8.17 left it: each file as its writer wrote it, and its database at schema 75. */
async function dataOf0818(files: Partial<Record<string, string>> = {}): Promise<{ dataDir: string; rows: DaemonStateStore }> {
  const dataDir = tempDir("state-files");
  for (const name of STATE_FILES) {
    // The state files, compact with a newline; the advisories, indented one space.
    const text = name === "advisories" ? `${JSON.stringify(OF_0818[name], null, 1)}\n` : `${JSON.stringify(OF_0818[name])}\n`;
    writeFileSync(join(dataDir, `${name}.json`), files[name] ?? text, { mode: 0o600 });
  }
  const db = openDatabase(join(dataDir, "nouride.db"));
  await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 75));
  await migrate(db);
  return { dataDir, rows: new DaemonStateStore(db, () => 1_800_000_000_000) };
}

/** Every state as a start reads it back, through its own reader. */
function readBack(rows: DaemonStateStore) {
  return {
    "paused-agents": pausedAgentsState(rows).load(),
    "spend-alerts": spendAlertsState(rows).load(),
    "alert-cooldowns": alertCooldownsState(rows).load(),
    "morning-lines": morningLinesState(rows).load(),
    "agents-seen": agentsSeenState(rows).load(),
    "external-sessions": externalSessionsState(rows).load(),
    "external-instructions": externalInstructionsState(rows).load(),
    "external-versions": externalVersionsState(rows).load(),
    "external-models": externalModelsState(rows).load(),
    "external-efforts": externalEffortsState(rows).load(),
    "cli-accounts": cliAccountsState(rows).load(),
    "cli-left-running": cliLeftRunningState(rows).load(),
    advisories: readAdvisories(rows.get("advisories")),
  };
}

const every = (rows: DaemonStateStore) => Object.fromEntries([...STATE_FILES, "files-moved"].map((name) => [name, rows.get(name as StateName)]));

describe("the first start that has the table", () => {
  test("reads each file into its row, each state reads back what 0.8.17 kept, and the files stay as they were", async () => {
    const { dataDir, rows } = await dataOf0818();
    const before = Object.fromEntries(STATE_FILES.map((name) => [name, readFileSync(join(dataDir, `${name}.json`), "utf8")]));

    moveStateFiles(dataDir, rows, () => 1_800_000_000_000);

    for (const name of STATE_FILES) expect({ name, row: JSON.parse(rows.get(name)!) }).toEqual({ name, row: OF_0818[name] });
    expect(readBack(rows)).toEqual({
      "paused-agents": ["nouva"],
      "spend-alerts": { day: 20_396, steps: ["threshold"] },
      "alert-cooldowns": { "gateway_dead:telegram:nouva": 1_790_000_000_000 },
      "morning-lines": { gading: "2026-11-04" },
      "agents-seen": { nouva: 1_780_000_000_000, nix: 1_785_000_000_000 },
      "external-sessions": { "nix|telegram:nouva|555": "0b1f6e2a" },
      "external-instructions": { "nix|telegram:nouva|555": "f3a9" },
      "external-versions": { "claude-code": "2.0.31" },
      "external-models": { nix: [{ value: "default", current: "claude-sonnet-4-5" }, { value: "opus", name: "Opus" }] },
      "external-efforts": { nix: [{ value: "high", current: "high" }, { value: "low" }] },
      "cli-accounts": { "claude-code": ["team"] },
      "cli-left-running": { "nix|s1": nix },
      advisories: [{ message: said.message, data: said.data, since: said.since }],
    });
    // The way back to 0.8.17 reads them: left byte for byte.
    for (const name of STATE_FILES) expect(readFileSync(join(dataDir, `${name}.json`), "utf8")).toBe(before[name]!);
    expect(lines.filter((line) => line.message.startsWith("moved the state files")).map((line) => line.data?.moved)).toEqual([13]);
  });

  test("run twice, gives the same rows, and the second reads no file and says nothing", async () => {
    const { dataDir, rows } = await dataOf0818();
    moveStateFiles(dataDir, rows, () => 1_800_000_000_000);
    const once = every(rows);
    // What 0.8.17 might write after the move, were it started on these files: never read over the rows.
    writeFileSync(join(dataDir, "paused-agents.json"), JSON.stringify({ paused: ["nix"] }));
    moveStateFiles(dataDir, rows, () => 1_900_000_000_000);
    expect(every(rows)).toEqual(once);
    expect(JSON.parse(once["files-moved"]!)).toEqual({ at: 1_800_000_000_000, moved: [...STATE_FILES], unreadable: [] });
    expect(lines.filter((line) => line.message.startsWith("moved the state files"))).toHaveLength(1);
  });

  test("never replaces a row already there: what this build wrote wins over a file", async () => {
    const { dataDir, rows } = await dataOf0818();
    pausedAgentsState(rows).save(["nix"]);
    moveStateFiles(dataDir, rows);
    expect(pausedAgentsState(rows).load()).toEqual(["nix"]);
    expect(JSON.parse(rows.get("files-moved")!).moved).not.toContain("paused-agents");
  });

  test("names a file that does not parse, starts its state empty as a missing file does, and moves the rest", async () => {
    const { dataDir, rows } = await dataOf0818({ "paused-agents": "{ not json", "alert-cooldowns": "" });
    moveStateFiles(dataDir, rows);

    const warned = lines.filter((line) => line.level === "warn").map((line) => [line.message, line.data?.path]);
    expect(warned).toEqual([
      ["paused-agents.json could not be read: its state starts empty, as a missing file's does", join(dataDir, "paused-agents.json")],
      ["alert-cooldowns.json could not be read: its state starts empty, as a missing file's does", join(dataDir, "alert-cooldowns.json")],
    ]);
    expect([rows.get("paused-agents"), rows.get("alert-cooldowns")]).toEqual([null, null]);
    expect(pausedAgentsState(rows).load()).toEqual([]);
    expect(alertCooldownsState(rows).load()).toEqual({});
    expect(cliAccountsState(rows).load()).toEqual({ "claude-code": ["team"] });
    expect(JSON.parse(rows.get("files-moved")!)).toMatchObject({ unreadable: ["paused-agents", "alert-cooldowns"] });
    expect(lines.find((line) => line.message.startsWith("moved the state files"))?.data?.moved).toBe(11);
  });

  test("on a fresh install, with no file to move, says nothing and moves nothing — once", async () => {
    const dataDir = tempDir("state-files-fresh");
    const db = openDatabase(join(dataDir, "nouride.db"));
    await migrate(db);
    const rows = new DaemonStateStore(db);
    moveStateFiles(dataDir, rows, () => 5);
    expect(lines).toEqual([]);
    expect(JSON.parse(rows.get("files-moved")!)).toEqual({ at: 5, moved: [], unreadable: [] });
    expect(STATE_FILES.map((name) => rows.get(name))).toEqual(STATE_FILES.map(() => null));
  });
});
