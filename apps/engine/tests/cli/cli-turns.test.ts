/**
 * `nouride turns` and `nouride turns show <id>` — one turn read whole, as a person reads it at a terminal.
 *
 * What matters in the rendering is what was invisible before: which call was slow, which one the provider made it
 * ask again, what the priced calls cost and that an unpriced one is not counted as free.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Client } from "@nouride/cli-kit";
import { turns } from "@/cli/commands/turns.ts";
import { registerTurnRoutes } from "@/modules/web/control/routes/turns.ts";
import type { TurnInspection, TurnSummary } from "@/modules/turns/inspection.store.ts";

let printed: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  printed = [];
  spy = spyOn(console, "log").mockImplementation((line?: unknown) => void printed.push(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "")));
});
afterEach(() => spy.mockRestore());

const started = Date.UTC(2026, 9, 16, 9, 30, 0);
const inspection: TurnInspection = {
  turn: {
    id: "turn_8f3a1c0b2d4e6f708192",
    sessionId: "ses_1",
    agentId: "ren",
    gatewayId: "web:dashboard",
    chatId: "web-1",
    status: "done",
    prompt: "lu bisa cari deepseek flash v4 vs gpt luna 5.6?",
    reply: "DeepSeek is cheaper; Luna is faster.",
    toolCalls: 1,
    startedAt: started,
    endedAt: started + 12_400,
  },
  totals: { calls: 3, inputTokens: 12_345, outputTokens: 1_234, cachedInputTokens: 8_000, usd: 0.0123, unpriced: 1, latencyMs: 9_800, slowestMs: 4_200, retries: 1 },
  calls: [
    { at: started + 1_000, agentId: "ren", model: "claude-sonnet-4-5", provider: "anthropic", inputTokens: 4_100, outputTokens: 300, usd: 0.0041, latencyMs: 3_100, attempts: 1 },
    { at: started + 5_000, agentId: "ren", model: "claude-sonnet-4-5", provider: "anthropic", inputTokens: 4_200, outputTokens: 400, usd: 0.0082, latencyMs: 4_200, attempts: 2 },
    { at: started + 9_000, agentId: "helper", model: "local-model", provider: "ollama", inputTokens: 4_045, outputTokens: 534, usd: null, latencyMs: 2_500, attempts: 1 },
  ],
  steps: [
    { seq: 1, at: started + 800, kind: "tool", text: "web_search deepseek flash v4" },
    { seq: 2, at: started + 2_000, kind: "tool_done", text: "web_search 36 found · 1195ms" },
  ],
  audit: [{ at: started + 900, action: "tool_exec", details: { tool: "web_search", ms: 1195 } }],
};

function client(answers: Record<string, unknown>): Client & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    get: async <T>(path: string) => {
      gets.push(path);
      return answers[path.split("?")[0]!] as T;
    },
  } as Client & { gets: string[] };
}

describe("nouride turns show", () => {
  test("every call with what it cost and took — the retried one marked, the helper's named, the unpriced one said", async () => {
    await turns(client({ "/turns/turn_8f3a": inspection }), ["show", "turn_8f3a"]);
    const out = printed.join("\n");

    expect(out).toContain("turn_8f3a1c0b2d4e6f708192 ren · done · 2026-10-16 09:30:00 · 12.4s");
    expect(out).toContain("model calls 3 · 12,345 in (8,000 cached) · 1,234 out · $0.0123, 1 unpriced · 9.8s waiting, slowest 4.2s · 1 retry");
    expect(out).toContain("09:30:05 claude-sonnet-4-5 4,200 in · 400 out · $0.0082 · 4.2s · 2 attempts");
    expect(out).toContain("09:30:09 helper local-model 4,045 in · 534 out · unpriced · 2.5s");
    expect(out).toContain("+ 800ms tool        web_search deepseek flash v4");
    expect(out).toContain("+  1.2s tool_done   web_search 36 found · 1195ms");
    expect(out).toContain("tool_exec");
    expect(out).toContain("DeepSeek is cheaper; Luna is faster.");
  });

  test("a call that was not the turn answering says what it was for; one on a subscription says it is included", async () => {
    const calls = [
      { at: started + 1_000, agentId: "ren", model: "gemini-3.8-flash", provider: "nougate", inputTokens: 90_000, outputTokens: 2_000, usd: 0, latencyMs: 9_000, attempts: 1, purpose: "compaction", basis: "included" },
      { at: started + 9_000, agentId: "ren", model: "claude-opus-4-6", provider: "anthropic", inputTokens: 4_000, outputTokens: 0, usd: 0.02, latencyMs: 2_500, attempts: 1, purpose: "turn", basis: "list", estimated: true },
    ];
    await turns(client({ "/turns/turn_8f3a": { ...inspection, calls } }), ["show", "turn_8f3a"]);
    const out = printed.join("\n");
    expect(out).toContain("09:30:01 compaction gemini-3.8-flash 90,000 in · 2,000 out · included · 9.0s");
    expect(out).toContain("09:30:09 claude-opus-4-6 4,000 in · 0 out (estimated) · $0.0200 · 2.5s");
  });

  test("each call says why it ended: a cut at the output limit is read, not guessed from 8192 — and a call with no reason says none", async () => {
    const calls = [
      { at: started + 1_000, agentId: "ren", model: "claude-sonnet-4-5", provider: "anthropic", inputTokens: 90_000, outputTokens: 8_192, usd: 0.4, latencyMs: 60_000, attempts: 1, stopReason: "max_tokens" as const },
      { at: started + 2_000, agentId: "ren", model: "claude-sonnet-4-5", provider: "anthropic", inputTokens: 90_000, outputTokens: 60, usd: 0.3, latencyMs: 3_000, attempts: 1, stopReason: "tool_calls" as const },
      { at: started + 3_000, agentId: "ren", model: "claude-sonnet-4-5", provider: "anthropic", inputTokens: 1_000, outputTokens: 10, usd: 0.01, latencyMs: 900, attempts: 1 },
    ];
    await turns(client({ "/turns/turn_8f3a": { ...inspection, calls } }), ["show", "turn_8f3a"]);
    const out = printed.join("\n");
    expect(out).toContain("09:30:01 claude-sonnet-4-5 90,000 in · 8,192 out · $0.4000 · 60.0s · max_tokens");
    expect(out).toContain("09:30:02 claude-sonnet-4-5 90,000 in · 60 out · $0.3000 · 3.0s · tool_calls");
    expect(printed.find((line) => line.includes("09:30:03"))).toBe("  09:30:03 claude-sonnet-4-5 1,000 in · 10 out · $0.0100 · 900ms");
  });

  test("what each request carried: its size, the results cleared and where they were kept, a summary in it (0.7.26)", async () => {
    const contexts = [
      { request: 1, estimatedTokens: 12_000, cleared: 0, summary: false, notes: false },
      { request: 2, estimatedTokens: 148_200, cleared: 2, keptAt: ["/data/spill/s1/cleared-call_1-ab12.txt"], summary: true, notes: false },
      { request: 1, estimatedTokens: 3_000, cleared: 0, summary: false, notes: false, via: "delegate" as const, by: "ren" },
    ];
    await turns(client({ "/turns/turn_8f3a": { ...inspection, contexts } }), ["show", "turn_8f3a"]);
    const out = printed.join("\n");
    expect(out).toContain("requests\n  #1 ~12,000 tokens\n  #2 ~148,200 tokens · 2 results cleared · summary\n      kept at /data/spill/s1/cleared-call_1-ab12.txt\n  #1 ren ~3,000 tokens");
  });

  test("a turn lists what it handed to the background; a delegate's own turn names its job and the turn that asked (0.7.26)", async () => {
    const delegated = [
      { id: "turn_h1", agentId: "ren", status: "done" as const, prompt: "GOAL\nFind every broken link", startedAt: started + 2_000, endedAt: started + 62_000, cause: { via: "delegate", job: "job_7", parent: "turn_8f3a1c0b2d4e6f708192" } },
    ];
    await turns(client({ "/turns/turn_8f3a": { ...inspection, delegated } }), ["show", "turn_8f3a"]);
    expect(printed.join("\n")).toContain("handed off\n  turn_h1 delegate ren done · 60.0s  GOAL Find every broken link");

    printed = [];
    const own = { ...inspection, turn: { ...inspection.turn, id: "turn_h1", cause: delegated[0]!.cause }, delegated: [] };
    await turns(client({ "/turns/turn_h1": own }), ["show", "turn_h1"]);
    const out = printed.join("\n");
    expect(out).toContain("for     delegate · job job_7 · asked by turn_8f3a1c0b2d4e6f708192");
    expect(out).toContain("counted there: nouride turns show turn_8f3a1c0b2d4e6f708192");
    expect(out).not.toContain("handed off");
  });

  test("a turn that answered a person's edit says so, and which message — or that it was edited before it was answered (G11)", async () => {
    const again = { ...inspection, turn: { ...inspection.turn, messageId: "41:edited:9", cause: { via: "edit", of: "41" } } };
    await turns(client({ "/turns/turn_8f3a": again }), ["show", "turn_8f3a"]);
    expect(printed.join("\n")).toContain("edited  message 41, answered again");

    printed = [];
    const corrected = { ...inspection, turn: { ...inspection.turn, messageId: "41", cause: { via: "edit", of: "41" } } };
    await turns(client({ "/turns/turn_8f3a": corrected }), ["show", "turn_8f3a"]);
    expect(printed.join("\n")).toContain("edited  before it was answered");

    printed = [];
    await turns(client({ "/turns/turn_8f3a": inspection }), ["show", "turn_8f3a"]);
    expect(printed.join("\n")).not.toContain("edited");
  });

  test("a turn whose every call is unpriced says so, rather than a $0.0000 that reads as a price", async () => {
    const free = { ...inspection, totals: { ...inspection.totals, usd: 0, unpriced: 3 } };
    await turns(client({ "/turns/turn_8f3a": free }), ["show", "turn_8f3a"]);

    expect(printed.join("\n")).toContain("model calls 3 · 12,345 in (8,000 cached) · 1,234 out · unpriced · 9.8s waiting");
  });
});

describe("nouride turns", () => {
  test("the newest, each with its calls and cost — an unpriced turn says so rather than $0", async () => {
    const rows: TurnSummary[] = [
      { id: "turn_aaa", agentId: "ren", status: "done", prompt: "newer", startedAt: started, endedAt: started + 5_000, calls: 2, usd: 0.0042 },
      { id: "turn_bbb", agentId: "nero", status: "failed", prompt: "older", startedAt: started - 60_000, calls: 1, usd: null },
    ];
    const fake = client({ "/turns": { turns: rows } });

    await turns(fake, ["--agent", "ren", "--limit", "5"]);

    expect(fake.gets).toEqual(["/turns?limit=5&agent=ren"]);
    expect(printed[0]).toContain("turn_aaa ren done 2 calls · $0.0042  newer");
    expect(printed[1]).toContain("turn_bbb nero failed 1 call · unpriced  older");
  });

  test("a turn that answered a person's edit is marked edited, before the words it answered; one typed as it is is not (G11)", async () => {
    const rows: TurnSummary[] = [
      { id: "turn_aaa", agentId: "ren", status: "done", prompt: "make it Bandung", startedAt: started, calls: 1, usd: 0.001, cause: { via: "edit", of: "41" } },
      { id: "turn_bbb", agentId: "ren", status: "done", prompt: "what time is it?", startedAt: started, calls: 1, usd: 0.001 },
      { id: "turn_ccc", agentId: "ren", status: "done", prompt: "(a job finished)", startedAt: started, calls: 1, usd: 0.001, cause: { via: "schedule", job: "job_1" } },
    ];
    await turns(client({ "/turns": { turns: rows } }), []);

    expect(printed[0]).toContain("1 call · $0.0010  edited · make it Bandung");
    expect(printed[1]).toContain("1 call · $0.0010  what time is it?");
    expect(printed[2]).toContain("1 call · $0.0010  (a job finished)");
  });

  test("a delegate's own turn names the turn its calls are counted in, rather than none of its own (0.7.26)", async () => {
    const rows: TurnSummary[] = [
      { id: "turn_h1", agentId: "nox", status: "running", prompt: "Deploy v2 to staging", startedAt: started, calls: 0, usd: null, cause: { via: "ask_agent", job: "job_7", parent: "turn_aaa" } },
    ];
    await turns(client({ "/turns": { turns: rows } }), []);
    expect(printed[0]).toContain("turn_h1 nox running ↳ ask_agent for turn_aaa  Deploy v2 to staging");
  });
});

describe("the route", () => {
  const app = (inspector: { inspect(id: string): TurnInspection | null; recent(o: { limit: number; agentId?: string }): TurnSummary[] }) => {
    const control = new Hono();
    registerTurnRoutes(control as never, { turnInspector: inspector } as never);
    return control;
  };

  test("a turn it cannot name is a 404 that says how to find one", async () => {
    const res = await app({ inspect: () => null, recent: () => [] }).request("/turns/turn_zz");
    expect(res.status).toBe(404);
    // The CLI's words as they were; the page says its own beside them (0.8.20).
    expect(await res.json()).toEqual({ error: "no turn turn_zz", note: "`nouride turns` lists the newest; a shortened id has to name one turn", plain: "That record is not there any more." });
  });

  test("a list is bounded, and filtered by agent when one is named", async () => {
    const asked: { limit: number; agentId?: string }[] = [];
    const control = app({ inspect: () => inspection, recent: (options) => (asked.push(options), []) });

    await control.request("/turns?limit=5000&agent=ren");
    await control.request("/turns");

    expect(asked).toEqual([{ limit: 200, agentId: "ren" }, { limit: 20 }]);
    expect(((await (await control.request("/turns/turn_8f3a")).json()) as TurnInspection).totals.retries).toBe(1);
  });
});
