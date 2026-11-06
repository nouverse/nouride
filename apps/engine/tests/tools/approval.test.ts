import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { openAndMigrate } from "@/db/index.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { GrantStore } from "@/modules/tools/grants.store.ts";
import { addLogSink, type ExecPolicySection, type LogEntry } from "@nouride/shared";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { sleep, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;

const ask = (overrides: Partial<ApprovalAsk> = {}): ApprovalAsk => ({
  agentId: "nouva",
  chatId: "chat-1",
  gateway: "web",
  gatewayId: "web:dashboard",
  senderId: "dev",
  tool: "exec",
  params: { command: ["ls"] },
  grantable: false,
  autoCoverable: true,
  reason: "first time this agent has run this command",
  ...overrides,
});

beforeEach(async () => {
  dir = tempDir("approval");
  db = await openAndMigrate(join(dir, "test.db"));
});

/** Every gate this file builds, so none of them outlives the database it writes to. */
const gates: SqliteApprovalGate[] = [];
function track(gate: SqliteApprovalGate): SqliteApprovalGate {
  gates.push(gate);
  return gate;
}

afterEach(() => {
  // Before the database closes. A pending approval holds a timer measured in minutes, and a test that
  // ends without answering leaves it armed — it then fires against a closed database and throws from a
  // callback nobody is catching, which bun blames on whichever test is running at the time. That is
  // where "the suite is flaky" came from, and it is the same lesson `JobStore` already learned.
  for (const created of gates) created.shutDown();
  gates.length = 0;
  db.close();
  removePath(dir);
});

function gate(timeoutMs = 60_000, audit?: AuditLog) {
  return track(new SqliteApprovalGate({ db, timeoutMs, ...(audit ? { audit } : {}) }));
}

describe("answering a request", () => {
  test("an approval releases the waiting tool call", async () => {
    // The bug this pins: `finish()` cleared the waiter map, and `resolve()` read the waiter
    // *after* calling it — so the row said "approved" while the promise hung forever. The tool
    // never ran, the turn never ended, and the whole conversation's queue stayed blocked.
    const g = gate();
    const pending = g.request(ask());

    // Give the insert a tick, as a human answering would.
    await sleep(5);
    const id = g.pending()[0]!.id;
    expect(g.resolve(id, "allow-once", "gading")).toBe(true);

    // Would time out here before the fix.
    const outcome = await Promise.race([
      pending,
      sleep(500).then(() => ({ status: "HUNG" as const })),
    ]);
    expect(outcome).toEqual({ status: "approved", id: expect.stringMatching(/^apr_/), by: "gading", decision: "allow-once" });
  });

  test("a denial releases it too, with the reason", async () => {
    const g = gate();
    const pending = g.request(ask());
    await sleep(5);

    g.resolve(g.pending()[0]!.id, "deny", "gading", "not now");
    await expect(pending).resolves.toEqual({ status: "denied", by: "gading", reason: "not now" });
  });

  test("answering twice changes nothing the second time", async () => {
    const g = gate();
    const pending = g.request(ask());
    await sleep(5);
    const id = g.pending()[0]!.id;

    expect(g.resolve(id, "allow-once", "first")).toBe(true);
    // Already resolved — saying yes again must not re-run anything.
    expect(g.resolve(id, "deny", "second")).toBe(false);
    await expect(pending).resolves.toEqual({
      status: "approved",
      id: expect.stringMatching(/^apr_/),
      by: "first",
      decision: "allow-once",
    });
  });

  test("an unknown id is refused", () => {
    expect(gate().resolve("apr_nope", "allow-once", "gading")).toBe(false);
  });
});

describe("timeouts and expiry", () => {
  test("an unanswered request expires as a denial, never an approval", async () => {
    // §7.3 SPEC step 6. An unattended request becoming a yes is the one outcome that must be
    // impossible.
    const g = gate(30);
    const outcome = await g.request(ask());
    expect(outcome).toEqual({ status: "expired" });
    expect(g.pending()).toHaveLength(0);
  });

  test("expireAll releases every waiter — used by /reset and shutdown", async () => {
    const g = gate();
    const first = g.request(ask({ tool: "exec" }));
    const second = g.request(ask({ tool: "write" }));
    await sleep(5);

    expect(g.expireAll("nouva")).toBe(2);
    // Both promises must settle, or shutdown waits on them forever.
    await expect(
      Promise.race([Promise.all([first, second]), sleep(500).then(() => "HUNG")]),
    ).resolves.toEqual([{ status: "expired" }, { status: "expired" }]);
  });

  test("an expiry whose write throws still releases the turn as a denial, and says so", async () => {
    // The timer writes the row. Out of it a throw was an uncaught exception the daemon shuts down on (bun fails this
    // test on one), and it left the turn parked on a promise nobody would settle again.
    const errors: LogEntry[] = [];
    addLogSink((entry) => void (entry.component === "tools.approval" && entry.level === "error" && errors.push(entry)));
    const locked = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== "function") return value;
        if (key !== "prepare") return value.bind(target);
        return (sql: string) => {
          if (sql.trimStart().startsWith("UPDATE approvals SET status")) throw new Error("database is locked");
          return value.call(target, sql);
        };
      },
    });
    const g = track(new SqliteApprovalGate({ db: locked, timeoutMs: 30 }));
    const outcome = await Promise.race([g.request(ask()), sleep(2_000).then(() => ({ status: "HUNG" as const }))]);
    expect(outcome).toEqual({ status: "expired" });
    // Not written, so still pending — answerable, and expired at shutdown or the next boot.
    expect(g.pending()).toHaveLength(1);
    expect(errors.map((line) => [line.message, line.data?.error])).toEqual([["could not record an approval as expired", "Error: database is locked"]]);
  });

  test("requests left by a previous run are kept at boot while they can still be answered (D8)", async () => {
    const first = gate();
    void first.request(ask());
    await sleep(5);
    expect(first.pending()).toHaveLength(1);

    // A new gate over the same database is what a restart looks like. `approvals-kept.test.ts` has the rest.
    const second = gate();
    const { kept, lapsed } = second.carryOver();
    expect(kept.map((request) => request.tool)).toEqual(["exec"]);
    expect(lapsed).toEqual([]);
    expect(second.pending()).toHaveLength(1);
  });
});

describe("the queue view", () => {
  test("lists pending requests in arrival order, filterable by agent", async () => {
    const g = gate();
    void g.request(ask({ tool: "exec" }));
    await sleep(2);
    void g.request(ask({ tool: "write", agentId: "nox" }));
    await sleep(5);

    expect(g.pending().map((r) => r.tool)).toEqual(["exec", "write"]);
    expect(g.pending("nox").map((r) => r.tool)).toEqual(["write"]);
  });

  test("shows the full parameters a human has to judge", async () => {
    const g = gate();
    void g.request(ask({ params: { command: ["rm", "-rf", "/important"] } }));
    await sleep(5);

    // Never truncated: a shortened command is not something anyone can approve (§7.3 SPEC).
    expect(g.pending()[0]!.params).toEqual({ command: ["rm", "-rf", "/important"] });
  });

  test("unreadable stored parameters are visible as such, not silently empty", async () => {
    const g = gate();
    void g.request(ask());
    await sleep(5);
    const id = g.pending()[0]!.id;

    db.prepare("UPDATE approvals SET params = ? WHERE id = ?").run("{not json", id);
    // Approving something whose arguments could not be read would be approving the unknown.
    expect(g.pending()[0]!.params).toEqual({ _unreadable: "{not json" });
  });
});

describe("auditing", () => {
  test("records the request and the answer, with who answered", async () => {
    const audit = new AuditLog(db);
    const g = gate(60_000, audit);

    const pending = g.request(ask());
    await sleep(5);
    g.resolve(g.pending()[0]!.id, "allow-once", "gading");
    await pending;

    const actions = audit.recent(10).map((entry) => entry.action);
    expect(actions).toContain("approval_requested");
    expect(actions).toContain("approval_resolved");

    const resolved = audit.recent(10).find((entry) => entry.action === "approval_resolved");
    expect(resolved?.actor).toBe("gading");
    expect(resolved?.details).toMatchObject({ status: "approved", tool: "exec" });
  });
});

describe("allow-always writes a durable grant", () => {
  const grantPayload = {
    grantKey: "g1:deadbeef",
    agentId: "nouva",
    argv: ["bun", "test"],
    cwd: "/ws",
    policy: { blocked: [] } satisfies ExecPolicySection,
  };

  function gateWithGrants() {
    const grants = new GrantStore(db);
    const g = track(new SqliteApprovalGate({ db, timeoutMs: 1000, grants }));
    return { g, grants };
  }

  test("persists the grant and reports the decision", async () => {
    const { g, grants } = gateWithGrants();
    const pending = g.request(ask({ grantable: true, grant: grantPayload }));
    await sleep(5);

    g.resolve(g.pending()[0]!.id, "allow-always", "gading");
    await expect(pending).resolves.toEqual({
      status: "approved",
      id: expect.stringMatching(/^apr_/),
      by: "gading",
      decision: "allow-always",
    });

    expect(grants.liveKeys("nouva").has("g1:deadbeef")).toBe(true);
    // Linked back to the request, so `nouride grants list` can show where a grant came from.
    expect(grants.list()[0]?.approvalId).toBeTruthy();
  });

  test("allow-once persists nothing", async () => {
    const { g, grants } = gateWithGrants();
    const pending = g.request(ask({ grantable: true, grant: grantPayload }));
    await sleep(5);
    g.resolve(g.pending()[0]!.id, "allow-once", "gading");
    await pending;

    expect(grants.list()).toHaveLength(0);
  });

  test("a non-grantable request runs once and persists nothing, and says so", async () => {
    // The downgrade the operator has to be told about: they clicked "always" and got "once".
    const { g, grants } = gateWithGrants();
    const pending = g.request(ask({ grantable: false, grant: grantPayload }));
    await sleep(5);

    g.resolve(g.pending()[0]!.id, "allow-always", "gading");
    await expect(pending).resolves.toEqual({
      status: "approved",
      id: expect.stringMatching(/^apr_/),
      by: "gading",
      decision: "allow-always",
      downgraded: true,
    });
    expect(grants.list()).toHaveLength(0);
  });

  test("deny persists nothing", async () => {
    const { g, grants } = gateWithGrants();
    const pending = g.request(ask({ grantable: true, grant: grantPayload }));
    await sleep(5);
    g.resolve(g.pending()[0]!.id, "deny", "gading");
    await pending;

    expect(grants.list()).toHaveLength(0);
  });

  test("answering allow-always twice leaves one grant", async () => {
    // The same prompt is answerable from chat, CLI and dashboard at once. Two rows would mean two
    // separate revocations before the permission actually stops.
    const { g, grants } = gateWithGrants();
    for (const _ of [1, 2]) {
      const pending = g.request(ask({ grantable: true, grant: grantPayload }));
      await sleep(5);
      g.resolve(g.pending()[0]!.id, "allow-always", "gading");
      await pending;
    }
    expect(grants.list()).toHaveLength(1);
  });

  test("a revoked grant stops matching but stays in the history", () => {
    const { grants } = gateWithGrants();
    const grant = grants.grant({ ...grantPayload, createdBy: "gading" });

    expect(grants.revoke(grant.id, "gading")).toBe(true);
    expect(grants.liveKeys("nouva").size).toBe(0);
    expect(grants.list()).toHaveLength(0);
    // Tombstone, not a delete: "when did I approve that, and when did I take it back" has to stay
    // answerable.
    expect(grants.list({ includeRevoked: true })).toHaveLength(1);
    expect(grants.revoke(grant.id, "gading")).toBe(false);
  });

  test("revokeAll is scoped to one agent", () => {
    const { grants } = gateWithGrants();
    grants.grant({ ...grantPayload, createdBy: "gading" });
    grants.grant({ ...grantPayload, grantKey: "g1:other", agentId: "nox", createdBy: "gading" });

    expect(grants.revokeAll("gading", "nouva")).toBe(1);
    expect(grants.liveKeys("nox").size).toBe(1);
  });

  test("touch counts usage, so an unused grant is visible as unused", () => {
    const { grants } = gateWithGrants();
    grants.grant({ ...grantPayload, createdBy: "gading" });
    expect(grants.list()[0]?.useCount).toBe(0);

    grants.touch("nouva", "g1:deadbeef");
    grants.touch("nouva", "g1:deadbeef");
    const [grant] = grants.list();
    expect(grant?.useCount).toBe(2);
    expect(grant?.lastUsedAt).toBeGreaterThan(0);
  });
});

describe("a pending request survives being read back", () => {
  test("carries its reason and grantable flag out of the database", async () => {
    // Found live: `nouride approvals` printed the command with no reason, because the reason only
    // existed in the in-process notice. A request read from the database — after a restart, or from
    // the CLI while the ask arrived in Telegram — has to explain itself.
    const g = track(new SqliteApprovalGate({ db, timeoutMs: 1000 }));
    void g.request(ask({ grantable: true, reason: "first time this agent has run this command" }));
    await sleep(5);

    const [pending] = g.pending();
    expect(pending?.reason).toBe("first time this agent has run this command");
    expect(pending?.grantable).toBe(true);
  });
});

describe("an approval can only be answered from the chat that raised it", () => {
  /**
   * The hole this closes: `pending(agentId)` filtered by agent only. So an `exec` requested in a
   * Discord channel was answerable by a bare `/approve` typed in a Telegram DM — the operator
   * approving something they had never seen, or one allowlisted person answering for another. The
   * prompt goes to one conversation, so the answer has to come from it.
   */
  const inChat = (chatId: string, gatewayId = "telegram:main") =>
    ask({ chatId, gatewayId, tool: "exec", params: { command: ["rm", "-rf", "build"] } });

  test("pendingForChat sees only its own conversation", async () => {
    const g = gate();
    void g.request(inChat("chat-A"));
    void g.request(inChat("chat-B"));
    await sleep(5);

    expect(g.pendingForChat("nouva", "telegram:main", "chat-A")).toHaveLength(1);
    expect(g.pendingForChat("nouva", "telegram:main", "chat-A")[0]?.chatId).toBe("chat-A");
  });

  test("the same chat id on another gateway is a different conversation", async () => {
    // Telegram chat `1` and Discord channel `1` are unrelated. Filtering on chat alone would merge
    // them, which is the same hole with extra steps.
    const g = gate();
    void g.request(inChat("shared-id", "telegram:main"));
    await sleep(5);

    expect(g.pendingForChat("nouva", "discord:main", "shared-id")).toHaveLength(0);
  });

  test("another agent's request is not visible either", async () => {
    const g = gate();
    void g.request(ask({ agentId: "nox", chatId: "chat-A" }));
    await sleep(5);

    expect(g.pendingForChat("nouva", "telegram:main", "chat-A")).toHaveLength(0);
  });

  test("the unscoped list still exists for the operator's own surfaces", async () => {
    // The CLI and dashboard reach the daemon through a token-guarded API, and an operator there *is*
    // entitled to answer anything. That is a different question from a chat message.
    const g = gate();
    void g.request(inChat("chat-A"));
    void g.request(inChat("chat-B"));
    await sleep(5);

    expect(g.pending("nouva")).toHaveLength(2);
  });
});

/**
 * `max_turn_duration_ms` was not a bound on a turn that was waiting for a human.
 *
 * The executor checks the abort signal at the top of each tool-loop iteration, and a turn parked inside
 * `request()` never reaches the top of another one — so it ran until the *approval* timeout instead,
 * holding its conversation's queue for all of it. Both defaults being 300s is what hid it: the two
 * timers expired together, so the deadline looked like it was working.
 */
describe("the turn's deadline", () => {
  test("an abandoned request stays answerable, and says so", async () => {
    /**
     * This used to expire the row, on the reasoning that answering it would run a command for a turn
     * that ended minutes ago. True while an answer could only release a promise — and the promise was
     * gone. It is not true now: a late answer wakes the agent instead, so throwing the question away
     * was throwing away the operator's answer before they gave it.
     *
     * `stillAnswerable` is what tells the model the difference between "no" and "not yet".
     */
    const g = gate(60_000);
    const controller = new AbortController();

    const pending = g.request(ask({ signal: controller.signal }));
    await sleep(5);
    controller.abort();
    const outcome = await Promise.race([pending, sleep(500).then(() => ({ status: "HUNG" as const }))]);

    expect(outcome.status).toBe("expired");
    expect((outcome as { stillAnswerable?: boolean }).stillAnswerable).toBe(true);
    expect(g.pending()).toHaveLength(1);
  });

  test("a signal already aborted releases the caller at once", async () => {
    // The turn can time out between the gate's decision and the request being raised.
    const g = gate(60_000);
    const outcome = await Promise.race([
      g.request(ask({ signal: AbortSignal.abort() })),
      sleep(500).then(() => ({ status: "HUNG" as const })),
    ]);
    expect(outcome.status).toBe("expired");
    expect((outcome as { stillAnswerable?: boolean }).stillAnswerable).toBe(true);
  });

  test("the caller can stop waiting long before the question closes", async () => {
    // The two clocks. `waitMs` bounds the turn; the store's timeout bounds the question. They were one
    // number, and since it matched `max_turn_duration_ms` and the turn started first, the turn always
    // died before the model could react to a refusal.
    const g = gate(60_000);
    const started = Date.now();

    const outcome = await Promise.race([
      g.request(ask({ waitMs: 40 })),
      sleep(2_000).then(() => ({ status: "HUNG" as const })),
    ]);

    expect(outcome.status).toBe("expired");
    expect((outcome as { stillAnswerable?: boolean }).stillAnswerable).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Still open. The operator's window did not shrink just because the turn stopped blocking on it.
    expect(g.pending()).toHaveLength(1);
  });

  test("an answer that arrives after the caller gave up wakes somebody", async () => {
    // Otherwise the answer is worth nothing: no promise to release, and the row quietly flips to
    // `approved` with no agent ever learning it may proceed.
    const late: { id: string; decision: string; by: string }[] = [];
    const g = track(
      new SqliteApprovalGate({
        db,
        timeoutMs: 60_000,
        onLateAnswer: (request, decision, by) => late.push({ id: request.id, decision, by }),
      }),
    );

    await g.request(ask({ waitMs: 20 }));
    const [waiting] = g.pending();
    expect(waiting).toBeDefined();

    expect(g.resolve(waiting!.id, "allow-once", "gading")).toBe(true);
    expect(late).toEqual([{ id: waiting!.id, decision: "allow-once", by: "gading" }]);
  });

  test("a denial arriving late wakes it too", async () => {
    // "They said no" is something the agent needs before it plans its next move. Finding out by trying
    // again is how an agent argues with a person who has already answered.
    const late: string[] = [];
    const g = track(
      new SqliteApprovalGate({
        db,
        timeoutMs: 60_000,
        onLateAnswer: (_request, decision) => late.push(decision),
      }),
    );

    await g.request(ask({ waitMs: 20 }));
    const [waiting] = g.pending();
    g.resolve(waiting!.id, "deny", "gading");
    expect(late).toEqual(["deny"]);
  });

  test("an answer with somebody still waiting does not also wake a second turn", async () => {
    // The ordinary path. Two turns for one approval would be one answer producing two replies.
    const late: string[] = [];
    const g = track(
      new SqliteApprovalGate({
        db,
        timeoutMs: 60_000,
        onLateAnswer: (request) => late.push(request.id),
      }),
    );

    const pending = g.request(ask());
    await sleep(5);
    const [waiting] = g.pending();
    g.resolve(waiting!.id, "allow-once", "gading");

    expect((await pending).status).toBe("approved");
    expect(late).toEqual([]);
  });

  test("an answer still wins when the turn is alive", async () => {
    // The listener must not change the normal path: a request with a live signal resolves on the human.
    const g = gate(60_000);
    const controller = new AbortController();

    const pending = g.request(ask({ signal: controller.signal }));
    await sleep(5);
    const [request] = g.pending();
    expect(g.resolve(request!.id, "allow-once", "dev")).toBe(true);

    const outcome = await Promise.race([pending, sleep(500).then(() => ({ status: "HUNG" as const }))]);
    expect(outcome.status).toBe("approved");

    // And a late abort finds nothing to do rather than double-resolving.
    controller.abort();
    expect(g.pending()).toHaveLength(0);
  });
});

/**
 * History for the reply `/approve` gives when there is nothing left to answer.
 *
 * The scoping is the part worth pinning: the operator typed into one conversation, and a request
 * raised somewhere they have never looked is not an explanation for what happened here.
 */
describe("recently settled requests in one conversation", () => {
  test("reports what expired here, newest first, and nothing from another chat", async () => {
    const g = gate(20);

    const mine = g.request(ask({ chatId: "chat-1", tool: "exec" }));
    const alsoMine = g.request(ask({ chatId: "chat-1", tool: "write" }));
    const elsewhere = g.request(ask({ chatId: "chat-2", tool: "exec" }));
    await Promise.all([mine, alsoMine, elsewhere]);

    const settled = g.recentlySettledForChat("web:dashboard", "chat-1", 0);
    expect(settled.map((r) => r.chatId)).toEqual(["chat-1", "chat-1"]);
    expect(settled.every((r) => r.status === "expired")).toBe(true);
    // Newest first: it is the request the operator was most plausibly answering.
    expect(settled[0]!.resolvedAt!).toBeGreaterThanOrEqual(settled[1]!.resolvedAt!);
  });

  test("a request still waiting is not history", async () => {
    // It would be answered rather than explained, so including it would make `/approve` describe a
    // request it should have resolved.
    const g = gate(60_000);
    void g.request(ask({ chatId: "chat-1" }));
    await sleep(5);

    expect(g.recentlySettledForChat("web:dashboard", "chat-1", 0)).toEqual([]);
  });

  test("anything older than the cutoff is left out", async () => {
    const g = gate(20);
    await g.request(ask({ chatId: "chat-1" }));

    expect(g.recentlySettledForChat("web:dashboard", "chat-1", Date.now() + 10_000)).toEqual([]);
  });

  test("a different gateway instance in the same chat id is not this conversation", async () => {
    // Chat ids are only unique per platform instance; two bots can both have a "chat-1".
    const g = gate(20);
    await g.request(ask({ chatId: "chat-1", gatewayId: "telegram:bot" }));

    expect(g.recentlySettledForChat("web:dashboard", "chat-1", 0)).toEqual([]);
    expect(g.recentlySettledForChat("telegram:bot", "chat-1", 0)).toHaveLength(1);
  });
});

/**
 * Pruning the settled ones, and never the pending one.
 *
 * This table was not swept at all. Three weeks of a live install left every approval since day one —
 * 208 rows, none of them pending — while five other tables were being pruned daily beside it. Not
 * urgent at that rate, and not bounded either, which is the only property that matters for a table
 * nobody reads.
 */
describe("retention", () => {
  const day = 24 * 60 * 60_000;

  /** A settled row, written straight to the table — `resolve` needs a live waiter and a clock. */
  function settled(id: string, requestedAt: number, status = "approved") {
    db.prepare(
      `INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, status, requested_at, resolved_at)
       VALUES (?, 'nouva', 'c1', 'web:dashboard', 'exec', '{}', ?, ?, ?)`,
    ).run(id, status, requestedAt, requestedAt + 1000);
  }

  test("drops settled requests past the window and keeps the recent ones", () => {
    const now = Date.parse("2026-09-06T10:00:00.000Z");
    settled("old", now - 40 * day);
    settled("recent", now - 2 * day);

    expect(gate().sweep(30, now)).toBe(1);
    expect(
      db.prepare<{ id: string }>("SELECT id FROM approvals").all().map((r) => r.id),
    ).toEqual(["recent"]);
  });

  test("a pending request is never dropped, however old", async () => {
    /**
     * The one row here that is still doing something. An old pending approval is not stale — it is a
     * turn parked on an answer that never came, and deleting it strands that turn on a question
     * nobody can now find. `status != 'pending'` is what makes the cutoff safe.
     */
    const now = Date.parse("2026-09-06T10:00:00.000Z");
    const g = gate();
    const waiting = g.request(ask());
    await sleep(5);
    // Backdate it well past any window.
    db.prepare("UPDATE approvals SET requested_at = ?").run(now - 400 * day);

    expect(g.sweep(30, now)).toBe(0);
    expect(g.pending()).toHaveLength(1);

    // Answered so the afterEach hook is not left disarming a live timer.
    g.resolve(g.pending()[0]!.id, "allow-once", "t");
    await waiting;
  });

  test("zero keeps everything, matching every other retention knob", () => {
    // The opposite reading would make a mistyped zero delete the record on the next sweep.
    settled("old", 1000);
    expect(gate().sweep(0)).toBe(0);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM approvals").get()?.n).toBe(1);
  });
});
