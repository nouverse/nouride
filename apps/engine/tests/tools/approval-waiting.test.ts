/**
 * A turn's `waiting` step names the approval it waits on (`approvalId`, stream 1.2).
 *
 * It was written before `approvals.request()` made the request, so it could name the call and never the approval — the
 * one thing an editor answering it needs. Now the gate hands the id over once the row exists, and finishes that before
 * the prompt goes out: the progress bubble is still sealed above the question, and an answer that lands meanwhile
 * releases the call instead of waking the agent as a late one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { addLogSink, type ChatResponse, type LLMProvider, type LogEntry, type Tool } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { eventually, fakeAgent, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
const gates: SqliteApprovalGate[] = [];

beforeEach(async () => {
  dir = tempDir("approval-waiting");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  for (const gate of gates.splice(0)) gate.shutDown();
  db.close();
  removePath(dir);
});

function gate(options: Partial<ConstructorParameters<typeof SqliteApprovalGate>[0]> = {}): SqliteApprovalGate {
  const made = new SqliteApprovalGate({ db, timeoutMs: 60_000, ...options });
  gates.push(made);
  return made;
}

const ask = (overrides: Partial<ApprovalAsk> = {}): ApprovalAsk => ({
  agentId: "nouva",
  chatId: "chat-1",
  gateway: "web",
  gatewayId: "web:dashboard",
  senderId: "dev",
  tool: "exec",
  params: { command: ["rm", "-rf", "build"] },
  grantable: false,
  autoCoverable: false,
  reason: "a recursive delete",
  ...overrides,
});

const pendingIds = () => db.prepare<{ id: string }>("SELECT id FROM approvals WHERE status = 'pending'").all().map((row) => row.id);

/** A step that takes as long as the test says: held until `release` — a chat platform's round trip, say. */
function held(): { until: Promise<void>; release: () => void } {
  let release!: () => void;
  const until = new Promise<void>((resolve) => (release = resolve));
  return { until, release };
}

describe("the waiting step, through the executor", () => {
  test("names the approval, written once the request exists and before its prompt is shown", async () => {
    const order: string[] = [];
    let waitingDetail: Record<string, unknown> | undefined;
    let rowsWhenWaiting: string[] = [];
    const seal = held();
    const approvals = gate({
      onRequest: (notice) => {
        order.push(`prompt ${notice.request.id}`);
        approvals.resolve(notice.request.id, "allow-once", "dev");
      },
    });
    let round = 0;
    const provider = {
      kind: "openai",
      async chat(): Promise<ChatResponse> {
        round += 1;
        return round === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "exec", arguments: { command: ["rm", "-rf", "build"] } }], stopReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }
          : { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      },
    } as unknown as LLMProvider;
    const exec: Tool = { definition: { name: "exec", description: "", parameters: {} }, requiresApproval: true, execute: async () => ({ content: "removed", isError: false }) };
    const toolset = {
      definitions: [exec.definition],
      get: (name: string) => (name === "exec" ? exec : undefined),
      requiresApproval: () => true,
      parallelSafe: () => false,
      gate: () => ({ action: "ask", grantable: false, reason: "a recursive delete" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 8, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals,
      timezone: "UTC",
      commands: [],
      onActivity: async (kind, _text, detail) => {
        if (kind !== "waiting") return;
        waitingDetail = detail;
        rowsWhenWaiting = pendingIds();
        // The bubble's seal, which takes a round trip to the chat platform: the prompt must still come after it.
        await seal.until;
        order.push("waiting");
      },
    });
    const running = executor.run({
      agent: fakeAgent(),
      provider,
      toolset,
      history: [],
      userMessage: { role: "user", content: "clean the build", timestamp: 1 },
      gateway: "web",
      gatewayId: "web:dashboard",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "dev",
    });
    // The step is being said and its seal is still on the way: nothing is in front of the person yet.
    await eventually(() => waitingDetail !== undefined, 2_000, "the waiting step");
    expect(order).toEqual([]);
    seal.release();
    const result = await running;

    expect(result.text).toBe("done");
    const id = order.at(-1)?.replace("prompt ", "");
    expect(order).toEqual(["waiting", `prompt ${id}`]);
    expect(waitingDetail).toEqual({ callId: "c1", name: "exec", approvalId: id });
    // The id names a request that was there to answer when the step said so.
    expect(rowsWhenWaiting).toEqual([id!]);
  });
});

describe("the gate's half", () => {
  test("an answer that lands while the wait is being said releases the call, and nothing is shown", async () => {
    let shown = 0;
    let late = 0;
    let said = false;
    const seal = held();
    const approvals = gate({ onRequest: () => void (shown += 1), onLateAnswer: () => void (late += 1) });
    const outcome = approvals.request(
      ask({
        asking: async (approvalId) => {
          // The dashboard lists a pending row at once; somebody answers before the chat prompt is posted.
          expect(approvals.resolve(approvalId, "allow-once", "dev")).toBe(true);
          await seal.until;
          said = true;
        },
      }),
    );
    // Released by the answer while the wait was still being said.
    expect(await outcome).toEqual({ status: "approved", id: expect.stringMatching(/^apr_/), by: "dev", decision: "allow-once" });
    seal.release();
    // Said: the gate decides at once whether to show the prompt, and the question is answered — so it is not.
    await eventually(() => said, 2_000, "the wait said");
    expect({ shown, late }).toEqual({ shown: 0, late: 0 });
  });

  test("a call that waits on a question still open is told that question's id, and asks no second one", async () => {
    let shown = 0;
    const approvals = gate({ onRequest: () => void (shown += 1) });
    const controller = new AbortController();
    const asked: string[] = [];
    // The first call stops waiting — its turn ended — and leaves the question open.
    const first = approvals.request(ask({ signal: controller.signal, asking: (id) => void asked.push(id) }));
    await eventually(() => shown === 1, 2_000, "the question shown");
    controller.abort();
    expect(await first).toEqual({ status: "expired", stillAnswerable: true });

    const second = approvals.request(ask({ asking: (id) => void asked.push(id) }));
    await eventually(() => asked.length === 2, 2_000, "the second call told");
    expect(asked[1]).toBe(asked[0]!);
    expect(shown).toBe(1);
    approvals.resolve(asked[0]!, "deny", "dev");
    expect((await second).status).toBe("denied");
    // Waited on, answered, and never put in front of the person a second time.
    expect(shown).toBe(1);
  });

  test("a gate asked without one shows the prompt at once, as before", async () => {
    let shown = 0;
    const approvals = gate({ onRequest: () => void (shown += 1) });
    void approvals.request(ask());
    expect(shown).toBe(1);
  });

  test("a parked request stops the wait at once and says the window it was given, not the default", async () => {
    const lines: LogEntry[] = [];
    addLogSink((entry) => void lines.push(entry));
    const outcome = await gate().request(ask({ waitMs: 0, answerableMs: 24 * 60 * 60_000 }));
    expect(outcome).toEqual({ status: "expired", stillAnswerable: true });
    const said = lines.find((entry) => entry.message.startsWith("no longer waiting on this approval"));
    expect(Number(said?.data?.answerable_for_ms)).toBeGreaterThan(23 * 60 * 60_000);
  });
});
