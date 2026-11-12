/**
 * `/missions` over HTTP, as the dashboard's Missions page reads it (0.8.0): the list in the order a person reads it —
 * *needs you*, then working, then the rest — each row carrying how far along its checklist is, which is the progress
 * bar the list draws; one mission with its conversation's id; and who may act on one.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sessionIdFor } from "@nouride/shared";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { registerMissionRoutes } from "@/modules/web/control/routes/missions.ts";
import { missionsHarness, STARTERS_CTX } from "../missions/harness.ts";

async function app(role: "admin" | "operator" | "viewer" = "operator", extra: Record<string, unknown> = {}, harness: Parameters<typeof missionsHarness>[0] = {}) {
  const h = await missionsHarness({ settings: { perAgent: 1, maxRunning: 4 }, ...harness });
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { id: `usr_${role}`, username: role, displayName: role } });
    await next();
  });
  registerMissionRoutes(control as never, {
      ctx: STARTERS_CTX,
    missions: h.missions,
    // The chat the harness starts missions from is the starter's own private chat: one an agent proposed there on
    // its own, which nobody owns yet, is theirs to see.
    sessions: { openerOfChat: () => "telegram:8142" },
    // The checklist the route reads is the one `plan` keeps for the mission's conversation.
    notes: h.notes,
    approvals: { pending: () => [] },
    audit: { record: () => {} },
    ...extra,
  } as never);
  const get = async (path: string) => (await control.request(path)).json();
  const post = (path: string, body: unknown) => control.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const del = (path: string) => control.request(path, { method: "DELETE" });
  return { h, get, post, del };
}

describe("the list", () => {
  test("needs you first, then working, then what ended — each with its checklist's count and the step it is on", async () => {
    const { h, get } = await app();
    const done = await h.start("ended one", { agentId: "nox" });
    h.missions.stop(done.id, "Gading");
    const working = await h.start("working one");
    await h.plan(working.id, [
      { text: "Read the logs", state: "done" },
      { text: "Skip the cache", state: "skipped", reason: "none here" },
      { text: "Write the report", state: "active" },
      { text: "Send it", state: "pending" },
    ]);
    const proposed = await h.start("waits for a yes", { agentId: "nox", startedBy: "nouride:system", byAgent: "nox", proposed: true });

    const { missions } = (await get("/missions")) as { missions: { id: string; seen: string; checklist: unknown }[] };
    expect(missions.map((m) => [m.id, m.seen])).toEqual([
      [proposed.id, "needs_you"],
      [working.id, "working"],
      [done.id, "ended"],
    ]);
    expect(missions[1]!.checklist).toEqual({ done: 2, total: 4, active: "Write the report" });
    // No checklist yet is said as none, not as nought of nought.
    expect(missions[0]!.checklist).toBeNull();
  });

  test("a mission ended over a week ago only with ?all=1 — its record stays", async () => {
    const { h, get } = await app();
    const working = await h.start("one", { agentId: "nox" });
    const old = await h.start("two");
    h.missions.stop(old.id, "Gading");
    h.tick(8 * 24 * 60 * 60_000);
    const ids = async (path: string) => ((await get(path)) as { missions: { id: string }[] }).missions.map((m) => m.id);
    expect(await ids("/missions")).toEqual([working.id]);
    expect(await ids("/missions?all=1")).toContain(old.id);
  });

  test("?days= widens the ended ones to a month at most, never all — the open ones listed however old (0.8.8)", async () => {
    const { h, get } = await app();
    const ids = async (path: string) => ((await get(path)) as { missions: { id: string }[] }).missions.map((m) => m.id);
    const open = await h.start("still open", { agentId: "nox" });
    const tenDays = await h.start("ended ten days back");
    h.missions.stop(tenDays.id, "Gading");
    h.tick(10 * 24 * 60 * 60_000);
    const yesterday = await h.start("ended yesterday", { agentId: "nova" });
    h.missions.stop(yesterday.id, "Gading");
    h.tick(24 * 60 * 60_000);
    expect(await ids("/missions")).toEqual([open.id, yesterday.id]);
    expect(await ids("/missions?days=7")).toEqual([open.id, yesterday.id]);
    expect((await ids("/missions?days=30")).sort()).toEqual([open.id, tenDays.id, yesterday.id].sort());
    // Past a month the page cannot ask: 90 days reads as 30, and both ended more than 30 days back by now.
    h.tick(31 * 24 * 60 * 60_000);
    expect(await ids("/missions?days=90")).toEqual([open.id]);
  });

  test("one agent's, when the page asks for it", async () => {
    const { h, get } = await app();
    await h.start("nova's");
    await h.start("nox's", { agentId: "nox" });
    const { missions } = (await get("/missions?agent=nox")) as { missions: { agentId: string }[] };
    expect(missions.map((m) => m.agentId)).toEqual(["nox"]);
  });
});

describe("one mission", () => {
  test("with its conversation's session id — what the page reads its turns and live steps from", async () => {
    const { h, get } = await app();
    const mission = await h.start();
    await h.plan(mission.id, [{ text: "Plan", state: "active" }]);
    const detail = (await get(`/missions/${mission.id}`)) as { sessionId: string; plan: { steps: unknown[] }; mission: { seen: string; workedMs: number } };
    expect(detail.sessionId).toBe(sessionIdFor({ agentId: "nova", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }));
    expect(detail.plan.steps).toHaveLength(1);
    expect(detail.mission.seen).toBe("working");
  });
});

describe("its steps and its job (0.8.0)", () => {
  test("the steps its turns took, and the name of the job it is a run of — the id said nothing", async () => {
    const asked: string[] = [];
    const { h, get } = await app("operator", {
      turns: { stepsIn: (gatewayId: string, chatId: string) => (asked.push(`${gatewayId}:${chatId}`), 37) },
      cron: { store: { get: (id: string) => (id === "cron_1" ? { id, name: "Weekly mail" } : null) } },
    });
    const mission = await h.start();
    h.store.save({ ...h.store.get(mission.id)!, jobId: "cron_1" });
    const detail = (await get(`/missions/${mission.id}`)) as { steps: number; jobName?: string };
    expect(detail.steps).toBe(37);
    expect(detail.jobName).toBe("Weekly mail");
    expect(asked).toEqual([`${MISSION_GATEWAY_ID}:${mission.id}`]);
    // A job since deleted: no name, and the page says its id.
    h.store.save({ ...h.store.get(mission.id)!, jobId: "cron_gone" });
    expect(((await get(`/missions/${mission.id}`)) as { jobName?: string }).jobName).toBeUndefined();
  });
});

describe("acting on one", () => {
  test("starting one names what is missing", async () => {
    const { post } = await app();
    expect((await post("/missions", { agent: "nova" })).status).toBe(400);
    const started = await post("/missions", { agent: "nova", goal: "tidy the notes", checks: ["true"], noReview: true });
    expect(started.status).toBe(201);
    expect(((await started.json()) as { mission: unknown }).mission).toMatchObject({ goal: "tidy the notes", reviewOn: false, checks: ["true"] });
  });

  test("a viewer may read but not stop it", async () => {
    const { h, post } = await app("viewer");
    const mission = await h.start();
    expect((await post(`/missions/${mission.id}/stop`, {})).status).toBe(403);
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("an operator stops it; a verb that does not apply is a 409 with why", async () => {
    const { h, post } = await app("operator");
    const mission = await h.start();
    const stopped = await post(`/missions/${mission.id}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { mission: { seen: string } }).mission.seen).toBe("ended");
    const again = await post(`/missions/${mission.id}/accept`, {});
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: `Mission ${mission.id.slice(0, 10)} has already ended (stopped).`, plain: "This mission has already ended." });
    const answered = await post(`/missions/${mission.id}/answer`, { text: "yes" });
    expect(answered.status).toBe(409);
    expect(await answered.json()).toEqual({ error: `Mission ${mission.id.slice(0, 10)} has no question waiting.`, plain: "This mission has no question waiting for an answer." });
  });
});

/**
 * Deleting one (0.8.13): a mission went only with its conversation, from the chat list, and test missions lingered on the
 * live box. Only once it has ended; never over work nobody committed in its folder unless forced; its conversation ends
 * as deleting one ends it.
 */
describe("deleting one", () => {
  function recorded() {
    const ended: { key: unknown; mode: string }[] = [];
    const audit: { action: string; details?: Record<string, unknown> }[] = [];
    return {
      ended,
      audit,
      extra: {
        pipeline: { endConversation: async (key: unknown, mode: string) => (ended.push({ key, mode }), { stopped: 0, turns: 3 }) },
        audit: { record: (row: { action: string; details?: Record<string, unknown> }) => void audit.push(row) },
      },
    };
  }

  test("an ended one goes — its record, the folder made for it, its conversation — and the delete is recorded", async () => {
    const seen = recorded();
    const { h, del } = await app("operator", seen.extra);
    const mission = await h.start("ended one");
    h.missions.stop(mission.id, "Gading");
    const res = await del(`/missions/${mission.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mission: mission.id, turns: 3 });
    expect(h.store.get(mission.id)).toBeNull();
    expect(h.removed).toContain(mission.id);
    const chat = { agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id };
    expect(seen.ended).toEqual([{ key: { ...chat, sessionId: sessionIdFor(chat) }, mode: "delete" }]);
    expect(seen.audit).toContainEqual(expect.objectContaining({ action: "mission_deleted", details: { mission: mission.id, turns: 3 } }));
  });

  test("one still open is refused, not stopped on the way; a viewer may not; an unknown id is a 404", async () => {
    const seen = recorded();
    const { h, del } = await app("operator", seen.extra);
    const running = await h.start("still working");
    const open = await del(`/missions/${running.id}`);
    expect(open.status).toBe(409);
    expect(await open.json()).toMatchObject({ error: expect.stringContaining("is running. Stop it first, then delete it"), plain: "This mission is still at work. Stop it first, then delete it." });
    expect(h.store.get(running.id)!.status).toBe("running");
    expect(seen.ended).toEqual([]);
    expect((await del("/missions/msn_nothinghere")).status).toBe(404);
    const viewer = await app("viewer");
    const ended = await viewer.h.start();
    viewer.h.missions.stop(ended.id, "Gading");
    expect((await viewer.del(`/missions/${ended.id}`)).status).toBe(403);
    expect(viewer.h.store.get(ended.id)).not.toBeNull();
  });

  test("work nobody committed in its folder refuses it by name, with the note that gets past it; force deletes", async () => {
    const seen = recorded();
    const { h, del } = await app("operator", seen.extra, { unsavedIn: () => ["/w/nova/missions/x/worktree"] });
    const mission = await h.start("left work behind");
    h.missions.stop(mission.id, "Gading");
    const refused = await del(`/missions/${mission.id}`);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; note?: string; plain?: string };
    expect(body.error).toContain("holds work nobody committed: /w/nova/missions/x/worktree");
    expect(body.note).toContain("`--force`, or Delete anyway on its page");
    // The page's words, from what the mission said (its kind and its files), not out of its sentence (0.8.20).
    expect(body.plain).toBe("Its folder holds changes that were not kept in its history: 1 file. Deleted anyway, those changes are lost.");
    expect(h.store.get(mission.id)).not.toBeNull();
    expect(h.removed).not.toContain(mission.id);
    const forced = await del(`/missions/${mission.id}?force=1`);
    expect(forced.status).toBe(200);
    expect(h.store.get(mission.id)).toBeNull();
    expect(h.removed).toContain(mission.id);
    expect(seen.audit).toContainEqual(expect.objectContaining({ action: "mission_deleted", details: { mission: mission.id, turns: 3, force: true } }));
  });
});

/**
 * A draft changed on the dashboard before it starts (0.8.11): the new-mission form's fields, its
 * limits and its brief, by an operator; a started mission's are its own. And the page reads its brief.
 */
describe("a draft on the dashboard", () => {
  const draftOf = (h: Awaited<ReturnType<typeof missionsHarness>>) => h.start("Revise the RFC", { startedBy: "8142", byAgent: "nova", proposed: true });

  test("an operator changes its checks, limits and brief; the change is said back, recorded, and the page shows the brief", async () => {
    const audited: unknown[] = [];
    const { h, get, post } = await app("operator", { audit: { record: (entry: unknown) => void audited.push(entry) } });
    const draft = await draftOf(h);
    const res = await post(`/missions/${draft.id}/edit`, { checks: ["test -s RFC.md"], noReview: true, accept: true, limits: { hours: 2 }, brief: "Read the owner's answers first." });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: string[]; mission: { checks: string[]; limits: { hours: number } } };
    expect(body.changed).toEqual(["checks (1)", "no reviewer", "you accept it", "its hours limit", "the brief"]);
    expect(body.mission).toMatchObject({ checks: ["test -s RFC.md"], limits: { hours: 2 }, reviewOn: false, accept: true });
    expect(audited).toEqual([{ action: "mission_edited", actor: "operator", agentId: "nova", details: { mission: draft.id, changed: body.changed } }]);
    expect(((await get(`/missions/${draft.id}`)) as { brief: string | null }).brief).toBe("Read the owner's answers first.");
  });

  test("refused once it has started, a limit that is no number above zero, and a viewer", async () => {
    const { h, post } = await app();
    const draft = await draftOf(h);
    expect((await post(`/missions/${draft.id}/edit`, { limits: { turns: 0 } })).status).toBe(409);
    h.missions.accept(draft.id, "Gading");
    await h.settle();
    const late = await post(`/missions/${draft.id}/edit`, { checks: ["true"] });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toContain("has started");
    const viewer = await app("viewer");
    const other = await draftOf(viewer.h);
    expect((await viewer.post(`/missions/${other.id}/edit`, { checks: ["true"] })).status).toBe(403);
  });
});
