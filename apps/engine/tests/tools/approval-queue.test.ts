/**
 * The approval gate, once two things can ask at the same time.
 *
 * `ask_agent` is parallel-safe now, so two peer turns run concurrently and either of them can stop
 * for a human. These tests pin the half of that which is not about speed at all: a conversation gets
 * one question at a time, the queue behind it is honest, and nothing that is merely *waiting its
 * turn* loses the window it has not been given yet.
 *
 * The unit rules live in `approval-floor.test.ts`. This is the wiring: the timer, the row, and what
 * the CLI and the dashboard can still reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import {
  SqliteApprovalGate,
  type ApprovalNotice,
} from "@/modules/tools/approvals.store.ts";
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
  dir = tempDir("approval-queue");
  db = await openAndMigrate(join(dir, "test.db"));
});

const gates: SqliteApprovalGate[] = [];

afterEach(() => {
  // Before the database closes, or a pending timer fires against a closed one and bun blames
  // whichever test happens to be running. Same lesson as `approval.test.ts`.
  for (const created of gates) created.shutDown();
  gates.length = 0;
  db.close();
  removePath(dir);
});

/** A gate plus the prompts it posted, in order. */
function gate(timeoutMs = 60_000) {
  const posted: ApprovalNotice[] = [];
  const created = new SqliteApprovalGate({
    db,
    timeoutMs,
    onRequest: (notice) => void posted.push(notice),
  });
  gates.push(created);
  return { gate: created, posted };
}

/** Ignore the promise: these requests are answered or expired, never awaited for their own sake. */
function fire(g: SqliteApprovalGate, a: ApprovalAsk): void {
  void g.request(a).catch(() => {});
}

describe("one question at a time", () => {
  test("a second request in the same chat is not posted until the first is answered", async () => {
    const { gate: g, posted } = gate();

    fire(g, ask({ tool: "exec" }));
    fire(g, ask({ tool: "write", agentId: "nexa" }));
    await sleep(10);

    // Two prompts racing into one chat is a question nobody can answer — a bare `/approve` cannot
    // tell them apart, and neither can the person reading it.
    expect(posted.map((n) => n.request.tool)).toEqual(["exec"]);
    expect(g.pending()).toHaveLength(2);

    g.resolve(posted[0]!.request.id, "allow-once", "gading");
    await sleep(10);
    expect(posted.map((n) => n.request.tool)).toEqual(["exec", "write"]);
  });

  test("the prompt says how many are behind it", async () => {
    const { gate: g, posted } = gate();

    fire(g, ask());
    fire(g, ask({ tool: "write" }));
    fire(g, ask({ tool: "read" }));
    await sleep(10);

    // Nothing was behind the first one when it went up: two arrived afterwards, and a prompt cannot
    // claim a number it could not have known when it was written.
    expect(posted[0]!.queuedBehind).toBe(0);

    g.resolve(posted[0]!.request.id, "allow-once", "gading");
    await sleep(10);
    expect(posted[1]!.queuedBehind).toBe(1);
  });

  test("a denial hands the floor on exactly as an approval does", async () => {
    // Saying no to one agent must not leave the next one's question unasked. This is the "deny one
    // is not deny all" property, from the gate's side.
    const { gate: g, posted } = gate();

    fire(g, ask({ agentId: "nix" }));
    fire(g, ask({ agentId: "nexa", tool: "write" }));
    await sleep(10);

    g.resolve(posted[0]!.request.id, "deny", "gading");
    await sleep(10);
    expect(posted.map((n) => n.request.agentId)).toEqual(["nix", "nexa"]);
  });

  test("a question in another conversation never waits behind this one", async () => {
    // Making two chats wait for each other is a deadlock dressed as politeness: the person in the
    // second one cannot answer the first one's question and has no way to know they are behind it.
    const { gate: g, posted } = gate();

    fire(g, ask({ chatId: "chat-1" }));
    fire(g, ask({ chatId: "chat-2" }));
    await sleep(10);

    expect(posted.map((n) => n.request.chatId)).toEqual(["chat-1", "chat-2"]);
  });
});

describe("the clock starts when somebody is asked", () => {
  test("a queued request keeps its whole window once it is finally shown", async () => {
    // The bug this is here to prevent: a five-minute window that spends four of those minutes behind
    // somebody else's question is a request that expires shortly after the person first reads it.
    const { gate: g, posted } = gate(200);

    fire(g, ask({ tool: "exec" }));
    fire(g, ask({ tool: "write" }));

    // The first expires on its own timer at ~200ms and the second goes up in its place.
    await sleep(320);

    expect(posted.map((n) => n.request.tool)).toEqual(["exec", "write"]);
    const waiting = g.pending();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.tool).toBe("write");
    // Counted from when it was posted, so it is still answerable here. With the old clock it died at
    // the same instant it appeared.
    expect(g.resolve(waiting[0]!.id, "allow-once", "gading")).toBe(true);
  });
});

describe("what a queued request still is", () => {
  test("it is pending, and the CLI and dashboard can answer it", async () => {
    // Holding the floor is about *delivery*, not about being answerable. An operator reaching the
    // daemon through a token-guarded surface is entitled to answer anything.
    const { gate: g, posted } = gate();

    fire(g, ask({ tool: "exec" }));
    fire(g, ask({ tool: "write" }));
    await sleep(10);

    const queued = g.pending().find((request) => request.tool === "write")!;
    expect(queued.status).toBe("pending");
    expect(g.resolve(queued.id, "deny", "cli")).toBe(true);

    // And it never gets posted afterwards: answered is answered, wherever the answer came from.
    g.resolve(posted[0]!.request.id, "allow-once", "gading");
    await sleep(10);
    expect(posted).toHaveLength(1);
  });

  test("the chat is told which request it is showing", async () => {
    const { gate: g, posted } = gate();

    fire(g, ask({ tool: "exec" }));
    fire(g, ask({ tool: "write" }));
    await sleep(10);

    // What a bare `/approve` resolves to when two are pending: the one on screen is the only one the
    // person could have meant.
    expect(g.displayedForChat("web:dashboard", "chat-1")).toBe(posted[0]!.request.id);
    expect(g.displayedForChat("web:dashboard", "chat-elsewhere")).toBeNull();
  });
});

describe("answering in bulk", () => {
  test("`/approve all` does not post a prompt for something it is answering", async () => {
    // The prompt is posted asynchronously and the answer lands synchronously, so without `stopShowing`
    // the second question arrives in the chat a moment *after* the operator already approved it.
    const { gate: g, posted } = gate();

    fire(g, ask({ tool: "exec" }));
    fire(g, ask({ tool: "write" }));
    fire(g, ask({ tool: "read" }));
    await sleep(10);
    expect(posted).toHaveLength(1);

    const waiting = g.pending();
    g.stopShowing(waiting.map((request) => request.id));
    for (const request of waiting) g.resolve(request.id, "allow-once", "gading");
    await sleep(10);

    expect(posted).toHaveLength(1);
    expect(g.pending()).toHaveLength(0);
  });

  test("a partial drain still asks about what it did not cover", async () => {
    // `/approvals balanced` answers what auto-approval covers and leaves the hardline ones. Those still need a
    // human, so they still have to reach one — the floor passes to the first survivor.
    const { gate: g, posted } = gate();

    fire(g, ask({ tool: "exec" }));
    fire(g, ask({ tool: "write" }));
    fire(g, ask({ tool: "read" }));
    await sleep(10);

    const waiting = g.pending();
    const covered = waiting.filter((request) => request.tool !== "read");
    g.stopShowing(covered.map((request) => request.id));
    for (const request of covered) g.resolve(request.id, "allow-once", "gading");
    await sleep(10);

    expect(posted.map((n) => n.request.tool)).toEqual(["exec", "read"]);
  });
});

describe("expiring in bulk", () => {
  test("nothing is posted on its way out", async () => {
    // `expireAll` finishes a list one at a time, and each finish hands the floor on — which without
    // care is to the next request on the same list. The operator would watch a prompt appear and
    // expire in the same instant.
    const { gate: g, posted } = gate();

    fire(g, ask({ tool: "exec" }));
    fire(g, ask({ tool: "write" }));
    fire(g, ask({ tool: "read" }));
    await sleep(10);

    expect(g.expireAll()).toBe(3);
    await sleep(10);
    expect(posted).toHaveLength(1);
    expect(g.pending()).toHaveLength(0);
    expect(g.displayedForChat("web:dashboard", "chat-1")).toBeNull();
  });

  test("one agent's reset leaves another agent's question to be asked", async () => {
    const { gate: g, posted } = gate();

    fire(g, ask({ agentId: "nouva", tool: "exec" }));
    fire(g, ask({ agentId: "nouva", tool: "write" }));
    fire(g, ask({ agentId: "nexa", tool: "read" }));
    await sleep(10);

    expect(g.expireAll("nouva")).toBe(2);
    await sleep(10);

    expect(posted.map((n) => n.request.agentId)).toEqual(["nouva", "nexa"]);
    expect(g.displayedForChat("web:dashboard", "chat-1")).toBe(posted[1]!.request.id);
  });
});
