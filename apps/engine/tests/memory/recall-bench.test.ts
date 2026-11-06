/**
 * Recall, measured against a real model — the part a unit test cannot promise: that an agent asked
 * in any language writes a `memory_search` query that finds what is kept, in English, by words alone.
 *
 * Skipped unless a model is named. Run it when the memory prompt, the search tool's description or the
 * search itself changes, against the kind of model the nightly pass and the agents use:
 *
 *   NOURIDE_BENCH_BASE_URL=http://localhost:3000/openai/v1 NOURIDE_BENCH_MODEL=gemini-3.5-flash \
 *   NOURIDE_BENCH_API_KEY=… bun test tests/memory/recall-bench.test.ts
 *
 * Each case is a question a person asks and the fact that answers it. The model is given what an
 * agent is given — the MEMORY instructions and the tool — and asked to search; its query is run
 * against the real index with no semantic search. The score is how many answers came back.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderMemory } from "@/modules/llm/prompt/harness-memory.ts";
import { createMemoryWriteTool } from "@/modules/tools/builtins/memory.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { GADING_DM, household, type Household } from "./fixture.ts";

const BASE_URL = process.env.NOURIDE_BENCH_BASE_URL;
const MODEL = process.env.NOURIDE_BENCH_MODEL;
const API_KEY = process.env.NOURIDE_BENCH_API_KEY ?? "";
/** Share of questions whose answer must come back. Below it, recall has regressed. */
const PASS_MARK = 0.8;

const CASES: { question: string; fact: { section: string; text: string } }[] = [
  { question: "laptop aku apa ya?", fact: { section: "Hardware", text: "Owns a ThinkPad X1 Carbon laptop." } },
  { question: "What car do I drive?", fact: { section: "Hardware", text: "Drives a Toyota Corolla car." } },
  { question: "Anakku ulang tahun kapan?", fact: { section: "Family", text: "Mia, her daughter, has her birthday on 14 March." } },
  { question: "Kucingku namanya siapa?", fact: { section: "Family", text: "Has a cat named Luna." } },
  { question: "Aku alergi apa?", fact: { section: "Health", text: "Allergic to peanuts." } },
  { question: "Where do I work?", fact: { section: "Work", text: "Works as a backend engineer at Acme." } },
  { question: "Tim pakai database apa?", fact: { section: "Work", text: "The team runs Postgres as its main database." } },
  { question: "Rencana liburan akhir tahun kemana?", fact: { section: "Plans", text: "Plans a beach trip to Lombok in December." } },
  { question: "Kopi kesukaanku gimana?", fact: { section: "Preferences", text: "Likes black coffee without sugar." } },
];

let h: Household;
const toolCtx = () => ({ agentId: "nouva", agentDir: join(h.dir, "agents", "nouva"), sessionId: "bench", signal: new AbortController().signal, ...GADING_DM }) as never;

async function queryFor(question: string): Promise<string | null> {
  const search = createMemorySearchTool(h.memory).definition;
  const memory = renderMemory({ ctx: { harness: {}, tools: [{ name: "memory_search" }] }, toolNames: [], gated: [], free: [] } as never).join("\n");
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: `You are a household assistant. Nothing about this person is in your prompt: find it.\n${memory}` },
        { role: "user", content: question },
      ],
      tools: [{ type: "function", function: { name: search.name, description: search.description, parameters: search.parameters } }],
      tool_choice: { type: "function", function: { name: search.name } },
    }),
  });
  if (!response.ok) throw new Error(`the model answered ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[] };
  const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return null;
  const query = (JSON.parse(args) as { query?: unknown }).query;
  return typeof query === "string" ? query : null;
}

describe.skipIf(!BASE_URL || !MODEL)("recall against a real model, by words alone", () => {
  beforeAll(async () => {
    h = await household();
    const write = createMemoryWriteTool(h.memory);
    for (const { fact } of CASES) await write.execute({ about: "person", section: fact.section, content: fact.text }, toolCtx());
  });

  afterAll(() => h?.close());

  test(`at least ${PASS_MARK * 100}% of questions find their answer`, async () => {
    const search = createMemorySearchTool(h.memory);
    const results: { question: string; query: string | null; found: boolean }[] = [];
    for (const { question, fact } of CASES) {
      const query = await queryFor(question);
      const found = query !== null && (await search.execute({ query }, toolCtx())).content.includes(fact.text);
      results.push({ question, query, found });
    }
    const score = results.filter((result) => result.found).length / results.length;
    console.log(`recall bench (${MODEL}): ${Math.round(score * 100)}%\n${results.map((r) => `  ${r.found ? "✓" : "✗"} ${r.question} → ${r.query ?? "(no query)"}`).join("\n")}`);
    expect(score).toBeGreaterThanOrEqual(PASS_MARK);
  }, 120_000);
});
