/**
 * What skill learning holds and what it did lately, as the Skills page reads it (`GET /skills/learning/seen`), with
 * the two things a person can do about a held kind of work, and the replay that measures a change to the pass.
 *
 * Against the real audit log and the real routes, over an engine a test scripts: what the page shows is read from the
 * rows learning itself wrote.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { LearningSeen } from "@nouride/wire";
import { openAndMigrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";
import { registerDraftRoutes } from "@/modules/web/control/routes/drafts.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let clock: number;
let audit: AuditLog;
let app: Hono<{ Variables: { principal: unknown } }>;
let role = "operator";
let calls: string[];
let held: { name: string; description: string; why: string; agentId: string; sessionId: string; firstSeenAt: number; lastSeenAt: number; sightings: number; kept: boolean }[];

beforeEach(async () => {
  dir = tempDir("skill-seen");
  db = await openAndMigrate(join(dir, "test.db"));
  clock = 1_000_000;
  audit = new AuditLog(db, () => clock);
  role = "operator";
  calls = [];
  held = [{ name: "restart-stuck-ingress", description: "Use when the ingress answers 502.", why: "a fix that worked", agentId: "nouva", sessionId: "ses_1", firstSeenAt: 10, lastSeenAt: 20, sightings: 3, kept: true }];
  const reflection = {
    candidates: () => held,
    writeCandidate: async (name: string, by: string) => {
      calls.push(`write ${name} by ${by}`);
      if (name === "gone") return { ok: false as const, why: "gone" as const, error: "the conversation it was seen in is gone" };
      if (name === "refused") return { ok: false as const, why: "nothing" as const, error: "its draft was refused: it names a machine's address (172.16.42.8)" };
      if (name === "other") return { ok: false as const, why: "not_held" as const, error: 'no class of work "other" is held' };
      return { ok: true as const, draft: { id: "dft_1", name, files: [], carries: [], retire: [], removeFiles: [] } };
    },
    forgetCandidate: (name: string, by: string) => (calls.push(`forget ${name} by ${by}`), name === "restart-stuck-ingress"),
    tryOut: async (asked: { agentId: string; transcript: string }) => (calls.push(`try ${asked.agentId}`), asked.agentId === "nobody" ? { error: 'no agent "nobody"' } : { decision: "nothing", why: "nothing done", calls: 1 }),
  } as unknown as ReflectionEngine;
  app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role });
    await next();
  });
  registerDraftRoutes(app as never, { audit, reflection, ctx: { config: { skills: { learning: { mode: "ask", model: "", notifyChat: true } } } } } as never);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** One row as learning writes it, a second later than the last. */
const did = (action: string, details: Record<string, unknown>, agentId = "nouva") => {
  clock += 1000;
  audit.record({ action, agentId, details });
};

describe("what learning holds and did, as the page reads it", () => {
  test("each held kind of work, with how often it was seen and whether it can be written now", async () => {
    const seen = (await (await app.request("/skills/learning/seen")).json()) as LearningSeen;
    expect(seen.seen).toEqual([{ name: "restart-stuck-ingress", description: "Use when the ingress answers 502.", why: "a fix that worked", agentId: "nouva", firstSeenAt: 10, lastSeenAt: 20, sightings: 3, canWrite: true }]);
    expect(seen.recent).toEqual([]);
  });

  test("the last things it did, newest first, each with its reason", async () => {
    did("skill_pass_nothing", { why: "a number looked up, nothing done", trigger: "sustained_effort" });
    did("skill_candidate_held", { skill: "restart-stuck-ingress", description: "Use when the ingress answers 502." });
    did("skill_draft_refused", { skill: "site-contributing", reason: "its body is 12,838 characters, past 12,000" }, "nexa");
    did("tool_exec", { tool: "exec" });
    const { recent } = (await (await app.request("/skills/learning/seen")).json()) as LearningSeen;
    expect(recent.map((event) => [event.kind, event.agentId, event.skill, event.why])).toEqual([
      ["refused", "nexa", "site-contributing", "its body is 12,838 characters, past 12,000"],
      ["held", "nouva", "restart-stuck-ingress", "Use when the ingress answers 502."],
      ["nothing", "nouva", null, "a number looked up, nothing done"],
    ]);
  });

  test("a draft that was written is one line, not two; one still waiting is its own", async () => {
    did("skill_draft_created", { draft: "dft_1", skill: "site-moving", trigger: "mission" });
    did("skill_draft_approved", { draft: "dft_1", skill: "site-moving" });
    did("skill_draft_created", { draft: "dft_2", skill: "invoice-reading", trigger: "sustained_effort" });
    did("skill_draft_created", { draft: "dft_3", skill: "site-contributing", trigger: "sustained_effort" });
    did("skill_draft_updated", { draft: "dft_3", skill: "site-contributing" });
    const { recent } = (await (await app.request("/skills/learning/seen")).json()) as LearningSeen;
    expect(recent.map((event) => [event.kind, event.skill])).toEqual([["improved", "site-contributing"], ["drafted", "invoice-reading"], ["written", "site-moving"]]);
  });

  test("only the newest twelve are sent", async () => {
    for (let n = 0; n < 15; n += 1) did("skill_pass_nothing", { why: `reason ${n}` });
    const { recent } = (await (await app.request("/skills/learning/seen")).json()) as LearningSeen;
    expect(recent).toHaveLength(12);
    expect(recent[0]?.why).toBe("reason 14");
  });
});

describe("a held kind of work, on a person's word", () => {
  test("written now: the draft comes back, under the name of who asked", async () => {
    const answer = await post("/skills/learning/seen/restart-stuck-ingress/write");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: true, draft: { id: "dft_1", name: "restart-stuck-ingress" } });
    expect(calls).toEqual(["write restart-stuck-ingress by gading"]);
  });

  test("what could not be written is said in the page's words, with the reason beside them", async () => {
    const gone = await post("/skills/learning/seen/gone/write");
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: "the conversation it was seen in is gone", plain: "The conversation it was seen in is gone, so there is nothing to write it from. It is written when the work comes back." });
    const refused = await post("/skills/learning/seen/refused/write");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "its draft was refused: it names a machine's address (172.16.42.8)", plain: "The agent looked at that conversation again and no skill was kept from it." });
    const other = await post("/skills/learning/seen/other/write");
    expect(other.status).toBe(404);
    expect(((await other.json()) as { plain: string }).plain).toBe("That kind of work is not held any more.");
  });

  test("forgotten, and one that is not held is not found", async () => {
    expect((await app.request("/skills/learning/seen/restart-stuck-ingress", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/skills/learning/seen/other", { method: "DELETE" })).status).toBe(404);
    expect(calls).toEqual(["forget restart-stuck-ingress by gading", "forget other by gading"]);
  });

  test("somebody who may only look can do neither", async () => {
    role = "viewer";
    expect((await post("/skills/learning/seen/restart-stuck-ingress/write")).status).toBe(403);
    expect((await app.request("/skills/learning/seen/restart-stuck-ingress", { method: "DELETE" })).status).toBe(403);
    expect(calls).toEqual([]);
    // Looking is theirs.
    expect((await app.request("/skills/learning/seen")).status).toBe(200);
  });
});

describe("the replay of a recorded conversation", () => {
  test("an admin's, with the agent and the conversation said", async () => {
    role = "admin";
    const answer = await post("/skills/learning/try", { agent: "nouva", transcript: "user: jam berapa?" });
    expect(await answer.json()).toEqual({ decision: "nothing", why: "nothing done", calls: 1 });
    expect((await post("/skills/learning/try", { agent: "nouva" })).status).toBe(400);
    expect((await post("/skills/learning/try", { agent: "nobody", transcript: "x" })).status).toBe(400);
  });

  test("it spends a model on what the caller sends, so an operator may not", async () => {
    expect((await post("/skills/learning/try", { agent: "nouva", transcript: "user: hi" })).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
