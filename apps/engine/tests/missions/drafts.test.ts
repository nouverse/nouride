/**
 * Mission drafts (0.8.11, RFC MISSION_DRAFTS): a mission an agent starts from a chat is a draft first — its goal, its
 * brief, its checks and who signs it off shown with Start it and Drop it, changed before it runs, and run when the person
 * says so. On 2026-10-31 three RFC missions ran with a reviewer judging documents for a person who was in the chat, and
 * none could be changed once asked for; a fourth waited out the reviewer for the agent's one slot.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ButtonPress, ToolContext } from "@nouride/shared";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { ActionPresses } from "@/modules/missions/actions.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { longTurnHelperNote } from "@/modules/llm/executor/nudges.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { missionsHarness, STARTERS_CTX } from "./harness.ts";

type Audited = { action: string; actor: string; agentId?: string; details?: Record<string, unknown> };

/** 8142 drafted it in their DM; 777 is an admin; 555 is neither. */
const person = (extra: Partial<ToolContext> = {}) => ({ agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", senderId: "8142", ...extra }) as ToolContext;

async function setup(settings: Parameters<typeof missionsHarness>[0] = {}) {
  const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 }, ...settings });
  const audited: Audited[] = [];
  const audit = { record: (entry: Audited) => void audited.push(entry) };
  const tools = createMissionTools(h.missions, { audit });
  const work = createWorkTool({
    missions: h.missions,
    jobs: { list: () => [], get: () => null, tail: async () => "", kill: () => false },
    approvals: new SqliteApprovalGate({ db: h.db, timeoutMs: 60_000 }),
    speaker: (who) => ({ name: who.senderId === "8142" ? "Gading" : who.senderId === "777" ? "Sam" : undefined, admin: who.senderId === "777" }),
    audit,
  });
  const draft = async (args: Record<string, unknown> = {}, ctx: ToolContext = person()) => {
    const before = new Set(h.store.open().map((one) => one.id));
    const answer = await tools.chat.execute({ action: "start", goal: "Revise the RFC to the owner's answers", checks: ["test -s RFC.md"], ...args }, ctx);
    await h.settle();
    const made = h.store.open().find((one) => !before.has(one.id)) ?? null;
    return { answer, mission: made };
  };
  return { h, tools, work, draft, audited };
}

describe("D1 — a chat's mission is a draft", () => {
  test("waiting for the person's start, nothing queued, its notice with what they decide on and Start it / Drop it", async () => {
    const { h, draft } = await setup();
    const { answer, mission } = await draft({ accept: true, no_review: true });
    expect(mission).toMatchObject({ status: "waiting", waitKind: "accept", startedAt: null });
    expect(h.queued).toHaveLength(0);
    const id = mission!.id.slice(0, 10);
    const notice = h.told.at(-1)!;
    expect(notice.text).toBe(`📝 Draft ${id} · nova: Revise the RFC to the owner's answers\n\n1 check · signed off by: you · brief: none\n\nStart it: /mission accept ${id} · drop it: /mission stop ${id}`);
    expect(notice.buttons?.map((one) => one.label)).toEqual(["Start it", "Drop it"]);
    expect(answer.content).toStartWith(`Drafted mission ${id}: Revise the RFC`);
    expect(answer.content).toContain('Nothing runs until the person starts it: their tap, /mission accept');
    expect(answer.content).toContain('their "go" passed on with `work` action "start". Change it before then with `mission` action "edit".');
  });

  test("who signs it off is said as the person reads it", async () => {
    const { h, draft } = await setup();
    await draft({ review: "Each answer of the owner's is in the RFC." });
    expect(h.told.at(-1)!.text).toContain("signed off by: the reviewer ·");
    await draft();
    expect(h.told.at(-1)!.text).toContain("1 check · signed off by: you ·");
    await draft({ checks: [], no_review: true });
    expect(h.told.at(-1)!.text).toContain("no checks · signed off by: you");
    await draft({ accept: true });
    expect(h.told.at(-1)!.text).toContain("signed off by: the reviewer, then you");
  });

  test("named by nobody, a draft is the person's after its checks — named, as named; started at once, the reviewer's", async () => {
    // Nouva on Gemini Flash filled no optional field: every long job it drafted for the person in the chat went to the
    // reviewer, the rule in front of it.
    const { draft } = await setup();
    const { mission: unnamed, answer } = await draft();
    expect(unnamed).toMatchObject({ accept: true, reviewOn: false });
    expect(answer.content).toContain("signed off by you.");
    expect((await draft({ review: "Each page reads as Javanese." })).mission).toMatchObject({ accept: false, reviewOn: true });
    expect((await draft({ accept: false })).mission).toMatchObject({ accept: false, reviewOn: true });
    expect((await draft({ no_review: false })).mission).toMatchObject({ accept: false, reviewOn: true });
    expect((await draft({ now: true, said: "do it now, I'm off to sleep" })).mission).toMatchObject({ status: "running", accept: false, reviewOn: true });
  });

  test("the fields it is chosen with say the rule: no reviewer where the person following it accepts, not only where checks are the whole answer", async () => {
    // `no_review` read "Skip the reviewer: the checks are the whole answer" — which no check of a translation is — and
    // Nouva, the rule in front of it, still drafted 43 pages with the reviewer for the person who had asked in the chat.
    const { tools } = await setup();
    const fields = (tools.chat.definition.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(fields.no_review!.description).toContain("No reviewer: the person following the work in this chat accepts it (`accept`), or the checks are the whole answer.");
    expect(fields.accept!.description).toContain("the sign-off when they follow the work in this chat");
  });
});

describe("D2 — at once only on the person's own words", () => {
  test("`now` without `said` is refused, and nothing is made", async () => {
    const { h, draft } = await setup();
    const { answer, mission } = await draft({ now: true });
    expect(answer).toMatchObject({ isError: true, content: "`now` needs `said`: the person's own words asking for it to run now, as they wrote them. Without them it is a draft they start." });
    expect(mission).toBeNull();
    expect(h.store.recent(5)).toHaveLength(0);
  });

  test("with `said` it starts at once: the words in *started* and on the audit row", async () => {
    const { h, draft, audited } = await setup();
    const { mission } = await draft({ now: true, said: "do it, I'm off to sleep" });
    expect(mission!.status).toBe("running");
    expect(h.told.at(-1)!.text).toContain(`\nStarted at once, as asked: "do it, I'm off to sleep"`);
    expect(audited).toEqual([{ action: "mission_started", actor: "agent nova", agentId: "nova", details: { mission: mission!.id, said: "do it, I'm off to sleep" } }]);
  });

  test("not from a turn nobody typed, another agent's ask or a run nobody watches; and a brief goes with a draft", async () => {
    const { draft } = await setup();
    for (const ctx of [person({ senderId: SYSTEM_SENDER }), person({ askedBy: "nox" }), person({ unattended: { goal: "x", level: "balanced" } as never })]) {
      expect((await draft({ now: true, said: "go" }, ctx)).answer.isError).toBe(true);
    }
    expect((await draft({ now: true, said: "go", brief: "All of it." })).answer.content).toStartWith("A brief goes with a draft.");
  });

  test("a turn nobody typed proposes, as before — as a draft", async () => {
    const { draft } = await setup();
    const { mission } = await draft({}, person({ senderId: SYSTEM_SENDER }));
    expect(mission).toMatchObject({ status: "waiting", waitKind: "accept", startedAt: null });
  });
});

describe("D3 — what never stalls as a draft", () => {
  test("a sub-mission from a mission's own turn, and a job's run, run at once", async () => {
    const { h, tools } = await setup();
    const parent = await h.start("the parent", { byAgent: "nova" });
    const inside = { agentId: "nova", gatewayId: MISSION_GATEWAY_ID, chatId: parent.id, senderId: "8142" } as ToolContext;
    await tools.inside.execute({ action: "start", goal: "a piece of it", agent: "nox" }, inside);
    await h.settle();
    expect(h.store.recent(5).find((one) => one.goal === "a piece of it")!.status).toBe("running");
    const run = await h.start("the weekly report", { jobId: "cron_weekly" });
    expect(run.status).toBe("running");
  });
});

describe("D4 — a draft changed before it runs", () => {
  test("its agent changes the checks and who signs it off; the notice is sent again saying what changed", async () => {
    const { h, tools, draft } = await setup();
    const { mission } = await draft({ review: "Each answer of the owner's is in the RFC." });
    const answer = await tools.chat.execute({ action: "edit", id: mission!.id, checks: ["test -s RFC.md", "bun run check-paths"], accept: true, no_review: true }, person());
    expect(answer.content).toBe(`Draft ${mission!.id.slice(0, 10)} changed: checks (2), no reviewer, you accept it. Its notice was sent to this chat again, saying so.`);
    expect(h.store.get(mission!.id)).toMatchObject({ checks: ["test -s RFC.md", "bun run check-paths"], accept: true, reviewOn: false, status: "waiting" });
    const notice = h.told.at(-1)!;
    expect(notice.text).toStartWith(`✎ Draft ${mission!.id.slice(0, 10)} changed: checks (2), no reviewer, you accept it.\n\n📝 Draft`);
    expect(notice.buttons?.map((one) => one.label)).toEqual(["Start it", "Drop it"]);
  });

  test("refused once it has started, for another agent's draft, and for a change that is no change", async () => {
    const { h, tools, draft } = await setup();
    const { mission } = await draft();
    expect((await tools.chat.execute({ action: "edit", id: mission!.id, goal: "x" }, person({ agentId: "nox" }))).content).toBe(`No draft ${mission!.id} of yours.`);
    expect((await tools.chat.execute({ action: "edit", id: mission!.id, checks: ["test -s RFC.md"] }, person())).content).toBe("Nothing in the draft changes.");
    h.missions.accept(mission!.id, "Gading");
    await h.settle();
    const late = await tools.chat.execute({ action: "edit", id: mission!.id, checks: ["true"] }, person());
    expect(late.isError).toBe(true);
    expect(late.content).toContain("has started; a running mission's goal and checks stay as they are");
    expect(h.store.get(mission!.id)!.checks).toEqual(["test -s RFC.md"]);
  });

  test("changed on the dashboard: what changed and a brief's failure for the CLI, what it means in the page's words (0.8.23)", async () => {
    const { h, draft } = await setup();
    const { mission } = await draft();
    // A brief that could not be written, as a full disk or a folder it may not write would leave it.
    const failing = new Proxy(h.missions, {
      get: (target, key) => {
        if (key === "edit") return async (...args: Parameters<typeof target.edit>) => {
          const edited = await target.edit(...args);
          return "refused" in edited ? edited : { ...edited, briefFailed: "EACCES: permission denied, open '/work/missions/BRIEF.md'" };
        };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const edit = async (missions: typeof h.missions, body: unknown) => {
      const control = new Hono<{ Variables: { principal: unknown } }>();
      control.use("*", async (c, next) => {
        c.set("principal", { kind: "user", actor: "gading", role: "operator", user: { id: "usr_1", username: "gading" } });
        await next();
      });
      registerMissionRoutes(control as never, {
      ctx: STARTERS_CTX, missions, notes: h.notes, approvals: { pending: () => [] }, audit: { record: () => {} } } as never);
      return (await (await control.request(`/missions/${mission!.id}/edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
    };
    expect(await edit(h.missions, { goal: "Revise the RFC to every answer" })).toMatchObject({ changed: ["goal"], plain: "Saved. The chat it began in is told what changed." });
    const broken = await edit(failing, { goal: "Revise the RFC to the last answers" });
    expect(broken).toMatchObject({ changed: ["goal"], briefFailed: expect.stringContaining("EACCES"), plain: "Saved, but its brief could not be written, so it has none for now. Whoever runs the server can see why." });
  });

  test("an agent's goal or brief is held to English as its start is; a person's on the dashboard is theirs", async () => {
    const { h, tools, draft } = await setup();
    const { mission } = await draft();
    expect((await tools.chat.execute({ action: "edit", id: mission!.id, goal: "Revisi RFC sesuai jawaban pemilik dan perbaiki semua tautan yang rusak" }, person())).isError).toBe(true);
    expect((await tools.chat.execute({ action: "edit", id: mission!.id, brief: "Revisi RFC sesuai jawaban pemilik dan perbaiki semua tautan yang rusak di dalamnya." }, person())).isError).toBe(true);
    const byPerson = await h.missions.edit(mission!.id, { goal: "Revisi RFC sesuai jawaban pemilik", limits: { hours: 2 } }, {});
    expect("refused" in byPerson).toBe(false);
    expect(h.store.get(mission!.id)).toMatchObject({ goal: "Revisi RFC sesuai jawaban pemilik", limits: { hours: 2 } });
  });

  test("an agent does not raise its own limits: the tool has no field for them", () => {
    const fields = Object.keys((createMissionTools({} as never).chat.definition.parameters as { properties: Record<string, unknown> }).properties);
    expect(fields).not.toContain("limits");
  });
});

describe("D5 — `work` start: a draft started on the person's word", () => {
  test("from the drafter's own turn: started, recorded with their words and who passed them on", async () => {
    const { h, work, draft, audited } = await setup();
    const { mission } = await draft();
    const answer = await work.execute({ action: "start", id: mission!.id, text: "go, start it" }, person());
    expect(answer.content).toBe(`Mission ${mission!.id.slice(0, 10)} started on Gading's word: "go, start it". It runs on its own and reports to this chat; do not do the work here as well.`);
    expect(h.store.get(mission!.id)!.status).toBe("running");
    expect(audited.at(-1)).toEqual({ action: "mission_started", actor: "Gading", agentId: "nova", details: { mission: mission!.id, via: "agent nova", said: "go, start it" } });
  });

  test("never from a mission's turn, another agent's ask, a run nobody watches or the system; never without words", async () => {
    const { h, work, draft } = await setup();
    const { mission } = await draft();
    for (const ctx of [person({ gatewayId: MISSION_GATEWAY_ID }), person({ askedBy: "nox" }), person({ unattended: { goal: "x", level: "balanced" } as never }), person({ senderId: SYSTEM_SENDER })]) {
      const answer = await work.execute({ action: "start", id: mission!.id, text: "go" }, ctx);
      expect(answer.content).toStartWith("A draft starts on a person's word");
    }
    expect((await work.execute({ action: "start", id: mission!.id }, person())).content).toStartWith("`start` needs `text`");
    expect(h.store.get(mission!.id)!.status).toBe("waiting");
  });

  test("in a room, the drafter or an admin; another person there is refused", async () => {
    const { h, work, draft } = await setup();
    const room = (senderId: string) => person({ chatId: "-100team", chatType: "group", senderId });
    const { mission } = await draft({}, room("8142"));
    expect((await work.execute({ action: "start", id: mission!.id, text: "go" }, room("555"))).content).toBe("Only the person who started this mission, or an admin, can answer it.");
    expect((await work.execute({ action: "start", id: mission!.id, text: "go" }, room("777"))).isError).toBe(false);
    expect(h.store.get(mission!.id)!.status).toBe("running");
  });

  test("a mission already started is not a draft", async () => {
    const { h, work } = await setup();
    const running = await h.start("already going", { byAgent: "nova" });
    expect((await work.execute({ action: "start", id: running.id, text: "go" }, person())).content).toBe(`Mission ${running.id.slice(0, 10)} is not a draft waiting to start: it is running.`);
  });
});

describe("D6 — its brief", () => {
  test("written at draft time, named by the notice, on each turn's page once it runs; no worktree before then", async () => {
    const { h, draft } = await setup();
    const { mission, answer } = await draft({ brief: "Read docs/rfc first. Done means every section answers the owner." });
    expect(h.briefs.get(mission!.id)).toBe("Read docs/rfc first. Done means every section answers the owner.");
    expect(h.folders).toEqual([mission!.id]);
    expect(h.told.at(-1)!.text).toContain("brief: on the mission's page");
    expect(answer.content).toContain(`Its brief: /work/private/nova/missions/${mission!.id}/BRIEF.md (yours to change before it starts).`);
    expect(h.missions.brief(h.store.get(mission!.id)!)).toEqual({ path: `/work/private/nova/missions/${mission!.id}/BRIEF.md`, text: "Read docs/rfc first. Done means every section answers the owner." });
    h.missions.accept(mission!.id, "Gading");
    await h.settle();
    const shape = h.turn(h.store.get(mission!.id)!);
    expect(shape?.text).toContain(`\nBrief: /work/private/nova/missions/${mission!.id}/BRIEF.md (read it before you start, and again when you are unsure; it is part of the goal)\n`);
  });

  test("a draft dropped takes its folder with it; one started keeps it", async () => {
    const { h, draft } = await setup();
    const dropped = (await draft({ brief: "a" })).mission!;
    h.missions.stop(dropped.id, "Gading");
    await h.settle();
    expect(h.removed).toEqual([dropped.id]);
    const kept = (await draft({ brief: "b" })).mission!;
    h.missions.accept(kept.id, "Gading");
    await h.settle();
    h.missions.stop(kept.id, "Gading");
    await h.settle();
    expect(h.removed).toEqual([dropped.id]);
  });

  test("an agent's brief in another language is refused before anything is made, as its goal is", async () => {
    const { h, draft } = await setup();
    const { answer, mission } = await draft({ brief: "Baca semua dokumen RFC terlebih dahulu, lalu perbaiki setiap bagian yang belum menjawab pertanyaan pemilik." });
    expect(answer.isError).toBe(true);
    expect(answer.content).toStartWith("The brief");
    expect(mission).toBeNull();
    expect(h.folders).toEqual([]);
  });

  test("an agent's English brief holding a table of the Indonesian strings its work is about is kept (review D5)", async () => {
    const { h, draft } = await setup();
    const brief = [
      "Translate the Approvals card into Indonesian. The strings it shows today are below: keep the keys as they are, fix the ones that do not follow docs/glossary.md, and write the result to src/locales/id.json.",
      "",
      "| Key | Indonesian |",
      "|---|---|",
      "| approvals.empty | Tidak ada yang menunggu jawaban di chat ini |",
      "| approvals.always | Selalu untuk job ini |",
      "| approvals.expired | Permintaan ini sudah kedaluwarsa dan gak dijalankan |",
      "| approvals.admin | Hanya admin yang bisa menjawab ini |",
    ].join("\n");
    const { answer, mission } = await draft({ goal: "Translate the Approvals card into Indonesian", brief });
    expect(answer.content).toStartWith("Drafted mission");
    expect(h.briefs.get(mission!.id)).toBe(brief);
  });
});

describe("D7 — Start it pressed twice", () => {
  test("the first starts it and its notice says by whom; the second does nothing and says so", async () => {
    const { h, draft } = await setup();
    const { mission } = await draft();
    const presses = new ActionPresses({ missions: h.missions, isAdmin: () => false });
    const press = (): ButtonPress => ({ gatewayId: "telegram:nova", chatId: "8142", chatType: "dm", messageId: "m1", data: `mission:do:${mission!.id}:accept:accept`, senderId: "8142", senderName: "Gading" });
    const id = mission!.id.slice(0, 10);
    expect(await presses.press(press())).toEqual({ notice: `Mission ${id} started.`, settled: `Mission ${id}: started by Gading.` });
    const again = await presses.press(press());
    expect(again.notice).toBe(`Mission ${id} has moved on (running), so this button no longer applies.`);
    expect(h.store.get(mission!.id)!.status).toBe("running");
  });
});

describe("D8 — the reviewer stops holding the agent's slot", () => {
  test("one being checked leaves its agent's slot free: a draft started meanwhile runs, and one queued behind it starts", async () => {
    const { h, draft } = await setup({ settings: { perAgent: 1, maxRunning: 5 } });
    const first = await h.start("write the first", { checks: ["true"] });
    const queued = await h.start("write the second");
    expect(h.store.get(queued.id)!.status).toBe("queued");
    let release!: () => void;
    h.setChecks(() => new Promise((resolve) => (release = () => resolve({ passed: true, failed: null }))));
    h.turn(first, {}, () => h.missions.claim(first.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] }));
    await h.settle();
    expect(h.store.get(first.id)!.status).toBe("checking");
    expect(h.store.get(queued.id)!.status).toBe("running");
    const { mission } = await draft();
    h.missions.accept(mission!.id, "Gading");
    await h.settle();
    // The second holds the slot now, running: the draft waits for it, not for the reviewer.
    expect(h.store.get(mission!.id)!.status).toBe("queued");
    release();
  });

  test("the box's own count still has it, and one folder still takes one mission", async () => {
    const box = await setup({ settings: { perAgent: 5, maxRunning: 1 } });
    const checked = await box.h.start("write it", { checks: ["true"] });
    box.h.setChecks(() => new Promise(() => {}));
    box.h.turn(checked, {}, () => box.h.missions.claim(checked.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] }));
    await box.h.settle();
    expect((await box.h.start("then this")).status).toBe("queued");

    const same = await setup({ settings: { perAgent: 5, maxRunning: 5 } });
    const inRepo = await same.h.start("fix the parser", { workdir: "/srv/repo", checks: ["true"] });
    same.h.setChecks(() => new Promise(() => {}));
    same.h.turn(inRepo, {}, () => same.h.missions.claim(inRepo.id, { kind: "done", summary: "Done.", report: "Fixed.", files: [] }));
    await same.h.settle();
    expect((await same.h.start("fix the lexer", { workdir: "/srv/repo" })).status).toBe("queued");
  });
});

describe("D9 — the long-turn note offers a draft where the turn can make one", () => {
  const turn = { calls: 9, elapsedMs: 30_000, offered: 2, told: false };

  test("with `mission` in a chat's turn: draft one instead of a helper for long work; without it, the helper alone", () => {
    expect(longTurnHelperNote({ ...turn, draft: true })).toContain("If what is left is long work (many files or steps, a long research, a wait on CI), draft a `mission` for it instead, then tell them what you drafted and stop here.");
    expect(longTurnHelperNote({ ...turn, draft: false })).not.toContain("draft a `mission`");
    expect(longTurnHelperNote(turn)).not.toContain("draft a `mission`");
  });
});

describe("where a mission works — a worktree is code's (0.8.11)", () => {
  // Asked to audit a spreadsheet, Nouva (live, 2026-10-31) ran `git init` in the folder holding it a minute before the
  // start — the checks said "a commit is on a local branch" — and the mission worked on a branch of a copy, committed the
  // file there for its page, and told a person on WhatsApp the branch's name.
  const fields = (tool: "chat" | "inside") => (createMissionTools({} as never)[tool].definition.parameters as { properties: Record<string, { description: string }> }).properties;

  test("`workdir`: a person's documents are worked on where they are, and no repository is made for a mission", () => {
    for (const tool of ["chat", "inside"] as const) {
      expect(fields(tool).workdir!.description).toBe("Absolute path of an existing folder. Code in a git repository gets a worktree on its own branch; a person's documents are worked on where they are. Never make a repository for a mission.");
      expect(fields(tool).branch!.description).toBe("Its worktree's new branch: code in a git `workdir` only. Default: mission/<id>.");
    }
  });

  test("`checks` prove the file the work leaves; a commit only in a repository", () => {
    const checks = fields("chat").checks!.description;
    expect(checks).toContain("Prove what the work leaves (the file holds what it should, or in a repository a commit on its branch), never outside state that can change");
    expect(checks).not.toContain("a commit is on a local branch");
  });
});
