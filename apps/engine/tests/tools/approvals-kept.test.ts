/**
 * An approval that outlives a restart, and an answer that outlives the wait for it.
 *
 * A restart answered every pending approval "deny": the shutdown expired them all, and the boot what was left. A restart
 * here is what it is on a box — a second gate over the same database. What only the asking process knew (who asked, its
 * turn, the grant `always` writes) is on the request's row from the moment it is asked (076). It used to be handed over
 * in a file at a clean shutdown alone, so a crash lost it; the file 0.8.17 wrote is read once, at the first start.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import { migrate, openAndMigrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { mayAnswer } from "@/modules/tools/approval-answerers.ts";
import { SqliteApprovalGate, type ApprovalNotice } from "@/modules/tools/approvals.store.ts";
import { keptApprovalsFile, type KeptFile } from "@/modules/tools/approvals-kept.ts";
import { GrantStore } from "@/modules/tools/grants.store.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { eventually, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
const gates: SqliteApprovalGate[] = [];
/** Databases a test opened of its own, closed after the gates over them. */
const others: SqliteDb[] = [];

beforeEach(async () => {
  dir = tempDir("approvals-kept");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  for (const created of gates.splice(0)) created.shutDown();
  for (const opened of others.splice(0)) opened.close();
  db.close();
  removePath(dir);
});

const ask = (overrides: Partial<ApprovalAsk> = {}): ApprovalAsk => ({
  agentId: "nouva",
  chatId: "chat-1",
  gateway: "telegram",
  gatewayId: "telegram:nouva",
  senderId: "ana",
  turnId: "turn_1",
  tool: "exec",
  params: { command: ["sudo", "apt-get", "update"], cwd: "/srv" },
  grantable: true,
  autoCoverable: false,
  reason: "privilege escalation",
  grant: { grantKey: "gk_apt", agentId: "nouva", argv: ["sudo", "apt-get", "update"], cwd: "/srv", policy: {} },
  ...overrides,
});

function gate(options: { db?: SqliteDb; oldHandOver?: KeptFile; timeoutMs?: number; now?: () => number; grants?: GrantStore } = {}) {
  const notices: ApprovalNotice[] = [];
  const late: string[] = [];
  const created = new SqliteApprovalGate({
    db: options.db ?? db,
    timeoutMs: options.timeoutMs ?? 300_000,
    onRequest: (notice) => void notices.push(notice),
    onLateAnswer: (request, decision) => void late.push(`${request.id} ${decision}`),
    ...(options.oldHandOver ? { oldHandOver: options.oldHandOver } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.grants ? { grants: options.grants } : {}),
  });
  gates.push(created);
  return { gate: created, notices, late };
}

const rows = () => db.prepare<{ id: string; status: string }>("SELECT id, status FROM approvals ORDER BY requested_at").all();

/** Until the gate has put a question in front of somebody: what a restart can then carry over, or a call take up. */
const asked = (notices: ApprovalNotice[], count = 1) => eventually(() => notices.length === count, 2_000, `question ${count} shown`);

/** A call asked, and stopped waiting — its turn reserved a millisecond — so the question is open with nobody on it. */
async function leftOpen(g: SqliteApprovalGate, overrides: Partial<ApprovalAsk> = {}): Promise<void> {
  expect(await g.request(ask({ waitMs: 1, ...overrides }))).toEqual({ status: "expired", stillAnswerable: true });
}

/** As 0.8.17 left a request it could not hand over, a crash before its shutdown: nothing of the asking process on its row. */
const askedBefore0819 = () => db.prepare("UPDATE approvals SET extras_json = NULL").run();

describe("across a restart", () => {
  test("a question a person has not answered is kept, and asked again with who asked and what `always` writes", async () => {
    const before = gate();
    const waiting = before.gate.request(ask());
    await asked(before.notices);

    // The shutdown: whoever waits is let go of as a turn that stopped waiting is — the question stays open.
    expect(before.gate.handOver()).toBe(1);
    expect(await waiting).toEqual({ status: "expired", stillAnswerable: true });
    expect(rows().map((row) => row.status)).toEqual(["pending"]);
    before.gate.shutDown();

    const grants = new GrantStore(db);
    const after = gate({ grants });
    const { kept, lapsed } = after.gate.carryOver();
    expect(kept.map((request) => request.tool)).toEqual(["exec"]);
    expect(lapsed).toEqual([]);
    // Not before the gateways can carry it.
    expect(after.notices).toEqual([]);

    expect(after.gate.showKept()).toBe(1);
    expect(after.notices).toHaveLength(1);
    expect(after.notices[0]).toMatchObject({ kept: true, grantable: true, gatewayId: "telegram:nouva", request: { requestedBy: "ana", tool: "exec" } });
    expect(after.gate.keptFor({ id: "turn_1", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "chat-1" }).map((request) => request.id)).toEqual([kept[0]!.id]);
    expect(after.gate.keptFor({ id: "turn_other", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "chat-1" })).toEqual([]);

    // "Always" still writes its grant: the payload came across with the question.
    expect(after.gate.resolve(kept[0]!.id, "allow-always", "ana")).toBe(true);
    expect(grants.liveKeys("nouva").has("gk_apt")).toBe(true);
  });

  test("after a crash, with no shutdown at all, the next process has who asked, its turn and what `always` writes", async () => {
    const before = gate();
    void before.gate.request(ask());
    await asked(before.notices);
    // Killed here: neither the hand-over nor the shutdown runs. What the next process knows is what the asking wrote.

    const grants = new GrantStore(db);
    const after = gate({ grants });
    const { kept } = after.gate.carryOver();
    expect(after.gate.showKept()).toBe(1);
    expect(after.notices[0]).toMatchObject({ kept: true, grantable: true, request: { requestedBy: "ana" } });
    // Its turn came across: the turn taken up is the one that asked, and not any other in the chat.
    expect(after.gate.keptFor({ id: "turn_1", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "chat-1" }).map((request) => request.id)).toEqual([kept[0]!.id]);
    expect(after.gate.keptFor({ id: "turn_other", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "chat-1" })).toEqual([]);
    // In a room the person who asked still answers it, as before the crash, and another member still does not.
    const request = after.gate.get(kept[0]!.id)!;
    expect(mayAnswer({ chatType: "group", senderId: "ana", isAdmin: () => false }, request)).toBe(true);
    expect(mayAnswer({ chatType: "group", senderId: "bob", isAdmin: () => false }, request)).toBe(false);

    expect(after.gate.resolve(kept[0]!.id, "allow-always", "ana")).toBe(true);
    expect(grants.liveKeys("nouva").has("gk_apt")).toBe(true);
  });

  test("one too old to be answered is expired at boot, and never asked again", async () => {
    let clock = 1_000_000;
    const before = gate({ now: () => clock });
    void before.gate.request(ask());
    await asked(before.notices);
    before.gate.handOver();
    before.gate.shutDown();

    // Twenty seconds of its five minutes left: put in front of somebody, it would expire as they read it.
    clock += 280_000;
    const after = gate({ now: () => clock });
    const { kept, lapsed } = after.gate.carryOver();
    expect(kept).toEqual([]);
    expect(lapsed.map((request) => request.tool)).toEqual(["exec"]);
    expect(rows().map((row) => row.status)).toEqual(["expired"]);
    expect(after.gate.showKept()).toBe(0);
    expect(after.notices).toEqual([]);
  });

  test("asked before 0.8.18 and handed nothing over, it is still kept, and `always` runs it once rather than writing nothing", async () => {
    const before = gate();
    void before.gate.request(ask());
    await asked(before.notices);
    before.gate.shutDown();
    askedBefore0819();

    const grants = new GrantStore(db);
    const after = gate({ grants });
    const { kept } = after.gate.carryOver();
    after.gate.showKept();
    // No "always" offered: the grant it would write is not in hand.
    expect(after.notices[0]).toMatchObject({ kept: true, grantable: false });

    const waiting = after.gate.request(ask());
    // Taken up by the call itself, which brings the grant back: answered "always", it is written.
    expect(after.gate.resolve(kept[0]!.id, "allow-always", "ana")).toBe(true);
    await expect(waiting).resolves.toEqual({ status: "approved", id: expect.stringMatching(/^apr_/), by: "ana", decision: "allow-always" });
    expect(grants.liveKeys("nouva").has("gk_apt")).toBe(true);
  });

  test("what a call taking it up brings back is kept on its row: a crash after it still finds who asked and the grant", async () => {
    const before = gate();
    void before.gate.request(ask());
    await asked(before.notices);
    before.gate.shutDown();
    askedBefore0819();

    // The turn taken up makes the same call, and waits on the question with what it brought; then the process dies.
    const middle = gate();
    middle.gate.carryOver();
    void middle.gate.request(ask({ turnId: "turn_2" }));

    const grants = new GrantStore(db);
    const after = gate({ grants });
    const { kept } = after.gate.carryOver();
    after.gate.showKept();
    expect(after.notices[0]).toMatchObject({ kept: true, grantable: true, request: { requestedBy: "ana" } });
    expect(after.gate.resolve(kept[0]!.id, "allow-always", "ana")).toBe(true);
    expect(grants.liveKeys("nouva").has("gk_apt")).toBe(true);
  });

  test("answered `always` before any call takes it up, without the grant: it runs once, says so, and writes nothing", async () => {
    const before = gate();
    void before.gate.request(ask());
    await asked(before.notices);
    before.gate.shutDown();
    askedBefore0819();

    const grants = new GrantStore(db);
    const after = gate({ grants });
    const { kept } = after.gate.carryOver();
    after.gate.showKept();
    expect(after.gate.resolve(kept[0]!.id, "allow-always", "ana")).toBe(true);
    // The woken agent's call takes the answer — downgraded, which the executor tells the model.
    await expect(after.gate.request(ask())).resolves.toEqual({ status: "approved", id: expect.stringMatching(/^apr_/), by: "ana", decision: "allow-always", downgraded: true });
    expect(grants.liveKeys("nouva").has("gk_apt")).toBe(false);
  });
});

describe("the file 0.8.17 handed over at its shutdown", () => {
  test("is read once at the first start: what it held moves onto the rows, the file goes, and nothing writes it again", async () => {
    // A database 0.8.17 left, with a request it kept at its clean shutdown: the row pending, what it knew in the file.
    const old = openDatabase(join(dir, "old.db"));
    others.push(old);
    await migrate(old, {}, MIGRATIONS.filter((one) => one.version <= 75));
    old
      .prepare(
        `INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, status, requested_at, timeout_ms, grantable, auto_coverable, reason)
         VALUES ('apr_old', 'nouva', 'chat-1', 'telegram:nouva', 'exec', ?, 'pending', ?, 300000, 1, 0, 'privilege escalation')`,
      )
      .run(JSON.stringify(ask().params), Date.now());
    const path = join(dir, "approvals-kept.json");
    writeFileSync(path, `${JSON.stringify({ apr_old: { requestedBy: "ana", turnId: "turn_1", grant: ask().grant } })}\n`, { mode: 0o600 });
    await migrate(old);

    const first = gate({ db: old, oldHandOver: keptApprovalsFile(dir) });
    expect(first.gate.carryOver().kept.map((request) => request.id)).toEqual(["apr_old"]);
    first.gate.showKept();
    expect(first.notices[0]).toMatchObject({ kept: true, grantable: true, request: { requestedBy: "ana" } });
    expect(existsSync(path)).toBe(false);
    // A clean shutdown hands nothing to a file: what it would have held is on the rows.
    expect(first.gate.handOver()).toBe(1);
    expect(existsSync(path)).toBe(false);
    first.gate.shutDown();

    // The start after: no file, and the request still has all of it, read from its row.
    const grants = new GrantStore(old);
    const next = gate({ db: old, oldHandOver: keptApprovalsFile(dir), grants });
    next.gate.carryOver();
    next.gate.showKept();
    expect(next.notices[0]).toMatchObject({ kept: true, grantable: true, request: { requestedBy: "ana" } });
    expect(next.gate.keptFor({ id: "turn_1", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "chat-1" }).map((request) => request.id)).toEqual(["apr_old"]);
    expect(next.gate.resolve("apr_old", "allow-always", "ana")).toBe(true);
    expect(grants.liveKeys("nouva").has("gk_apt")).toBe(true);
  });
});

describe("the same call, asked again", () => {
  test("waits on the question still open instead of asking twice — and is released by its answer", async () => {
    const before = gate();
    void before.gate.request(ask());
    await asked(before.notices);
    before.gate.handOver();
    before.gate.shutDown();

    const after = gate();
    const { kept } = after.gate.carryOver();
    after.gate.showKept();

    // The turn taken up after the restart makes the call it was cut off in — its arguments in another order. Whether
    // it asks again is decided before `request` hands back its promise, as a new question's row and prompt are.
    const waiting = after.gate.request(ask({ turnId: "turn_2", params: { cwd: "/srv", command: ["sudo", "apt-get", "update"] } }));
    expect(rows()).toHaveLength(1);
    expect(after.notices).toHaveLength(1);

    expect(after.gate.resolve(kept[0]!.id, "allow-once", "ana")).toBe(true);
    await expect(waiting).resolves.toEqual({ status: "approved", id: expect.stringMatching(/^apr_/), by: "ana", decision: "allow-once" });
    // Released, so nobody was woken for it — and the one question was all there was, start to end.
    expect(after.late).toEqual([]);
    expect(rows()).toHaveLength(1);
    expect(after.notices).toHaveLength(1);
  });

  test("a different call is a different question", async () => {
    const g = gate();
    await leftOpen(g.gate);
    void g.gate.request(ask({ params: { command: ["sudo", "apt-get", "upgrade"], cwd: "/srv" } }));
    await eventually(() => rows().length === 2, 2_000, "a second question");
  });

  test("left open by a turn that stopped waiting, it is waited on too — not a second prompt", async () => {
    const g = gate();
    await leftOpen(g.gate);

    const second = g.gate.request(ask({ turnId: "turn_2" }));
    expect(rows()).toHaveLength(1);
    expect(g.notices).toHaveLength(1);
    g.gate.resolve(rows()[0]!.id, "deny", "ana");
    await expect(second).resolves.toEqual({ status: "denied", by: "ana" });
    expect(g.notices).toHaveLength(1);
  });
});

describe("an answer nobody was waiting for", () => {
  test("wakes the agent, and is the answer to that call when it makes it — once", async () => {
    const g = gate();
    await leftOpen(g.gate);
    const id = rows()[0]!.id;
    expect(g.gate.resolve(id, "allow-once", "ana")).toBe(true);
    expect(g.late).toEqual([`${id} allow-once`]);

    // The woken agent runs it: not asked again what the person has just answered.
    await expect(g.gate.request(ask({ turnId: "turn_2" }))).resolves.toEqual({ status: "approved", id: expect.stringMatching(/^apr_/), by: "ana", decision: "allow-once" });
    expect(rows()).toHaveLength(1);

    // Once: the next time is a new question.
    void g.gate.request(ask({ turnId: "turn_3" }));
    await eventually(() => rows().length === 2, 2_000, "a new question");
  });

  test("a no is taken the same way — the agent does not get to ask again what was refused", async () => {
    const g = gate();
    await leftOpen(g.gate);
    g.gate.resolve(rows()[0]!.id, "deny", "ana", "not today");
    await expect(g.gate.request(ask())).resolves.toEqual({ status: "denied", by: "ana", reason: "not today" });
  });

  test("past the window an approval is good for, it is no answer at all", async () => {
    let clock = 1_000_000;
    const g = gate({ now: () => clock, timeoutMs: 60_000 });
    await leftOpen(g.gate);
    g.gate.resolve(rows()[0]!.id, "allow-once", "ana");
    clock += 60_000;
    void g.gate.request(ask());
    await eventually(() => rows().length === 2, 2_000, "a new question");
  });

  test("/reset takes it with the rest", async () => {
    const g = gate();
    await leftOpen(g.gate);
    g.gate.resolve(rows()[0]!.id, "allow-once", "ana");
    g.gate.expireAll("nouva");
    void g.gate.request(ask());
    await eventually(() => rows().length === 2, 2_000, "a new question");
  });
});
