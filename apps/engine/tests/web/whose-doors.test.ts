/**
 * Each person's chats their own, at every door (`web/control/whose.ts`): over the real stores and the real routes, an
 * operator asking for another person's conversation — by its id, its chat, its room, a turn of it, a row of its events,
 * a helper's work in it — is answered as for one that is not there, and changes nothing. Their own opens. An admin
 * opens everyone's, and reads them set apart by person when they ask.
 *
 * And the contract that keeps it: every route that names a conversation, a room, a turn or a helper asks the question.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath } from "@nouride/runtime";
import { sessionIdFor } from "@nouride/shared";
import type { ChatListPayload, SessionSummary, Transcript } from "@nouride/wire";
import { openAndMigrate } from "@/db/index.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { NotesStore } from "@/modules/notes/store.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { registerApprovalRoutes } from "@/modules/web/control/routes/approvals.ts";
import { registerChatListRoutes } from "@/modules/web/control/routes/chat-list.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { registerConversationRoutes } from "@/modules/web/control/routes/conversations.ts";
import { registerLogRoutes } from "@/modules/web/control/routes/logs.ts";
import { registerEventRoutes } from "@/modules/web/control/routes/events.ts";
import { registerGroupRoutes } from "@/modules/web/control/routes/groups.ts";
import { registerJobRoutes } from "@/modules/web/control/routes/jobs.ts";
import { registerKnownChatRoutes } from "@/modules/web/control/routes/known-chats.ts";
import { registerNotesRoutes } from "@/modules/web/control/routes/notes.ts";
import { registerRoomRoutes } from "@/modules/web/control/routes/rooms.ts";
import { registerTurnRoutes } from "@/modules/web/control/routes/turns.ts";
import { tempDir, turnStore } from "../helpers.ts";

const LOCAL = "web:dashboard";
const PEOPLE = [
  { key: "gading", name: "Gading", ids: ["web:u1", "telegram:814"] },
  { key: "rina", name: "Rina", ids: ["web:u2", "telegram:555"] },
];
const ACCOUNTS = {
  gading: { kind: "user", actor: "gading", role: "admin", user: { id: "u1", username: "gading", displayName: "", role: "admin" } },
  rina: { kind: "user", actor: "rina", role: "operator", user: { id: "u2", username: "rina", displayName: "", role: "operator" } },
  tamu: { kind: "user", actor: "tamu", role: "viewer", user: { id: "u3", username: "tamu", displayName: "", role: "viewer" } },
} as const;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});
let as: keyof typeof ACCOUNTS = "rina";
beforeEach(() => {
  as = "rina";
});

/** Where each conversation is. */
const GADING = { agentId: "nouva", gatewayId: LOCAL, chatId: "web-g" };
const RINA = { agentId: "nouva", gatewayId: LOCAL, chatId: "web-r" };
const GADING_DM = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814" };
const GROUP = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "-100" };
const JOB = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "cron:cron_1" };
/** Another automation's own conversation: the admin's, which reports to the admin's own private chat. */
const HIS_JOB = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "cron:cron_2" };
/** The automations, as far as whose they are goes: Rina's morning line, and the admin's evening one. */
const AUTOMATIONS: Record<string, { owner?: string; target: { gatewayId: string; chatId: string }; delivery: { mode: string } }> = {
  cron_1: { owner: "web:u2", target: { gatewayId: LOCAL, chatId: "web-r" }, delivery: { mode: "announce" } },
  cron_2: { owner: "web:u1", target: { gatewayId: "telegram:nouva", chatId: "814" }, delivery: { mode: "announce" } },
  // Rina's too, and it has never run: its own conversation has no row and no turn yet.
  cron_3: { owner: "web:u2", target: { gatewayId: LOCAL, chatId: "web-r" }, delivery: { mode: "announce" } },
};
/** That automation's own conversation, which nothing was said in yet. */
const NEW_JOB = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "cron:cron_3" };

async function house() {
  const dir = tempDir("whose-doors");
  cleanup.push(() => removePath(dir));
  const db = await openAndMigrate(join(dir, "t.db"));
  cleanup.push(() => db.close());
  const sessions = new SessionStore(db);
  const turns = turnStore(db);
  const rooms = new RoomStore(db);
  const roomMessages = new RoomMessageStore(db);
  const events = new EventStore(db, Date.now);
  const notes = new NotesStore(join(dir, "notes"));
  const dispatched: unknown[] = [];
  const ended: string[] = [];
  const killed: string[] = [];

  const said = (where: typeof GADING, senderId: string, prompt: string, cause?: unknown) => {
    const turn = turns.begin({ sessionId: sessionIdFor(where), ...where, senderId, prompt, ...(cause ? { cause: cause as never } : {}) })!;
    turns.finish(turn, { status: "done", reply: `about ${prompt}` });
    sessions.save(where, [{ role: "user", content: prompt, timestamp: Date.now() }], 1);
    return turn;
  };
  const gadingTurn = said(GADING, "u1", "gaji bulan ini");
  said(RINA, "u2", "resep rendang");
  said(GADING_DM, "814", "jadwal dokter");
  roomMessages.record({ id: "m1", gatewayId: GROUP.gatewayId, chatId: GROUP.chatId, senderId: "814", senderName: "Gading", text: "lampu teras mati", at: Date.now() });
  said(GROUP, "814", "lampu teras mati");
  said(JOB, "814", "the morning line", { via: "schedule", job: "cron_1" });
  said(HIS_JOB, "814", "the evening line", { via: "schedule", job: "cron_2" });
  rooms.create({ gatewayId: LOCAL, chatId: "room-1", agentIds: ["nouva"], title: "Keuangan", createdBy: "gading" });
  await notes.write(GADING, "Gaji", "Transfer on the 25th.");
  for (const where of [GADING, RINA]) events.append({ kind: "note", turnId: null, agentId: where.agentId, gatewayId: where.gatewayId, chatId: where.chatId, data: { text: where.chatId } } as never);
  events.append({ kind: "note", turnId: null, agentId: null, gatewayId: null, chatId: null, data: { text: "the daemon's own" } } as never);

  const jobs = [
    { id: "job_g", agentId: "nouva", gatewayId: LOCAL, chatId: "web-g", command: "pdftotext gaji.pdf", status: "running", kind: "exec", startedAt: 1 },
    { id: "job_r", agentId: "nouva", gatewayId: LOCAL, chatId: "web-r", command: "curl resep", status: "running", kind: "exec", startedAt: 1 },
  ];
  // A request for a yes in each kind of place: each person's own chat here, the admin's chat on an app, the group, and
  // each one's automation's own conversation. As the gate keeps them: `gateway` is the connection it was asked on.
  const asked = (id: string, where: { gatewayId: string; chatId: string }, status = "pending") => ({ id, agentId: "nouva", gateway: where.gatewayId, chatId: where.chatId, tool: "exec", params: { command: `echo ${id}` }, status, requestedAt: 1, timeoutMs: 600_000 });
  const requests = [asked("ap_g", GADING), asked("ap_r", RINA), asked("ap_dm", GADING_DM), asked("ap_group", GROUP), asked("ap_job", JOB), asked("ap_new_job", NEW_JOB), asked("ap_his_job", HIS_JOB), asked("ap_old_g", GADING, "approved"), asked("ap_old_r", RINA, "approved")];
  const answered: { id: string; decision: string; by: string }[] = [];
  const approvals = {
    pending: () => requests.filter((one) => one.status === "pending"),
    settled: () => requests.filter((one) => one.status !== "pending"),
    get: (id: string) => requests.find((one) => one.id === id) ?? null,
    resolve: (id: string, decision: string, by: { id: string }) => (answered.push({ id, decision, by: by.id }), true),
  };
  const deps = {
    approvals,
    logs: { query: () => [{ seq: 1, message: "gaji bulan ini" }], oldestSeq: () => 1, latestSeq: () => 1 },
    logStore: { query: () => [{ id: 1, message: "gaji bulan ini" }], count: () => 1, components: () => [], span: () => ({ oldest: 1, newest: 1 }) },
    local: { id: LOCAL, platform: "web", dispatch: (request: unknown) => (dispatched.push(request), { messageId: "m", chatId: "x" }) },
    ctx: { config: { people: PEOPLE, daemon: {}, retention: { logDays: 3 } }, gateways: new Map([["telegram:nouva", { platform: "telegram" }]]) },
    sessions,
    turns,
    rooms,
    roomMessages,
    events,
    notes,
    cron: { store: { get: (id: string) => AUTOMATIONS[id] ?? null } },
    turnInspector: new TurnInspector(db),
    audit: { record: () => undefined, recent: () => [{ id: "a1", action: "exec", actor: "gading", details: { command: "cat gaji.pdf" } }] },
    registry: {
      get: (id: string) => (id === "nouva" ? { config: { id, enabled: true, displayName: "Nouva" } } : undefined),
      enabled: () => [{ config: { id: "nouva" } }],
      all: () => [{ config: { id: "nouva" } }],
      isPaused: () => false,
    },
    jobs: {
      running: () => [],
      listSnapshots: () => jobs,
      getSnapshot: (id: string) => jobs.find((job) => job.id === id) ?? null,
      kill: (id: string) => (killed.push(id), true),
      tail: async () => "log",
    },
    pipeline: {
      chatTypeOf: () => undefined,
      answersWhilePaused: () => false,
      cancelTurn: () => false,
      cancelTurnsInChat: () => 0,
      endConversation: async (where: { sessionId: string }) => (ended.push(where.sessionId), { stopped: 0, turns: 0 }),
      untaggedAnswerer: () => null,
      agentTags: () => ({}),
      knownRooms: () => [{ gatewayId: GROUP.gatewayId, platform: "telegram", chatId: GROUP.chatId, name: "Rumah", dashboard: false, agents: ["nouva"], people: [], lastActive: 1 }],
      reachableChats: () => [
        { gatewayId: GADING_DM.gatewayId, chatId: GADING_DM.chatId, platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 2 },
        { gatewayId: GROUP.gatewayId, chatId: GROUP.chatId, platform: "telegram", kind: "group", title: "Rumah", people: [{ key: "gading", name: "Gading" }], lastActive: 1 },
      ],
    },
  };
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", ACCOUNTS[as]);
    await next();
  });
  for (const register of [registerChatRoutes, registerConversationRoutes, registerChatListRoutes, registerNotesRoutes, registerTurnRoutes, registerEventRoutes, registerRoomRoutes, registerGroupRoutes, registerKnownChatRoutes, registerJobRoutes, registerApprovalRoutes, registerLogRoutes]) {
    register(app as never, deps as never);
  }
  const ask = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { ask, sessions, turns, rooms, dispatched, ended, killed, gadingTurn, answered };
}

const listed = (body: Record<string, unknown>) => (body.sessions as SessionSummary[]).map((one) => one.chatId).sort();

describe("an operator asking for another person's conversation", () => {
  test("by its id: a transcript of nothing, a feed with no turn, no file, no notes — and nothing deleted", async () => {
    const h = await house();
    const id = sessionIdFor(GADING);
    const transcript = (await h.ask("GET", `/sessions/${id}/turns`)).body as unknown as Transcript;
    expect({ session: transcript.session, turns: transcript.turns, earlier: transcript.earlier }).toEqual({ session: null, turns: [], earlier: [] });
    expect((await h.ask("GET", `/sessions/${id}/live`)).body).toEqual({ turn: null, jobs: [] });
    expect((await h.ask("GET", `/sessions/${id}/turns/${h.gadingTurn}/files/0`)).status).toBe(404);
    expect((await h.ask("GET", `/sessions/${id}/notes`)).status).toBe(404);
    expect((await h.ask("PUT", `/sessions/${id}/notes`, { text: "- [ ] ikut baca" })).status).toBe(404);
    expect((await h.ask("DELETE", `/sessions/${id}`)).status).toBe(404);
    expect(h.ended).toEqual([]);
    expect(h.sessions.find(id)).not.toBeNull();
  });

  test("by its chat, to send into it or stop it: not there, and nothing is sent", async () => {
    const h = await house();
    expect((await h.ask("POST", "/chat/send", { sessionId: sessionIdFor(GADING), text: "boleh lihat?" })).status).toBe(404);
    expect((await h.ask("POST", "/chat/send", { chatId: GADING.chatId, agent: "nouva", text: "boleh lihat?" })).status).toBe(404);
    expect((await h.ask("POST", "/stop", { chatId: GADING.chatId, gateway: LOCAL })).status).toBe(404);
    expect(h.dispatched).toEqual([]);
  });

  test("in the lists: only her own, whatever she asks for", async () => {
    const h = await house();
    expect(listed((await h.ask("GET", "/sessions")).body)).toEqual(["web-r"]);
    expect(listed((await h.ask("GET", "/sessions?whose=everyone")).body)).toEqual(["web-r"]);
    const list = (await h.ask("GET", "/chat-list?whose=everyone")).body as unknown as ChatListPayload;
    expect(list.agents.map((agent) => agent.sessionId)).toEqual([sessionIdFor(RINA)]);
    expect({ rooms: list.rooms, groups: list.groups }).toEqual({ rooms: [], groups: [] });
    expect((await h.ask("GET", "/groups")).body.groups).toEqual([]);
    expect((await h.ask("GET", "/chats")).body.chats).toEqual([]);
    expect((await h.ask("GET", "/rooms")).body.rooms).toEqual([]);
  });

  test("a room she did not make and never spoke in: not there to read, rename, join or delete", async () => {
    const h = await house();
    for (const [method, path, body] of [
      ["GET", "/rooms/room-1"],
      ["GET", "/rooms/room-1/turns"],
      ["GET", "/rooms/room-1/live"],
      ["PUT", "/rooms/room-1/title", { title: "Punya Rina" }],
      ["POST", "/rooms/room-1/members", { agentId: "nouva" }],
      ["DELETE", "/rooms/room-1/members/nouva"],
      ["DELETE", "/rooms/room-1"],
    ] as const) {
      expect({ path, method, status: (await h.ask(method, path, body)).status }).toEqual({ path, method, status: 404 });
    }
    expect(h.rooms.get(LOCAL, "room-1")?.title).toBe("Keuangan");
  });

  test("a turn of it, a row of its events, a helper's work in it", async () => {
    const h = await house();
    expect((await h.ask("GET", `/turns/${h.gadingTurn}`)).status).toBe(404);
    const turns = (await h.ask("GET", "/turns?limit=50")).body.turns as { prompt: string }[];
    expect(turns.map((turn) => turn.prompt).sort()).toEqual(["resep rendang", "the morning line"]);
    // Her chat's rows, the daemon's own and her own automation's: none of the admin's, here, on an app, or his automation's.
    const chats = new Set(((await h.ask("GET", "/events?limit=500")).body.events as { chatId: string | null }[]).map((row) => row.chatId));
    expect([...chats].sort()).toEqual(["cron:cron_1", "web-r", null].sort());
    expect(((await h.ask("GET", "/jobs")).body.jobs as { id: string }[]).map((job) => job.id)).toEqual(["job_r"]);
    expect((await h.ask("GET", "/jobs/job_g/log")).status).toBe(404);
    expect((await h.ask("POST", "/jobs/job_g/kill")).status).toBe(409);
    expect(h.killed).toEqual([]);
  });
});

describe("a request for a yes belongs to the chat it was asked in", () => {
  const ids = (body: Record<string, unknown>, list: "pending" | "settled" = "pending") => ((body[list] ?? []) as { id: string }[]).map((one) => one.id).sort();

  test("an operator sees the ones asked in her own chat and her own automation, and no other, answered ones included", async () => {
    const h = await house();
    // Her automation that has not run yet asks in a conversation with no row: still hers, by the automation.
    expect(ids((await h.ask("GET", "/approvals")).body)).toEqual(["ap_job", "ap_new_job", "ap_r"]);
    const all = (await h.ask("GET", "/approvals?all=1")).body;
    expect(ids(all)).toEqual(["ap_job", "ap_new_job", "ap_r"]);
    expect(ids(all, "settled")).toEqual(["ap_old_r"]);
  });

  test("another person's is not there by its id, and answering it answers nothing: it stays pending for them", async () => {
    const h = await house();
    for (const id of ["ap_g", "ap_dm", "ap_group", "ap_his_job"]) {
      expect({ id, status: (await h.ask("GET", `/approvals/${id}`)).status }).toEqual({ id, status: 404 });
      for (const decision of ["allow-once", "allow-always", "deny"]) {
        const refused = await h.ask("POST", `/approvals/${id}/${decision}`);
        // As one that never was: the same answer a made-up id gets, so nothing says it exists.
        expect({ id, decision, status: refused.status, body: refused.body }).toEqual({ id, decision, status: 404, body: { error: "no such approval", id } });
      }
    }
    expect(h.answered).toEqual([]);
  });

  test("her own opens and takes her answer, as hers", async () => {
    const h = await house();
    expect((await h.ask("GET", "/approvals/ap_r")).body.approval).toMatchObject({ id: "ap_r", chatId: "web-r" });
    expect((await h.ask("POST", "/approvals/ap_r/allow-once")).body).toEqual({ ok: true, id: "ap_r", decision: "allow-once" });
    expect((await h.ask("POST", "/approvals/ap_job/deny")).status).toBe(200);
    expect(h.answered).toEqual([
      { id: "ap_r", decision: "allow-once", by: "rina" },
      { id: "ap_job", decision: "deny", by: "rina" },
    ]);
  });

  test("a viewer with no person sees none; an admin sees every one and answers any", async () => {
    const h = await house();
    as = "tamu";
    expect(ids((await h.ask("GET", "/approvals")).body)).toEqual([]);
    as = "gading";
    expect(ids((await h.ask("GET", "/approvals")).body)).toEqual(["ap_dm", "ap_g", "ap_group", "ap_his_job", "ap_job", "ap_new_job", "ap_r"]);
    expect(ids((await h.ask("GET", "/approvals?all=1")).body, "settled")).toEqual(["ap_old_g", "ap_old_r"]);
    expect((await h.ask("POST", "/approvals/ap_r/deny")).status).toBe(200);
    expect(h.answered).toEqual([{ id: "ap_r", decision: "deny", by: "gading" }]);
  });
});

describe("the daemon's log and the audit log are an admin's to read", () => {
  const DOORS = ["/logs", "/logs/stored", "/audit"];

  test("an operator and a viewer are refused each, in words a page can say, and read nothing of them", async () => {
    const h = await house();
    for (const who of ["rina", "tamu"] as const) {
      as = who;
      for (const path of DOORS) {
        const refused = await h.ask("GET", path);
        expect({ who, path, status: refused.status, body: refused.body }).toEqual({ who, path, status: 403, body: { error: "admin only", plain: "Only an admin can read the logs." } });
      }
    }
  });

  test("an admin reads each", async () => {
    const h = await house();
    as = "gading";
    for (const path of DOORS) {
      const read = await h.ask("GET", path);
      expect({ path, status: read.status, rows: (read.body.entries as unknown[]).length }).toEqual({ path, status: 200, rows: 1 });
    }
  });
});

describe("her own, and what nobody owns", () => {
  test("her conversation opens and takes a message; her automation's own reads for her, and another person's does not", async () => {
    const h = await house();
    const mine = (await h.ask("GET", `/sessions/${sessionIdFor(RINA)}/turns`)).body as unknown as Transcript;
    expect(mine.turns.map((turn) => turn.prompt)).toEqual(["resep rendang"]);
    expect((await h.ask("POST", "/chat/send", { sessionId: sessionIdFor(RINA), text: "lagi" })).status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    const job = (await h.ask("GET", `/sessions/${sessionIdFor(JOB)}/turns`)).body as unknown as Transcript;
    expect(job.turns.map((turn) => turn.prompt)).toEqual(["the morning line"]);
    // The admin's automation ran in a conversation of its own, and every account read it: answered as one that is not there.
    expect(((await h.ask("GET", `/sessions/${sessionIdFor(HIS_JOB)}/turns`)).body as unknown as Transcript).turns).toEqual([]);
    as = "gading";
    expect(((await h.ask("GET", `/sessions/${sessionIdFor(HIS_JOB)}/turns`)).body as unknown as Transcript).turns.map((turn) => turn.prompt)).toEqual(["the evening line"]);
  });

  test("a viewer with no person reads nothing of anyone's, and nothing is theirs yet", async () => {
    const h = await house();
    as = "tamu";
    expect(listed((await h.ask("GET", "/sessions")).body)).toEqual([]);
    expect(((await h.ask("GET", `/sessions/${sessionIdFor(RINA)}/turns`)).body as unknown as Transcript).turns).toEqual([]);
  });
});

describe("an admin", () => {
  test("reads their own by default: their chats here and on the apps, by their person; the groups they spoke in", async () => {
    const h = await house();
    as = "gading";
    const mine = (await h.ask("GET", "/sessions")).body.sessions as SessionSummary[];
    expect(mine.map((one) => `${one.chatId} ${one.kind}`).sort()).toEqual(["-100 group", "814 private", "web-g private"]);
    const list = (await h.ask("GET", "/chat-list")).body as unknown as ChatListPayload;
    expect(list.agents.map((agent) => agent.sessionId)).toEqual([sessionIdFor(GADING)]);
    expect(list.groups.map((group) => group.chatId)).toEqual(["-100"]);
    expect(list.rooms.map((room) => room.chatId)).toEqual(["room-1"]);
  });

  test("reads everyone's when they ask, each saying what it is and the person it is with", async () => {
    const h = await house();
    as = "gading";
    const all = (await h.ask("GET", "/sessions?whose=everyone")).body.sessions as SessionSummary[];
    expect(all.map((one) => `${one.chatId} ${one.kind} ${one.person?.name ?? "-"}`).sort()).toEqual([
      "-100 group -",
      "814 private Gading",
      "cron:cron_1 job -",
      "cron:cron_2 job -",
      "web-g private Gading",
      "web-r private Rina",
    ]);
    expect(((await h.ask("GET", `/sessions/${sessionIdFor(RINA)}/turns`)).body as unknown as Transcript).turns).toHaveLength(1);
  });

  test("narrows everyone's to one person's, by every account of theirs, or to the private chats nobody is known for", async () => {
    const h = await house();
    as = "gading";
    expect(listed((await h.ask("GET", "/sessions?whose=person:rina")).body)).toEqual(["web-r"]);
    expect(listed((await h.ask("GET", "/sessions?whose=person:gading")).body)).toEqual(["-100", "814", "web-g"]);
    expect(listed((await h.ask("GET", "/sessions?whose=person:nobody")).body)).toEqual([]);
    // Nobody spoke yet in a scheduled job's own: it is nobody's, not somebody unknown's.
    expect(listed((await h.ask("GET", "/sessions?whose=unknown")).body)).toEqual([]);
    const rinas = (await h.ask("GET", "/chat-list?whose=person:rina")).body as unknown as ChatListPayload;
    expect({ rooms: rinas.rooms, groups: rinas.groups, agent: rinas.agents[0]?.sessionId }).toEqual({ rooms: [], groups: [], agent: sessionIdFor(GADING) });
    const gadings = (await h.ask("GET", "/chat-list?whose=person:gading")).body as unknown as ChatListPayload;
    expect(gadings.groups.map((group) => group.chatId)).toEqual(["-100"]);
  });

  test("a private chat nobody in People is known for is listed under nobody known", async () => {
    const h = await house();
    as = "gading";
    const stranger = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "999" };
    const turns = h.turns;
    const turn = turns.begin({ sessionId: sessionIdFor(stranger), ...stranger, senderId: "999", prompt: "siapa ini" })!;
    turns.finish(turn, { status: "done", reply: "halo" });
    h.sessions.save(stranger, [{ role: "user", content: "siapa ini", timestamp: Date.now() }], 1);
    const unknown = (await h.ask("GET", "/sessions?whose=unknown")).body.sessions as SessionSummary[];
    expect(unknown.map((one) => `${one.chatId} ${one.kind} ${one.person?.name ?? "-"}`)).toEqual(["999 private -"]);
    as = "rina";
    expect(listed((await h.ask("GET", "/sessions?whose=unknown")).body)).toEqual(["web-r"]);
  });
});

/** The route files, and the questions a door may ask (`whose.ts`, `conversation.ts`, and each file's own helper). */
const ROUTES = join(import.meta.dir, "../../src/modules/web/control/routes");
const ASKS = /\b(mayOpen|conversationFor|roomFor|yours|readable|theirs|keyOf|eventsFor|readerOf|readerIn|mayAnswerHere)\(/;
/** A path that names one conversation, room, turn, helper or request for a yes, by any method. */
const DOOR = /^\/(sessions\/:id|rooms\/:chatId|turns|jobs|events|approvals|chat\/send$|stop$)/;
/** A path that lists them, read with a GET. */
const LIST = /^\/(sessions|rooms|chat-list|groups|chats)$/;
/** What only an admin reads: every person's lines are in them. */
const ADMINS = /^\/(logs|logs\/stored|audit)$/;

describe("every door asks", () => {
  test("each route that names or lists a conversation, a room, a turn or a helper asks whether the reader may open it", () => {
    const doors: { file: string; route: string; asks: boolean }[] = [];
    for (const file of readdirSync(ROUTES).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(ROUTES, file), "utf8");
      const found = [...source.matchAll(/\bcontrol\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
      found.forEach((match, n) => {
        const path = match[2]!;
        if (!DOOR.test(path) && !(match[1] === "get" && LIST.test(path))) return;
        const body = source.slice(match.index, found[n + 1]?.index ?? source.length);
        doors.push({ file, route: `${match[1]!.toUpperCase()} ${path}`, asks: ASKS.test(body) });
      });
    }
    // The table of the RFC, at least: a reader that stopped finding routes would pass anything.
    expect(doors.length).toBeGreaterThanOrEqual(30);
    expect(doors.map((door) => door.route)).toEqual(expect.arrayContaining(["GET /approvals", "GET /approvals/:id", "POST /approvals/:id/:decision"]));
    expect(doors.filter((door) => !door.asks).map((door) => `${door.route} (${door.file})`)).toEqual([]);
  });

  test("each route that reads the daemon's log or the audit log asks for an admin before anything else", () => {
    const reads: { route: string; asks: boolean }[] = [];
    for (const file of readdirSync(ROUTES).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(ROUTES, file), "utf8");
      const found = [...source.matchAll(/\bcontrol\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
      found.forEach((match, n) => {
        if (!ADMINS.test(match[2]!)) return;
        const body = source.slice(match.index, found[n + 1]?.index ?? source.length);
        // The first thing its handler does: nothing is read, and no "not enabled" said, to anyone else.
        reads.push({ route: `${match[1]!.toUpperCase()} ${match[2]!}`, asks: /=> \{\s*if \(!atLeast\(c\.get\("principal"\), "admin"\)\) return c\.json\(/.test(body) });
      });
    }
    expect(reads.map((read) => read.route).sort()).toEqual(["GET /audit", "GET /logs", "GET /logs/stored"]);
    expect(reads.filter((read) => !read.asks)).toEqual([]);
  });
});
