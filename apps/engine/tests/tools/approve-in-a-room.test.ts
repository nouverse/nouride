/**
 * Who may answer an approval from a chat (S8). In a room, the person whose message asked, or an admin — anyone else
 * admitted there could otherwise approve another person's risky command, mint a standing grant for it, or sweep the
 * room's queue with `/approve all`. In a DM nobody else is there. The CLI and the dashboard are the operator's, and
 * answer anything; that is not decided here.
 *
 * Wired as the daemon wires it: the real gate keeps who asked, and the real hooks decide on it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { ChatType } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { answerAllApprovals, answerApproval, drainCoveredPending } from "@/modules/hooks/pending.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { sleep, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let gate: SqliteApprovalGate;

beforeEach(async () => {
  dir = tempDir("approve-in-a-room");
  db = await openAndMigrate(join(dir, "test.db"));
  gate = new SqliteApprovalGate({ db, timeoutMs: 60_000 });
});

afterEach(() => {
  gate.shutDown();
  db.close();
  removePath(dir);
});

const ROOM = { gatewayId: "telegram:bot", chatId: "room-1" };

/** A request raised by `senderId`'s turn in the room, left waiting. */
async function asked(senderId: string, tool = "exec", where = ROOM): Promise<string> {
  const ask: ApprovalAsk = {
    agentId: "nouva",
    ...where,
    gateway: "telegram",
    senderId,
    tool,
    params: { command: ["rm", "-rf", "build"] },
    grantable: true,
    autoCoverable: true,
    // The class the gate stores with the row, as the persona tool's and the `nouride` tool's asks carry it.
    ...(tool === "persona" ? { hardlineClass: "persona" as const } : tool === "nouride" ? { hardlineClass: "people" as const } : {}),
    reason: "first time",
  };
  void gate.request(ask).catch(() => {});
  await sleep(5);
  return gate.pendingForChat("nouva", where.gatewayId, where.chatId).at(-1)!.id;
}

function said(senderId: string, options: { chatType?: ChatType; admin?: boolean; where?: typeof ROOM } = {}): HookContext {
  const where = options.where ?? ROOM;
  return {
    agent: { config: { id: "nouva" } },
    ...where,
    senderId,
    args: [],
    envelope: { ...where, senderId, chatType: options.chatType ?? "group" },
    deps: {
      registry: { enabled: () => [{ config: { id: "nouva" } }] },
      approvals: gate,
      isAdmin: () => options.admin === true,
    },
  } as unknown as HookContext;
}

const status = (id: string) => (db.prepare<{ status: string }>("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status;

describe("in a room", () => {
  test("the gate keeps who asked, while the request waits, and not after", async () => {
    const id = await asked("alice");
    expect(gate.pendingForChat("nouva", ROOM.gatewayId, ROOM.chatId)[0]).toMatchObject({ id, requestedBy: "alice" });
    gate.resolve(id, "deny", "alice");
    // Per request, for the life of the process: kept past its answer, it is a map that only grows.
    expect((gate as unknown as { requesters: Map<string, string> }).requesters.size).toBe(0);
  });

  test("someone else's request is not theirs to approve or deny, bare or by id", async () => {
    const id = await asked("alice");
    for (const answer of [() => answerApproval(said("bob"), "allow-always"), () => answerApproval(said("bob"), "allow-once", id), () => answerApproval(said("bob"), "deny", id)]) {
      expect((await answer()).reply).toContain("asked for by someone else here");
    }
    expect(status(id)).toBe("pending");
  });

  test("the person who asked may, and so may an admin", async () => {
    const mine = await asked("alice");
    expect((await answerApproval(said("alice"), "allow-once", mine)).reply).toBe(`Approved \`${mine}\`.`);
    const theirs = await asked("alice");
    expect((await answerApproval(said("carol", { admin: true }), "deny", theirs)).reply).toBe(`Denied \`${theirs}\`.`);
    expect([status(mine), status(theirs)]).toEqual(["approved", "denied"]);
  });

  test("`/approve all` answers what the sender asked for and says what it left; an admin's answers everything", async () => {
    const alices = await asked("alice", "exec");
    const bobs = await asked("bob", "write");
    const reply = (await answerAllApprovals(said("bob"), "allow-once")).reply!;
    expect(reply).toBe("Approved 1 request(s). 1 more was asked for by someone else here: only they, or an admin, can answer it.");
    expect([status(alices), status(bobs)]).toEqual(["pending", "approved"]);

    expect((await answerAllApprovals(said("dave"), "allow-once")).reply).toBe("The request waiting was asked for by someone else here: only they, or an admin, can answer it.");
    expect((await answerAllApprovals(said("carol", { admin: true }), "allow-once")).reply).toBe("Approved 1 request(s).");
    expect(status(alices)).toBe("approved");
  });

  test("`/approvals balanced` drains only what the sender asked for", async () => {
    const alices = await asked("alice");
    const bobs = await asked("bob");
    expect(drainCoveredPending(said("bob")).drained).toBe(1);
    expect([status(alices), status(bobs)]).toEqual(["pending", "approved"]);
  });
});

describe("in a DM", () => {
  test("the person in it answers anything waiting there — a job's request included", async () => {
    const dm = { gatewayId: "telegram:bot", chatId: "dm-alice" };
    const id = await asked("cron", "exec", dm);
    expect((await answerApproval(said("alice", { chatType: "dm", where: dm }), "allow-once")).reply).toBe(`Approved \`${id}\`.`);
  });

  test("a change to an agent's persona is an admin's alone — the person in it is told so, their own request too (0.8.8)", async () => {
    const dm = { gatewayId: "telegram:bot", chatId: "dm-alice" };
    const id = await asked("alice", "persona", dm);
    const alice = said("alice", { chatType: "dm", where: dm });
    expect((await answerApproval(alice, "allow-once")).reply).toBe("Only an admin can answer this one: it changes an agent's persona.");
    expect((await answerAllApprovals(alice, "allow-once")).reply).toBe("The request waiting is an admin's alone to answer: it changes an agent's persona.");
    expect(status(id)).toBe("pending");
    expect((await answerApproval(said("alice", { chatType: "dm", where: dm, admin: true }), "deny")).reply).toBe(`Denied \`${id}\`.`);
  });

  test("an id from another conversation is refused, however it was learned", async () => {
    const elsewhere = await asked("alice");
    const dm = { gatewayId: "telegram:bot", chatId: "dm-alice" };
    await asked("alice", "exec", dm);
    expect((await answerApproval(said("alice", { chatType: "dm", where: dm }), "allow-once", elsewhere)).reply).toBe(`\`${elsewhere}\` is not waiting for an answer here.`);
    expect(status(elsewhere)).toBe("pending");
  });
});
