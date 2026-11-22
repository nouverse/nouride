/**
 * A mission's title: its name for a person, apart from its goal. The goal is an instruction to the agent, and it was
 * also what a person read as the mission's name: a card of what waits for them was a paragraph in large type, and a
 * notice began with the start of an instruction.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { openDatabase } from "@nouride/runtime";
import type { Client } from "@nouride/cli-kit";
import { MISSION_TITLE_MAX, titleFromGoal, type Job, type ToolContext } from "@nouride/shared";
import { mission as missionCommand } from "../../../cli/src/commands/mission.ts";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { missionHooks } from "@/modules/hooks/builtins/mission.ts";
import type { HookContext } from "@/modules/hooks/types.ts";
import { gateSide } from "@/modules/missions/gate-side.ts";
import { startJobRun } from "@/modules/missions/job-runs.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { SimilarAllowed } from "@/modules/missions/similar.ts";
import { titleRefusal } from "@/modules/missions/start.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness, STARTERS_CTX } from "./harness.ts";

const LONG = "Nouride v0.8.39 groups A, C and E: the viewers, what is taken out, and the HTML preview (RFC items 1-8 and the reply table), pushed to releases/v0.8.39. Brief: BRIEF.md in the mission folder.";

describe("a title from a goal, for a mission nobody named", () => {
  test("its first sentence without its closing stop, cut at a word near what a title holds", () => {
    expect(titleFromGoal("write the report")).toBe("write the report");
    expect(titleFromGoal("Fix the login bug.\nThe brief goes on for pages.")).toBe("Fix the login bug");
    expect(titleFromGoal("Is the box up? Check it.")).toBe("Is the box up?");
    // A stop inside a version or a file name ends no sentence.
    expect(titleFromGoal("Ship v0.8.39 of report.md today. Then rest.")).toBe("Ship v0.8.39 of report.md today");
    const cut = titleFromGoal(LONG);
    expect(cut).toBe("Nouride v0.8.39 groups A, C and E: the viewers, what is…");
    expect(cut.length).toBeLessThanOrEqual(MISSION_TITLE_MAX);
    // One long word leaves nothing to cut at: cut where the room ends.
    expect(titleFromGoal(`/srv/nouride/.nouride/workspace/${"x".repeat(80)}`)).toBe(`/srv/nouride/.nouride/workspace/${"x".repeat(27)}…`);
  });
});

describe("what a start is held to", () => {
  test("an agent's start gives a title, in words that say what one is; a person's goal names their mission", () => {
    expect(titleRefusal(undefined, true)).toBe(
      'A mission needs a `title`: its name for the person, at most 60 characters, saying what the work is called ("The viewers for 0.8.39"), not what to do. The goal stays the instruction.',
    );
    expect(titleRefusal("   ", true)).toStartWith("A mission needs a `title`");
    expect(titleRefusal(undefined, false)).toBeNull();
    expect(titleRefusal("The viewers for 0.8.39", true)).toBeNull();
  });

  test("a title is a name: one past 60 characters is refused, whoever gave it, saying how long it is", () => {
    const long = "x".repeat(61);
    for (const byAgent of [true, false]) {
      expect(titleRefusal(long, byAgent)).toBe("A mission's `title` is its name for the person, at most 60 characters, and this one is 61: say what the work is called, and leave what to do to the goal.");
    }
    expect(titleRefusal("x".repeat(60), true)).toBeNull();
  });

  test("through the service: refused with nothing made, kept as given, or named from the goal", async () => {
    const h = await missionsHarness();
    const base = { agentId: "nova", goal: LONG, startedBy: "8142", gatewayId: "telegram:nova", chatId: "8142" };
    expect(h.missions.start({ ...base, byAgent: "nova" })).toMatchObject({ refused: expect.stringContaining("needs a `title`") });
    expect(h.missions.start({ ...base, byAgent: "nova", title: "x".repeat(61) })).toMatchObject({ refused: expect.stringContaining("at most 60 characters, and this one is 61") });
    expect(h.store.recent(5)).toEqual([]);
    const named = h.missions.start({ ...base, byAgent: "nova", title: "  The viewers for 0.8.39  " });
    expect("mission" in named && named.mission.title).toBe("The viewers for 0.8.39");
    const mine = h.missions.start({ ...base, goal: "write the report. Then send it." });
    expect("mission" in mine && mine.mission.title).toBe("write the report");
    // Read back from the database as it was kept.
    expect(h.store.recent(5).map((one) => one.title).sort()).toEqual(["The viewers for 0.8.39", "write the report"]);
  });

  test("a scheduled job's run is named by its job, cut to what a title holds, whoever made the job", async () => {
    const h = await missionsHarness();
    const job = (name: string) => ({ id: "cron_1", agentId: "nova", name, payload: { kind: "mission", goal: LONG }, delivery: { mode: "announce" }, target: { gatewayId: "telegram:nova", chatId: "8142" }, createdBy: "agent:nova", turnedOnBy: "8142" }) as unknown as Job;
    const run = startJobRun({ missions: h.missions, store: h.store }, job("Weekly mail digest"), undefined);
    expect("started" in run && h.store.get(run.started)!.title).toBe("Weekly mail digest");
    h.missions.stop("started" in run ? run.started : "", "Gading");
    const long = startJobRun({ missions: h.missions, store: h.store }, job(`Every Monday: ${"the threads of the week, ".repeat(5)}as one digest`), undefined);
    const title = "started" in long ? h.store.get(long.started)!.title : "";
    expect(title).toStartWith("Every Monday: the threads of the week,");
    expect(title.length).toBeLessThanOrEqual(MISSION_TITLE_MAX);
  });
});

describe("the missions that were there before a mission had a title", () => {
  test("are named by the migration as a mission started with none is named, goal for goal", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 89));
    const columns = db.prepare<{ name: string; notnull: number; dflt_value: string | null; type: string }>("PRAGMA table_info(missions)").all();
    expect(columns.map((one) => one.name)).not.toContain("title");
    // Every column a row of that schema requires, and its id.
    const required = [{ name: "id", type: "TEXT" }, ...columns.filter((one) => one.notnull === 1 && one.dflt_value === null && one.name !== "id")];
    const goals = [
      "write the report",
      "Fix the login bug.\nThe brief goes on for pages.",
      "Is the box up? Check it.",
      "Stop! Then look.",
      "Ship v0.8.39 of report.md today. Then rest.",
      LONG,
      "Follow the brief at /srv/nouride/.nouride/workspace/shared/gading-dev-share-image/BRIEF.md: one PR against gadingnst/gading.dev main on branch feat/share-image",
      `/srv/nouride/.nouride/workspace/${"x".repeat(80)}`,
      "Tidy   the\tlogs\r\nof  the   build box, and the old ones; then report.",
      "A goal that ends on the sixtieth character, exactly, yes yes",
      "A spike APK for nouverse/nouride-android that wraps the proven Termux flow (proot + Debian arm64 + the official Nouride installer) runs on the phone.",
      "Trailing stops...",
    ];
    const insert = db.prepare(`INSERT INTO missions (${required.map((one) => one.name).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`);
    goals.forEach((goal, at) => insert.run(...required.map((one) => (one.name === "id" ? `msn_${at}` : one.name === "goal" ? goal : one.name === "status" ? "done" : /INT|REAL/i.test(one.type) ? 0 : "x"))));
    await migrate(db);
    const store = new MissionStore(db);
    const named = goals.map((_, at) => store.get(`msn_${at}`)!.title);
    expect(named).toEqual(goals.map(titleFromGoal));
    // None empty, none past what a title holds, and each still its own goal's.
    for (const title of named) expect(title.length > 0 && title.length <= MISSION_TITLE_MAX).toBe(true);
    expect(store.get("msn_5")).toMatchObject({ title: "Nouride v0.8.39 groups A, C and E: the viewers, what is…", goal: LONG });
  });
});

describe("a draft's title", () => {
  const drafted = async () => {
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 } });
    const tools = createMissionTools(h.missions);
    const ctx = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", senderId: "8142" } as ToolContext;
    const start = (args: Record<string, unknown>) => tools.chat.execute({ action: "start", goal: LONG, checks: ["true"], ...args }, ctx);
    return { h, tools, ctx, start };
  };

  test("the tool asks for it by a field that says what one is, refuses a start without it, and answers with it", async () => {
    const { h, tools, start } = await drafted();
    const field = (tools.chat.definition.parameters as { properties: Record<string, { description: string }> }).properties.title!;
    expect(field.description).toBe('Its name for the person, in English, at most 60 characters: what the work is called ("The viewers for 0.8.39"), not what to do.');
    const without = await start({});
    expect(without.isError).toBe(true);
    expect(without.content).toStartWith("A mission needs a `title`");
    expect(h.store.recent(5)).toEqual([]);
    const made = await start({ title: "The viewers for 0.8.39" });
    await h.settle();
    const mission = h.store.recent(1)[0]!;
    expect(made.content).toStartWith(`Drafted mission ${mission.id.slice(0, 10)}, "The viewers for 0.8.39": Nouride v0.8.39 groups A, C and E`);
    // The notice: its name, then the goal whole, since the goal is what the person decides on.
    expect(h.told.at(-1)!.text).toStartWith(`📝 Draft ${mission.id.slice(0, 10)} · nova: The viewers for 0.8.39\n\n${LONG}\n\n1 check · `);
  });

  test("is changed before it starts, by its agent and from the dashboard; emptied, it is named from its goal", async () => {
    const { h, tools, ctx, start } = await drafted();
    await start({ title: "The viewers" });
    await h.settle();
    const mission = h.store.recent(1)[0]!;
    const edited = await tools.chat.execute({ action: "edit", id: mission.id, title: "The viewers and the gallery" }, ctx);
    expect(edited.content).toStartWith(`Draft ${mission.id.slice(0, 10)} changed: title.`);
    expect(h.store.get(mission.id)!.title).toBe("The viewers and the gallery");
    expect((await tools.chat.execute({ action: "edit", id: mission.id, title: "x".repeat(61) }, ctx)).content).toContain("at most 60 characters, and this one is 61");
    expect(await h.missions.edit(mission.id, { title: "  " }, {})).toMatchObject({ changed: ["title"] });
    expect(h.store.get(mission.id)!.title).toBe("Nouride v0.8.39 groups A, C and E: the viewers, what is…");
  });
});

describe("every place that names a mission to a person", () => {
  const started = async () => {
    const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 } });
    const mission = await h.start(LONG, { byAgent: "nova", title: "The viewers for 0.8.39", checks: ["true"], review: false });
    const id = mission.id.slice(0, 10);
    return { h, mission, id, name: `The viewers for 0.8.39 (${id})` };
  };

  test("the chat's notices: started, a question, progress, a limit near, a wait followed up, done, stopped", async () => {
    const { h, mission, id, name } = await started();
    const said = (part: string) => h.told.filter((one) => one.text.includes(part)).map((one) => one.text);
    expect(said("▶")[0]).toBe(`▶ ${name}\n\n${LONG}\n\n1 check · stop: /mission stop ${id}`);
    await h.plan(mission.id, [{ text: "the viewer seam", state: "done" }, { text: "svg", state: "active" }]);
    h.missions.shapeFor("nova", h.queued.at(-1)!);
    h.tick(31 * 60_000);
    h.missions.tick();
    expect(said("steps done")).toEqual([`… ${name}: 1 of 2 steps done (last: the viewer seam)`]);
    h.missions.ask(mission.id, { question: "Mermaid?", meanwhile: true });
    expect(said("works on meanwhile")[0]).toStartWith(`❓ ${name} asks, and works on meanwhile: Mermaid?`);
    h.missions.answer(mission.id, "ya", "Gading");
    h.missions.wait(h.store.get(mission.id)!, "limit", "its time limit (8h of work)");
    expect(said("reached")[0]).toStartWith(`⏸ ${name} reached its time limit (8h of work). It is waiting:`);
    h.tick(4 * 60 * 60_000 + 60_000);
    h.missions.tick();
    expect(said("still waiting")[0]).toStartWith(`⏰ ${name} is still waiting for you:`);
    h.missions.stop(mission.id, "Gading");
    await h.settle();
    expect(said("stopped:").at(-1)).toBe(`✗ ${name} stopped: stopped by Gading`);
    // None of them carries the goal as the mission's name.
    expect(h.told.filter((one) => !one.text.startsWith("▶") && one.text.includes("groups A, C and E"))).toEqual([]);
  });

  test("the lists a person and an agent read: `/mission`, `work`, the morning's names, an approval's prompt", async () => {
    const { h, mission, id } = await started();
    const typed = async (text: string) =>
      (
        await missionHooks[0]!.handler({
          deps: { missions: h.missions, isAdmin: () => false },
          args: text.split(/\s+/).slice(1),
          gatewayId: "telegram:nova",
          chatId: "8142",
          senderId: "8142",
          agent: { config: { id: "nova" } },
          envelope: { chatType: "dm", senderName: "Gading" },
        } as unknown as HookContext)
      ).reply ?? "";
    expect(await typed("/mission")).toContain(`• The viewers for 0.8.39 · \`${id}\` · running`);
    expect(await typed("/mission")).not.toContain("groups A, C and E");
    const shown = await typed(`/mission show ${id}`);
    expect(shown).toStartWith(`The viewers for 0.8.39 · ${id} · nova · running\nGoal: ${LONG}`);

    const work = createWorkTool({
      missions: h.missions,
      plan: () => undefined,
      jobs: { list: () => [], get: () => null, tail: async () => "", kill: () => false },
      approvals: new SqliteApprovalGate({ db: h.db, timeoutMs: 60_000 }),
      speaker: () => ({ name: "Gading", admin: false }),
    });
    const ctx = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", senderId: "8142" } as ToolContext;
    expect((await work.execute({ action: "missions" }, ctx)).content).toContain(`${id} · nova · running · The viewers for 0.8.39`);
    expect((await work.execute({ action: "mission", id: mission.id }, ctx)).content).toContain(`Title: The viewers for 0.8.39\nGoal: ${LONG}`);

    // The approval prompt of its turn names it by its title too.
    expect(gateSide(h.store, new SimilarAllowed()).missionOf({ gateway: "web:mission", chatId: mission.id })).toEqual({ id, title: "The viewers for 0.8.39" });
  });

  test("the dashboard's routes: the view carries it, a start may give it, a draft's edit changes it", async () => {
    const { h, mission } = await started();
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "operator", role: "operator", user: { id: "usr_operator", username: "operator", displayName: "Gading" } });
      await next();
    });
    registerMissionRoutes(control as never, { ctx: STARTERS_CTX, missions: h.missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: () => {} } } as never);
    const post = (path: string, body: unknown) => control.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const listed = (await (await control.request("/missions")).json()) as { missions: { id: string; title: string }[] };
    expect(listed.missions.find((one) => one.id === mission.id)!.title).toBe("The viewers for 0.8.39");
    const named = (await (await post("/missions", { agent: "nova", goal: "tidy the logs. Then report.", title: "The old logs" })).json()) as { mission: { id: string; title: string } };
    expect(named.mission.title).toBe("The old logs");
    const unnamed = (await (await post("/missions", { agent: "nova", goal: "tidy the logs. Then report." })).json()) as { mission: { title: string } };
    expect(unnamed.mission.title).toBe("tidy the logs");
    expect((await post("/missions", { agent: "nova", goal: "x", title: "x".repeat(61) })).status).toBe(400);
    const draft = await h.start("the room", { byAgent: "nova", proposed: true, title: "The room" });
    const edited = (await (await post(`/missions/${draft.id}/edit`, { title: "Who answers in a room" })).json()) as { mission: { title: string }; changed: string[] };
    expect(edited).toMatchObject({ mission: { title: "Who answers in a room" }, changed: ["title"] });
  });

  test("`nouride mission`: the list and `show` by its title, and a daemon that sends none by what it sent before", async () => {
    const view = { id: "msn_1", agentId: "nix", status: "running", waitKind: null, seen: "working", title: "The viewers for 0.8.39", goal: LONG, checks: [], turnsUsed: 0, limits: { turns: 10, tokens: 100_000_000, hours: 8 }, workedMs: 0, tokensUsed: 0, reason: null, report: null, files: [], answers: [], told: [], workdir: "/w" };
    const { title: _title, ...older } = view;
    let sends: unknown = view;
    const client = { get: async (path: string) => (path.startsWith("/missions/") ? { mission: sends, plan: null, parked: [] } : { missions: [sends] }) } as unknown as Client;
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line?: unknown) => void printed.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "")));
    let before = "";
    try {
      await missionCommand(client, []);
      await missionCommand(client, ["show", "msn_1"]);
      before = printed.join("\n");
      printed.length = 0;
      sends = older;
      await missionCommand(client, []);
      await missionCommand(client, ["show", "msn_1"]);
    } finally {
      log.mockRestore();
    }
    expect(before).toContain("● The viewers for 0.8.39\n");
    expect(before).toContain("The viewers for 0.8.39 · msn_1 · nix · running");
    const old = printed.join("\n");
    expect(old).toContain("● Nouride v0.8.39 groups A, C and E");
    expect(old).toContain("msn_1 · nix · running\n  Goal:");
  });
});
