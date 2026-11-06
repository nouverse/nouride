/**
 * What a mission counts beside its turns, across a restart (B5, 0.8.13): a coding CLI's turns and how many reported no
 * tokens, and up to when its helpers' tokens are counted. Kept in memory, a restart showed a CLI mission that counted 0
 * as "tokens unknown", one that reported for some turns only as a full count, and counted its helpers' tokens again
 * from its start. A restart here is a new service over the same database, as boot makes one.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { missionsHarness } from "./harness.ts";

const cli = (agentId: string) => agentId === "nova";

describe("a coding CLI's tokens, after a restart", () => {
  test("counted 0 is still 0 — not unknown", async () => {
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    h.turn(mission, { tokens: 0 });
    const line = h.missions.limitsLine(h.store.get(mission.id)!);
    expect(line).toEndWith("· 0k of 50M tokens");
    h.restart();
    expect(h.missions.limitsShown(h.store.get(mission.id)!)).toEqual({ turns: false, tokens: "known" });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toBe(line);
  });

  test("none reported is still unknown — and a turn that reports after it leaves a floor, not a count", async () => {
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    h.turn(mission, { tokens: 0, tokensUnknown: true });
    h.restart();
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toContain("tokens unknown (the CLI reports none)");
    h.turn(mission, { tokens: 2000 });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toContain("at least 2k of 50M tokens");
  });

  test("some reported is still a floor", async () => {
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    h.turn(mission, { tokens: 3000 });
    h.turn(mission, { tokens: 0, tokensUnknown: true });
    h.restart();
    expect(h.missions.limitsShown(h.store.get(mission.id)!)).toEqual({ turns: false, tokens: "partial" });
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toContain("at least 3k of 50M tokens");
  });

  test("ended, it is said as it was while it ran", async () => {
    // Forgotten as it ended, the same mission's page and `mission show` said "3k of 50M tokens" once it was stopped.
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    h.turn(mission, { tokens: 3000 });
    h.turn(mission, { tokens: 0, tokensUnknown: true });
    h.missions.stop(mission.id, "Gading");
    expect(h.missions.limitsLine(h.store.get(mission.id)!)).toContain("at least 3k of 50M tokens");
  });
});

describe("its helpers' tokens, after a restart", () => {
  test("are counted from the last turn's end, not again from its start", async () => {
    const asked: number[] = [];
    /** What its helpers spent, metered under its conversation as `llm_usage` keeps it. */
    const metered: { at: number; tokens: number }[] = [];
    const h = await missionsHarness({ helperTokens: (_id, since) => (asked.push(since), metered.filter((one) => one.at >= since).reduce((sum, one) => sum + one.tokens, 0)) });
    const mission = await h.start();
    const start = mission.startedAt!;
    metered.push({ at: start + 500, tokens: 700 });
    h.tick(1_000);
    h.turn(mission, { tokens: 1000 });
    h.restart();
    h.tick(30_000);
    metered.push({ at: h.now(), tokens: 300 });
    h.tick(30_000);
    h.turn(mission, { tokens: 1000 });
    expect(asked).toEqual([start, start + 1_000]);
    expect(h.store.get(mission.id)!.tokensUsed).toBe(3000);
  });

  test("the reviewer's, which it counted itself, are not counted again by the turn after it", async () => {
    const metered: { at: number; tokens: number }[] = [];
    const h = await missionsHarness({ helperTokens: (_id, since) => metered.filter((one) => one.at >= since).reduce((sum, one) => sum + one.tokens, 0) });
    // The reviewer is metered as a helper of the mission's conversation, and its review hands back what it spent.
    h.setReview(async () => {
      metered.push({ at: h.now(), tokens: 500 });
      h.tick(1);
      return { pass: false, findings: "the table is missing", tokens: 500 };
    });
    const mission = await h.start("write it", { checks: ["test -s out.txt"] });
    h.turn(mission, { tokens: 1000 }, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)).toMatchObject({ status: "running", tokensUsed: 1500 });
    h.restart();
    h.tick(10_000);
    h.turn(mission, { tokens: 1000 });
    expect(h.store.get(mission.id)!.tokensUsed).toBe(2500);
  });
});

describe("kept on the record", () => {
  test("a database of 0.8.12 takes the columns, its missions intact and counted from none; what is counted is read back", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 73));
    // A mission row as 0.8.12 wrote it: every column it requires, filled.
    const columns = db.prepare<{ name: string; notnull: number; dflt_value: string | null; type: string }>("PRAGMA table_info(missions)").all();
    const required = [{ name: "id", type: "TEXT" }, ...columns.filter((one) => one.notnull === 1 && one.dflt_value === null && one.name !== "id")];
    const value = (one: { name: string; type: string }) => (one.name === "id" ? "msn_old" : one.name === "status" ? "running" : /INT|REAL/i.test(one.type) ? 0 : "x");
    db.prepare(`INSERT INTO missions (${required.map((one) => one.name).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`).run(...required.map(value));
    await migrate(db);
    const store = new MissionStore(db);
    const old = store.get("msn_old")!;
    expect({ goal: old.goal, cliTurns: old.cliTurns, cliUnreported: old.cliUnreported, helpersSince: old.helpersSince }).toEqual({ goal: "x", cliTurns: 0, cliUnreported: 0, helpersSince: null });
    store.save({ ...old, cliTurns: 2, cliUnreported: 1, helpersSince: 5_000 });
    expect(new MissionStore(db).get("msn_old")).toMatchObject({ cliTurns: 2, cliUnreported: 1, helpersSince: 5_000 });
  });
});
