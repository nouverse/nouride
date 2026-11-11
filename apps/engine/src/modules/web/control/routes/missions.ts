/**
 * The missions on the control API (0.8.0) — what the dashboard's Missions page and `nouride mission` read
 * and do, each as the signed-in person or the control token's operator:
 *
 *   GET  /missions                      the list, *needs you* first, then working, then the rest — each with its checklist's count
 *   GET  /missions/:id                  one mission, with its checklist, its parked approvals and its conversation's id
 *   POST /missions                      start one { agent, goal, checks?, review?, noReview?, accept?, workdir? }
 *   POST /missions/:id/stop|continue|accept|answer   { text?, outside? } — what a person says to it; accept with
 *                                       `outside` closes it as done outside its checks, the note saying where (0.8.7)
 *   POST /missions/:id/tell             { text } — words for it while it works, answered with where they went (0.8.10)
 *   DELETE /missions/:id[?force=1]      an ended mission gone: its record, its conversation, its own folder (0.8.13)
 *
 * Limits are not set here: they are `[missions]`, a person's from the settings, never an agent's.
 */

import type { MissionDetail, MissionView } from "@nouride/wire";
import { sessionIdFor } from "@nouride/shared";
import { stepsDone } from "@/modules/missions/decide.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import type { Missions } from "@/modules/missions/missions.ts";
import { workedMs } from "@/modules/missions/page.ts";
import type { Deleted, Refused } from "@/modules/missions/person.ts";
import type { TellAnswer, TellWhere } from "@/modules/missions/tell.ts";
import { seenAs, type Mission } from "@/modules/missions/types.ts";
import { LOCAL_GATEWAY_ID } from "@/modules/gateways/local.ts";
import { atLeast } from "@/modules/users/auth.ts";
import { jsonBody } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

/** Where a mission started from the dashboard reports, when the page names no chat. */
const DASHBOARD_MISSIONS_CHAT = "missions";
const ORDER = { needs_you: 0, working: 1, done: 2, ended: 3 } as const;
const DAY_MS = 24 * 60 * 60_000;
/**
 * How many days back an ended mission is listed (0.8.8): a week unless the page asks for more, a month at most: a short
 * list, never every mission that ever ended. One still open is listed
 * however old: it is what a person may have to act on.
 */
const LISTED_DAYS = { usual: 7, most: 30 } as const;

/**
 * A mission as the page reads it: the record, what a person sees it as, the hours it has worked, and which limits hold
 * and whether its tokens are known (0.8.8) — the meters drew "2 of 100" turns for a coding CLI's mission, which no turn
 * limit holds, and its tokens as a count where the CLI reported none.
 */
function view(missions: Missions, mission: Mission) {
  return { ...mission, seen: seenAs(mission.status), workedMs: workedMs(mission, missions.now()), shown: missions.limitsShown(mission) };
}

/**
 * How far along its checklist is, for the list: steps settled (done or skipped, as its progress line counts them) of
 * steps, and the one it is on. Null before it has written one.
 */
function checklistOf(notes: ControlDeps["notes"], mission: Mission) {
  const plan = notes?.plan({ agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id });
  if (!plan || plan.steps.length === 0) return null;
  return { done: stepsDone(plan), total: plan.steps.length, active: plan.steps.find((step) => step.state === "active")?.text ?? null };
}

/**
 * What the page says when a person's word to a mission is refused (0.8.20), worded here from why the mission refused it:
 * `refused` is said for the chat and the CLI, with its `/mission` commands and its flags, and stays theirs.
 */
function refusedPlain(refused: Refused | Exclude<Deleted, { mission: Mission }> | Exclude<TellAnswer, { mission: Mission }>, verb: string): string {
  switch (refused.why) {
    case "missing":
      return "This mission is not there any more. Reload the list.";
    case "ended":
      return "This mission has already ended.";
    case "open":
      return "This mission is still at work. Stop it first, then delete it.";
    case "unsaved":
      return `Its folder holds changes that were not kept in its history: ${refused.unsaved.length} ${refused.unsaved.length === 1 ? "file" : "files"}. Deleted anyway, those changes are lost.`;
    case "not-waiting":
      return "This mission is not waiting for you right now.";
    case "question":
      return "This mission asked a question. Answer it in the box under the question.";
    case "no-question":
      return "This mission has no question waiting for an answer.";
    case "empty":
      return verb === "accept" ? "Say where the work was done, then accept it." : verb === "tell" ? "Write what it should know first." : "Write your answer first.";
    case "command":
      return "That reads as a command, not an answer. Write the answer itself.";
    case "not-started":
      return "This mission has not started yet, so there is nothing to accept. Stop it if it is not wanted.";
    case "checking":
      return "Its checks are running now. Decide once they are done.";
    case "working":
      return "This mission is still working and has not said it is done. Wait for it, or stop it.";
    case "long":
      return `That is ${refused.length} characters, and a message to a mission can be ${refused.max} at most. Make it shorter.`;
  }
}

/**
 * Where a person's words to a mission went, said on its page (0.8.23), worded here from where the mission put them:
 * `said` is the chat's, naming the `/mission` command that moves it on, which a button on the page does instead.
 */
function toldPlain(where: TellWhere): string {
  switch (where) {
    case "next_step":
      return "Told. It reads this before its next step.";
    case "into_cli":
      return "Told. Its coding CLI is given this in the turn it is working on.";
    case "after_prompt":
      return "Told. Its coding CLI reads this once the prompt it is working on ends.";
    case "turn_full":
      return "Kept for its next turn: the turn at work has read all it can in one turn.";
    case "next_turn":
      return "Kept for its next turn, which reads it first.";
    case "queued":
      return "Kept: it has not started yet, and its first turn reads this.";
    case "checks_then_accept":
      return "Kept: its checks are running. If they fail, its next turn reads this; if they pass, it waits for you to accept it, with this shown.";
    case "checks_then_turn":
      return "Kept: its checks are running. If they fail, its next turn reads this; if they pass, it goes one more turn to read this.";
    case "answer":
      return "Kept for its next turn. It is waiting for your answer: answer it in the box under its question.";
    case "limit":
      return "Kept for its next turn. It is waiting at its limit: Continue lets it go on.";
    case "unstarted":
      return "Kept: it has not started. Start it, and its first turn reads this.";
    case "accept":
      return "Kept. It is waiting for you: Accept takes it as it is, and Continue has it work on what you said.";
    case "approval":
      return "Kept for its next turn. It is waiting for an approval to be answered, and goes on with this once it is.";
    case "stuck":
      return "Kept for its next turn. It is stuck: Continue lets it try again with this.";
    case "unknown_outcome":
      return "Kept for its next turn. It waits for you to say whether to go on: Continue lets it.";
    case "retry":
      return "Kept for its next turn: its model could not answer, and it tries again by itself.";
    case "kept":
      return "Kept for its next turn.";
  }
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

export function registerMissionRoutes(control: ControlApp, deps: ControlDeps): void {
  const unavailable = { error: "missions are not run in this process" };

  control.get("/missions", (c) => {
    const missions: Missions | undefined = deps.missions;
    if (!missions) return c.json(unavailable, 501);
    const agent = c.req.query("agent") || undefined;
    // A month of a box's missions may be more than the usual hundred newest: asked for by days, up to the most a list holds.
    const days = Math.min(LISTED_DAYS.most, Math.max(1, Math.round(Number(c.req.query("days") ?? LISTED_DAYS.usual)) || LISTED_DAYS.usual));
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? (c.req.query("days") ? 500 : 100)) || 100));
    const now = missions.now();
    // A mission that ended more than `days` ago is out of the list unless asked for (`?all=1`, the CLI's); its record stays.
    const all = c.req.query("all") === "1";
    const rows = missions
      .recent(limit, agent)
      .filter((mission) => all || mission.endedAt === null || now - mission.endedAt < days * DAY_MS)
      .map((mission) => ({ ...view(missions, mission), checklist: checklistOf(deps.notes, mission) }));
    rows.sort((a, b) => ORDER[a.seen] - ORDER[b.seen] || b.createdAt - a.createdAt);
    return c.json({ missions: rows } satisfies { missions: MissionView[] });
  });

  control.get("/missions/:id", (c) => {
    const missions = deps.missions;
    if (!missions) return c.json(unavailable, 501);
    const mission = missions.find(c.req.param("id"));
    if (!mission) return c.json({ error: "no such mission" }, 404);
    const key = { agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id };
    const plan = deps.notes?.plan(key);
    const parked = deps.approvals
      .pending(mission.agentId)
      .filter((request) => String(request.gateway) === MISSION_GATEWAY_ID && request.chatId === mission.id);
    // The job a run is of, by name — its id said nothing on the page (0.8.0); absent once the job is deleted.
    const job = mission.jobId ? deps.cron?.store.get(mission.jobId) : null;
    // The reviewer at work: minutes a pass, where "Running its checks" alone read as stuck (0.8.10).
    const reviewing = missions.reviewing(mission.id);
    return c.json({
      mission: view(missions, mission),
      // Its conversation, for the routes every conversation has: its turns, its notes.
      sessionId: sessionIdFor(key),
      // What its turns did, in steps as each turn's line counts them — "2 of 100" turns alone read as two actions (0.8.0).
      steps: deps.turns?.stepsIn(MISSION_GATEWAY_ID, mission.id) ?? 0,
      // Its brief, as written in its folder (0.8.11): read before a draft is started, and beside the work after — or the
      // one its goal names, inside its agent's own folder; and where it is, for the page to say.
      ...((brief) => ({ brief: brief?.text ?? null, briefPath: brief?.path ?? null }))(missions.brief(mission)),
      ...(job ? { jobName: job.name } : {}),
      ...(reviewing ? { reviewing } : {}),
      plan: plan ?? null,
      notes: deps.notes?.tasks(key) ?? [],
      parked,
    } satisfies MissionDetail);
  });

  control.post("/missions", async (c) => {
    const missions = deps.missions;
    if (!missions) return c.json(unavailable, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const body = await jsonBody(c);
    if (!body || typeof body.agent !== "string" || typeof body.goal !== "string") return c.json({ error: "send { agent, goal }" }, 400);
    const checks = strings(body.checks);
    const started = missions.start({
      agentId: body.agent,
      goal: body.goal,
      ...(checks ? { checks } : {}),
      ...(body.noReview === true ? { review: false as const } : typeof body.review === "string" && body.review.trim() ? { review: body.review } : {}),
      ...(body.accept === true ? { accept: true } : {}),
      ...(typeof body.workdir === "string" && body.workdir.trim() ? { workdir: body.workdir.trim() } : {}),
      startedBy: principal.user?.id ?? principal.actor,
      gatewayId: typeof body.gatewayId === "string" ? body.gatewayId : LOCAL_GATEWAY_ID,
      chatId: typeof body.chatId === "string" ? body.chatId : DASHBOARD_MISSIONS_CHAT,
    });
    if ("refused" in started) return c.json({ error: started.refused, plain: "The mission was not started. Check its goal, its checks and its folder, and try again." }, 400);
    deps.audit.record({ action: "mission_started", actor: principal.actor, agentId: started.mission.agentId, details: { mission: started.mission.id } });
    return c.json({ mission: view(missions, started.mission) } satisfies { mission: MissionView }, 201);
  });

  /**
   * A draft changed before it starts (0.8.11): the fields the new-mission form has, its limits
   * and its brief. A started mission is refused: its checks and goal stay its own. A POST, as every write here is — a
   * PATCH would have been the API's only one.
   */
  control.post("/missions/:id/edit", async (c) => {
    const missions = deps.missions;
    if (!missions) return c.json(unavailable, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "send the fields to change" }, 400);
    const checks = strings(body.checks);
    const number = (value: unknown) => (typeof value === "number" ? value : undefined);
    const limits = body.limits && typeof body.limits === "object" ? (body.limits as Record<string, unknown>) : {};
    const hours = number(limits.hours);
    const turns = number(limits.turns);
    const tokens = number(limits.tokens);
    const edited = await missions.edit(
      c.req.param("id"),
      {
        ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
        ...(checks ? { checks } : {}),
        ...(body.noReview === true ? { review: false } : typeof body.review === "string" ? { review: body.review } : body.noReview === false ? { review: true } : {}),
        ...(typeof body.accept === "boolean" ? { accept: body.accept } : {}),
        ...(typeof body.workdir === "string" || body.workdir === null ? { workdir: body.workdir as string | null } : {}),
        ...(typeof body.branch === "string" || body.branch === null ? { branch: body.branch as string | null } : {}),
        ...(hours !== undefined || turns !== undefined || tokens !== undefined ? { limits: { ...(hours !== undefined ? { hours } : {}), ...(turns !== undefined ? { turns } : {}), ...(tokens !== undefined ? { tokens } : {}) } } : {}),
        ...(typeof body.brief === "string" ? { brief: body.brief } : {}),
      },
      {},
    );
    if ("refused" in edited) return c.json({ error: edited.refused, plain: "The draft was not changed. Reload it, check what you entered, and try again." }, 409);
    deps.audit.record({ action: "mission_edited", actor: principal.actor, agentId: edited.mission.agentId, details: { mission: edited.mission.id, changed: edited.changed } });
    // What changed is the chat's list (a folder by its path among it), and a brief's failure an exception's message: the
    // page says what it means (0.8.23), and the chat it began in has the list.
    const plain = edited.briefFailed ? "Saved, but its brief could not be written, so it has none for now. Whoever runs the server can see why." : "Saved. The chat it began in is told what changed.";
    return c.json({ mission: view(missions, edited.mission), changed: edited.changed, ...(edited.briefFailed ? { briefFailed: edited.briefFailed } : {}), plain } satisfies { mission: MissionView; changed: string[]; briefFailed?: string; plain?: string });
  });

  /**
   * An ended mission deleted (0.8.13): `Missions.delete` refuses one still open, and work in its folder nobody
   * committed unless `force=1`; then its conversation ends the way deleting one does — turns, notes, approvals.
   */
  control.delete("/missions/:id", async (c) => {
    const missions = deps.missions;
    if (!missions) return c.json(unavailable, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const found = missions.find(c.req.param("id"));
    if (!found) return c.json({ error: `No mission ${c.req.param("id")}.` }, 404);
    const force = c.req.query("force") === "1";
    const deleted = await missions.delete(found.id, principal.user?.displayName?.trim() || principal.actor, { force });
    // The note is what gets past it, read by the CLI as its hint and by the page as a second, forced ask, whose words are
    // the plain one.
    if ("refused" in deleted) {
      return c.json(
        {
          error: deleted.refused,
          ...("unsaved" in deleted ? { note: "With force (`--force`, or Delete anyway on its page) that work is lost." } : {}),
          plain: refusedPlain(deleted, "delete"),
        },
        409,
      );
    }
    const { agentId, id } = deleted.mission;
    const { turns } = await deps.pipeline.endConversation(
      { agentId, gatewayId: MISSION_GATEWAY_ID, chatId: id, sessionId: sessionIdFor({ agentId, gatewayId: MISSION_GATEWAY_ID, chatId: id }) },
      "delete",
    );
    deps.audit.record({ action: "mission_deleted", actor: principal.actor, agentId, details: { mission: id, turns, ...(force ? { force } : {}) } });
    return c.json({ ok: true, mission: id, turns } satisfies { ok: true; mission: string; turns: number });
  });

  control.post("/missions/:id/:verb", async (c) => {
    const missions = deps.missions;
    if (!missions) return c.json(unavailable, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const verb = c.req.param("verb");
    const id = c.req.param("id");
    const body = (await jsonBody(c)) ?? {};
    const text = typeof body.text === "string" ? body.text : undefined;
    const by = principal.user?.displayName?.trim() || principal.actor;
    // Words for it while it works (0.8.10), with where they went — the dashboard says it as the toast.
    if (verb === "tell") {
      const told = missions.tell(id, text ?? "", by);
      if ("refused" in told) return c.json({ error: told.refused, plain: refusedPlain(told, "tell") }, 409);
      deps.audit.record({ action: "mission_tell", actor: principal.actor, agentId: told.mission.agentId, details: { mission: told.mission.id, chars: (text ?? "").trim().length } });
      return c.json({ mission: view(missions, told.mission), said: told.said, plain: toldPlain(told.where) } satisfies { mission: MissionView; said?: string; plain?: string });
    }
    const acted =
      verb === "stop"
        ? missions.stop(id, by)
        : verb === "continue"
          ? missions.continueMission(id, by, text)
          : verb === "accept"
            ? typeof body.outside === "string"
              ? missions.acceptOutside(id, body.outside, by)
              : missions.accept(id, by)
            : verb === "answer"
              ? missions.answer(id, text ?? "", by)
              : null;
    if (!acted) return c.json({ error: "stop, continue, accept, answer or tell" }, 404);
    if ("refused" in acted) return c.json({ error: acted.refused, plain: refusedPlain(acted, verb) }, 409);
    deps.audit.record({ action: `mission_${verb}`, actor: principal.actor, agentId: acted.mission.agentId, details: { mission: acted.mission.id, ...(typeof body.outside === "string" ? { outside: body.outside } : {}) } });
    return c.json({ mission: view(missions, acted.mission) } satisfies { mission: MissionView; said?: string; plain?: string });
  });
}
