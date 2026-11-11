/**
 * How a conversation ends: `/new`, `/reset`, a rollover and a delete from the dashboard, through one function.
 *
 * Each was its own hand-kept list, and the deletes fell behind: a conversation deleted from the dashboard kept its
 * `/model` override and its spilled tool output — both keyed by a session id the next conversation in that chat
 * inherits — and the approvals it was waiting on stayed answerable, so a late "yes" woke the agent in a conversation
 * with no context for it. Two halves here: what each way of ending does, written out by hand rather than read back from
 * the table that decides it; and a real delete through the dashboard's route, against the stores, beside another
 * agent's conversation in the same chat that must come through untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { OutboundRegistry } from "@nouride/persona";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { sessionIdFor, type SessionKey } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { ON_CONVERSATION_DELETE } from "@/db/keys.ts";
import { ChatEventStore } from "@/modules/chat-events/chat-events.store.ts";
import { ModelOverrides } from "@/modules/hooks/model-overrides.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import { endConversation, type ConversationEndDeps, type EndMode } from "@/modules/pipeline/conversation-end.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { registerChatRoutes } from "@/modules/web/control/routes/chat.ts";
import { tempDir, turnStore } from "../helpers.ts";

const NOUVA: SessionKey = { agentId: "nouva", gatewayId: "telegram:main", chatId: "-1001" };

/** Every collaborator, recording what it was asked to do, in order. */
function recording(options: { cutFails?: boolean } = {}) {
  const calls: string[] = [];
  const deps: ConversationEndDeps = {
    sessions: {
      clear: () => void calls.push("clear the context"),
      delete: (id) => (calls.push(`delete the session ${id}`), true),
    },
    turns: { deleteForSession: (id) => (calls.push(`delete the turns of ${id}`), 2) },
    chatEvents: { deleteForChat: (gatewayId, chatId) => (calls.push(`delete the notices of ${gatewayId} ${chatId}`), 1) },
    spill: { forget: (scope) => void calls.push(`forget the spill of ${scope.agentId} ${scope.sessionId}`) },
    approvals: {
      expireAll: (agentId, chat) => (calls.push(chat ? `expire ${agentId}'s approvals in ${chat.gatewayId} ${chat.chatId}` : `expire ${agentId}'s approvals everywhere`), 3),
    },
    memory: {
      cut: async (gatewayId, chatId) => {
        calls.push(`cut ${gatewayId} ${chatId} into memory`);
        if (options.cutFails) throw new Error("disk full");
        return 1;
      },
    },
    authorship: { setHops: (platform, chatId, hops) => void calls.push(`set the hop count in ${platform} ${chatId} to ${hops}`) },
    modelOverrides: { clear: (id) => void calls.push(`drop the model override of ${id}`), clearEffort: (id) => void calls.push(`drop the effort of ${id}`) },
    stopTurns: (agentId, chatId) => (calls.push(`stop ${agentId}'s turns in ${chatId}`), 1),
    platformOf: (gatewayId) => gatewayId.split(":")[0]!,
    forgetCliSession: (agentId, gatewayId, chatId) => void calls.push(`let ${agentId}'s CLI session in ${gatewayId} ${chatId} go`),
  };
  return { calls, deps };
}

const SESSION = sessionIdFor(NOUVA);

/** What each way does, in the order it does it — written out, so a change to `ENDS` is a change made here too. */
const DOES: Record<EndMode, string[]> = {
  new: [
    "cut telegram:main -1001 into memory",
    "clear the context",
    "set the hop count in telegram -1001 to 0",
    "delete the notices of telegram:main -1001",
    `forget the spill of nouva ${SESSION}`,
    "let nouva's CLI session in telegram:main -1001 go",
  ],
  reset: [
    "cut telegram:main -1001 into memory",
    "clear the context",
    "set the hop count in telegram -1001 to 0",
    "delete the notices of telegram:main -1001",
    `forget the spill of nouva ${SESSION}`,
    `drop the model override of ${SESSION}`,
    `drop the effort of ${SESSION}`,
    "expire nouva's approvals everywhere",
    "let nouva's CLI session in telegram:main -1001 go",
  ],
  rollover: [
    "clear the context",
    "set the hop count in telegram -1001 to 0",
    `forget the spill of nouva ${SESSION}`,
    `drop the model override of ${SESSION}`,
    `drop the effort of ${SESSION}`,
    "let nouva's CLI session in telegram:main -1001 go",
  ],
  delete: [
    "stop nouva's turns in -1001",
    `delete the turns of ${SESSION}`,
    `delete the session ${SESSION}`,
    "set the hop count in telegram -1001 to 0",
    "delete the notices of telegram:main -1001",
    `forget the spill of nouva ${SESSION}`,
    `drop the model override of ${SESSION}`,
    `drop the effort of ${SESSION}`,
    "expire nouva's approvals in telegram:main -1001",
    "let nouva's CLI session in telegram:main -1001 go",
  ],
};

describe("each way of ending a conversation", () => {
  for (const mode of Object.keys(DOES) as EndMode[]) {
    test(`${mode}: does what it says, in order`, async () => {
      const { calls, deps } = recording();
      await endConversation(deps, NOUVA, mode);
      expect(calls).toEqual(DOES[mode]);
    });
  }

  test("a delete of a row stored under another id ends that row, not the one its key would name", async () => {
    const { calls, deps } = recording();
    await endConversation(deps, { ...NOUVA, sessionId: "ses_legacy" }, "delete");
    expect(calls).toContain("delete the session ses_legacy");
    expect(calls).toContain("drop the model override of ses_legacy");
    expect(calls).toContain("drop the effort of ses_legacy");
  });

  test("a cut memory could not write is no reason for a reset to stop — tonight's pass files it", async () => {
    const { calls, deps } = recording({ cutFails: true });
    const ended = await endConversation(deps, NOUVA, "reset");
    expect(ended.cut).toBeUndefined();
    expect(calls).toEqual(DOES.reset);
    expect(ended.expired).toBe(3);
  });
});

// ── A delete, through the dashboard's route, against the stores ─────────────

let dir: string;
let db: SqliteDb;
let gate: SqliteApprovalGate;

beforeEach(async () => {
  dir = tempDir("conversation-end");
  db = await openAndMigrate(join(dir, "test.db"));
  gate = new SqliteApprovalGate({ db, timeoutMs: 60_000 });
});

afterEach(() => {
  gate.shutDown();
  db.close();
  removePath(dir);
});

const ask = (agentId: string): ApprovalAsk => ({
  agentId,
  chatId: NOUVA.chatId,
  gateway: "telegram",
  gatewayId: NOUVA.gatewayId,
  senderId: "814",
  tool: "exec",
  params: { command: ["ls"] },
  grantable: false,
  autoCoverable: true,
  reason: "first time",
});

describe("deleting a conversation from the dashboard", () => {
  test("leaves nothing of it — its record, stream, spill, model override, open approvals — and nothing of a neighbour's is touched", async () => {
    const sessions = new SessionStore(db);
    const turns = turnStore(db);
    const spill = new ToolOutputSpill(join(dir, "tool-output"));
    const overrides = new ModelOverrides(sessions);
    const deps: ConversationEndDeps = {
      sessions,
      turns,
      chatEvents: new ChatEventStore(db),
      spill,
      approvals: gate,
      authorship: new OutboundRegistry(),
      modelOverrides: overrides,
      stopTurns: () => 0,
      platformOf: (gatewayId) => gatewayId.split(":")[0]!,
    };

    // Two agents in one group, each with its own conversation.
    const NIX: SessionKey = { ...NOUVA, agentId: "nix" };
    const answers: Promise<{ status: string }>[] = [];
    for (const key of [NOUVA, NIX]) {
      const id = sessionIdFor(key);
      sessions.save(key, [{ role: "user", content: "hi" }], 1);
      const turn = turns.begin({ sessionId: id, ...key, prompt: "hi" });
      turns.finish(turn, { status: "done", reply: "hello" });
      writeFileSync(spill.pathFor({ agentId: key.agentId, sessionId: id, callId: "call_1" }), "a large output");
      overrides.set(key, "a-cheaper-model");
      answers.push(gate.request(ask(key.agentId)));
    }

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("principal" as never, { actor: "admin", role: "admin" } as never);
      await next();
    });
    registerChatRoutes(app as never, {
      sessions,
      ctx: { config: { people: [] } },
      audit: { record: () => {} },
      pipeline: { endConversation: (conversation: Parameters<typeof endConversation>[1], mode: EndMode) => endConversation(deps, conversation, mode) },
    } as never);
    const res = await app.request(`/sessions/${encodeURIComponent(sessionIdFor(NOUVA))}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, turns: 1 });

    const nouva = sessionIdFor(NOUVA);
    const nix = sessionIdFor(NIX);
    const count = (sql: string, ...params: string[]) => db.prepare<{ n: number }>(sql).get(...params)!.n;
    // What `db/keys.ts` says a delete takes, gone for this conversation and kept for the other.
    expect(ON_CONVERSATION_DELETE.sessions).toBe("deleted");
    expect([count("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", nouva), count("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", nix)]).toEqual([0, 1]);
    expect([count("SELECT COUNT(*) AS n FROM turn_records WHERE session_id = ?", nouva), count("SELECT COUNT(*) AS n FROM turn_records WHERE session_id = ?", nix)]).toEqual([0, 1]);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE agent_id = 'nouva'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE agent_id = 'nix'")).toBeGreaterThan(0);
    // The files the next conversation in this chat would otherwise have been handed.
    expect(existsSync(spill.pathFor({ agentId: "nouva", sessionId: nouva, callId: "call_1" }))).toBe(false);
    expect(existsSync(spill.pathFor({ agentId: "nix", sessionId: nix, callId: "call_1" }))).toBe(true);
    expect([overrides.get(nouva), overrides.get(nix)]).toEqual([undefined, "a-cheaper-model"]);
    // The question it was waiting on is closed, and a late answer has nothing left to wake.
    expect((await answers[0])!.status).toBe("expired");
    expect(gate.pending().map((request) => request.agentId)).toEqual(["nix"]);
  });
});

describe("a chat's /model and /effort, after each ending and a restart", () => {
  /** Whether each ending keeps them: `/new` does (§9.4 SPEC), the rest drop them. */
  const KEEPS: Record<EndMode, boolean> = { new: true, reset: false, rollover: false, delete: false };

  for (const mode of Object.keys(KEEPS) as EndMode[]) {
    test(`${mode}: ${KEEPS[mode] ? "keeps" : "drops"} them on the row the next process reads`, async () => {
      const sessions = new SessionStore(db);
      const overrides = new ModelOverrides(sessions);
      sessions.save(NOUVA, [{ role: "user", content: "hi" }], 1);
      overrides.set(NOUVA, "a-cheaper-model");
      overrides.setEffort(NOUVA, "high");

      await endConversation({ ...recording().deps, sessions, modelOverrides: overrides }, NOUVA, mode);

      // The next process: a store and overrides of its own over the same database.
      const next = new ModelOverrides(new SessionStore(db));
      expect([next.get(SESSION), next.effortOf(SESSION)]).toEqual(KEEPS[mode] ? ["a-cheaper-model", "high"] : [undefined, undefined]);
    });
  }
});
