/**
 * What a mission's end sends (0.8.11): its result, two or three sentences, as the chat's text, and its whole report as
 * `report.md` — every time it hands one back, once — then its files. A mission sent the code it changed as files and its
 * report cut to 1,500 characters, and a person read neither whole. And nothing a person wrote or reads is cut.
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { openDatabase } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { endedNotice } from "@/modules/missions/notices.ts";
import { draftNotice } from "@/modules/missions/drafts.ts";
import { besidesTheReport } from "@/modules/missions/results.ts";
import { missionPage } from "@/modules/missions/page.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { missionsHarness } from "./harness.ts";

const done = (summary: string, report: string, files: string[] = []) => ({ kind: "done" as const, summary, report, files });

describe("what reaches the chat when a mission hands back its result", () => {
  test("its result as the text, then its whole report as `report.md`, then its files — the report never in the text", async () => {
    const h = await missionsHarness();
    const mission = await h.start("write it", { checks: ["true"] });
    const report = `# What was done\n${"Every step, and why. ".repeat(300)}`;
    expect(report.length).toBeGreaterThan(6_000);
    h.turn(mission, {}, () => h.missions.claim(mission.id, done("The text is written.", report, [`${mission.workdir}/out.pdf`])));
    await h.settle();
    const notice = h.told.at(-1)!.text;
    expect(notice).toContain("\nThe text is written.");
    expect(notice).not.toContain("Every step");
    expect(notice).not.toContain("Files:");
    expect(h.reports).toEqual([{ mission: mission.id, report }]);
    expect(h.sent.slice(-3)).toEqual(["notice", "report.md", "files"]);
  });

  test("a result waiting for the person's accept: `report.md` with the wait, read first, and not again when accepted", async () => {
    const h = await missionsHarness();
    const mission = await h.start("decide it");
    h.turn(mission, {}, () => h.missions.claim(mission.id, done("Blue it is.", "Why blue, at length.")));
    await h.settle();
    expect(h.store.get(mission.id)!.waitKind).toBe("accept");
    expect(h.told.at(-1)!.text).toContain("\n\nBlue it is.\n\nAccept:");
    expect(h.reports.map((one) => one.report)).toEqual(["Why blue, at length."]);
    expect(h.sent.slice(-2)).toEqual(["notice", "report.md"]);
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("done");
    expect(h.reports).toHaveLength(1);
  });

  test("sent back with continue, its next report is its own `report.md`; stopped at the wait, nothing is sent twice", async () => {
    const h = await missionsHarness();
    const mission = await h.start("decide it");
    h.turn(mission, {}, () => h.missions.claim(mission.id, done("Blue it is.", "First report.")));
    await h.settle();
    h.missions.continueMission(mission.id, "Gading", "and the border colour");
    await h.settle();
    h.turn(h.store.get(mission.id)!, {}, () => h.missions.claim(mission.id, done("Blue, with a grey border.", "Second report.")));
    await h.settle();
    expect(h.reports.map((one) => one.report)).toEqual(["First report.", "Second report."]);
    h.missions.stop(mission.id, "Gading");
    await h.settle();
    expect(h.reports).toHaveLength(2);
  });

  test("a mission that fails with a report sends it, with its reason as the text", async () => {
    const h = await missionsHarness();
    const mission = await h.start("ship it");
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "fail", reason: "the server is gone", report: "What was tried, in full." }));
    await h.settle();
    expect(h.told.at(-1)!.text).toBe(`✗ Mission ${mission.id.slice(0, 10)} ended: gave up: the server is gone`);
    expect(h.reports.at(-1)?.report).toBe("What was tried, in full.");
  });

  test("without a repository: its files and `report.md` arrive, and the notice names no branch", async () => {
    const h = await missionsHarness();
    const mission = await h.start("make the sheet", { checks: ["true"] });
    const files = [`${mission.workdir}/sheet.xlsx`, `${mission.workdir}/chart.png`];
    h.turn(mission, {}, () => h.missions.claim(mission.id, done("The sheet is made.", "How the sheet was made.", files)));
    await h.settle();
    expect(h.delivered).toEqual(files);
    expect(h.reports).toHaveLength(1);
    expect(h.told.at(-1)!.text).not.toContain("Branch:");
  });

  test("a `report.md` the chat cannot take is said so, and where the report is", async () => {
    const h = await missionsHarness();
    h.setReportRefused("it holds the value of one of the agent's credentials, and a file sent to a chat goes as it is — nothing can mask it there.");
    const mission = await h.start("write it", { checks: ["true"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, done("Written.", "The key is in here.")));
    await h.settle();
    expect(h.told.at(-1)!.text).toBe("report.md was not sent: it holds the value of one of the agent's credentials, and a file sent to a chat goes as it is — nothing can mask it there. The report is on the mission's page.");
  });

  test("an agent's own `report.md` among its files is not sent: the report goes once, as the daemon sends it", () => {
    // Live: Nouva wrote its report to report.md as well and named it, and the chat received two.
    expect(besidesTheReport(["/m/sheet.xlsx", "/m/report.md", "/m/out/REPORT.MD", "/m/report.md.bak"])).toEqual(["/m/sheet.xlsx", "/m/report.md.bak"]);
  });

  test("the ended notice carries why, never the report", () => {
    expect(endedNotice({ id: "msn_0123456789", status: "stopped" }, "stopped by Gading")).toBe("✗ Mission msn_012345 stopped: stopped by Gading");
  });
});

describe("`done`, as the mission's tool asks for it", () => {
  test("refused without a summary: the result, for the chat; with one, the claim holds both", async () => {
    const h = await missionsHarness();
    const mission = await h.start("write it");
    const ctx = { agentId: "nova", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, senderId: "8142" } as ToolContext;
    const { inside } = createMissionTools(h.missions);
    const without = await inside.execute({ action: "done", report: "All of it." }, ctx);
    expect(without).toMatchObject({ isError: true, content: "`done` needs a `summary`: the result, in two or three sentences, for the chat." });
    const shape = h.turn(mission, {}, async () => void (await inside.execute({ action: "done", summary: "It is written.", report: "All of it." }, ctx)));
    expect(shape).not.toBeNull();
    await h.settle();
    expect(h.store.get(mission.id)).toMatchObject({ summary: "It is written.", report: "All of it." });
  });

  test("its fields say what each is: the result, the whole report as `report.md`, the files the person receives — formally, in their language", () => {
    const properties = (createMissionTools({} as never).inside.definition.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(properties.summary!.description).toBe("done: the result (what the mission achieved) in two or three sentences, the chat's message when it ends. In the person's language, in a formal register.");
    expect(properties.report!.description).toContain("The person receives it whole as `report.md`. In the person's language, in a formal register.");
    expect(properties.files!.description).toContain("Not the report, which is sent as `report.md` already. What git tracks in its worktree stays on its branch and is not sent.");
    // Live, 2026-11-01: a blind test's answer key and six evidence stills went to the group the tested agent reads.
    expect(properties.files!.description).toContain("Never what was made to check the work (evidence, stills, fixtures, an answer key): the report names their paths. None when the brief says to send nothing.");
  });
});

describe("kept on the record", () => {
  test("a database of 0.8.10 takes the summary column, its missions intact; a summary saved is read back after a restart", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 72));
    // A mission row as 0.8.10 wrote it: every column it requires, filled.
    const columns = db.prepare<{ name: string; notnull: number; dflt_value: string | null; type: string }>("PRAGMA table_info(missions)").all();
    const required = [{ name: "id", type: "TEXT" }, ...columns.filter((one) => one.notnull === 1 && one.dflt_value === null && one.name !== "id")];
    const value = (one: { name: string; type: string }) => (one.name === "id" ? "msn_old" : one.name === "status" ? "done" : /INT|REAL/i.test(one.type) ? 0 : "x");
    db.prepare(`INSERT INTO missions (${required.map((one) => one.name).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`).run(...required.map(value));
    await migrate(db);
    const store = new MissionStore(db);
    const old = store.get("msn_old")!;
    expect(old.summary).toBeNull();
    store.save({ ...old, summary: "It is written." });
    expect(new MissionStore(db).get("msn_old")!.summary).toBe("It is written.");
  });
});

describe("nothing a person wrote is cut", () => {
  test("a draft carries its goal whole", () => {
    const goal = `${"Collect every invoice from the shared inbox. ".repeat(30)}Then file them.`;
    expect(draftNotice({ id: "msn_0123456789", goal, agentId: "nova", byAgent: null, checks: [], reviewOn: true, accept: false, jobId: null }, false)).toContain(goal);
  });

  test("what a person told a mission, read already, is on its page whole", async () => {
    const h = await missionsHarness();
    const mission = await h.start("mark the rows");
    const text = `use the second tab ${"and keep the header row ".repeat(120)}`.trim();
    const told = [{ id: "tel_1", by: "Gading", at: h.now(), text, read: 1 }];
    const page = missionPage({ mission: { ...mission, told }, why: "a turn.", plan: undefined, parked: [], now: h.now() });
    expect(text.length).toBeGreaterThan(2_500);
    expect(page).toContain(`from Gading: "${text}"`);
  });
});
