/**
 * What memory changed, and why (`modules/memory/changes.ts`): every writer of a fact records it — the
 * nightly pass, an agent in a chat, an approval — with what it replaced and where it came from, so a
 * person can check what was done without asking. And the other half of reliability: the agent is told
 * how to find it again, in the language it is kept in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderMemory } from "@/modules/llm/prompt/harness-memory.ts";
import { buildPassPrompt } from "@/modules/memory/pass-prompt.ts";
import { createMemoryWriteTool } from "@/modules/tools/builtins/memory.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { GADING_DM, SAM_DM, at, household, scripted, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

const toolCtx = (agentId = "nouva") => ({ agentId, agentDir: join(h.dir, "agents", agentId), sessionId: "s", signal: new AbortController().signal, ...GADING_DM }) as never;
const kinds = (limit = 20) => h.memory.changes({ subject: "gading", limit }).map((change) => [change.change, change.cause, change.text, change.previous ?? null, change.source ?? null]);

describe("every writer records what it changed", () => {
  test("the nightly pass: added, then updated and removed, each with its conversation and what it replaced", async () => {
    h.dm(GADING_DM, "nouva", "Pakai MacBook M3, suka kopi", "Oke.", at(8));
    h.clock.now = at(8, 30);
    await h.memory.pass(scripted([{ when: "M3", answer: { summary: "M3.", facts: [{ person: "gading", op: "add", section: "Work", text: "Uses a MacBook M3 laptop." }, { person: "gading", op: "add", section: "Food", text: "Likes coffee." }] } }]).ask);
    h.dm(GADING_DM, "nouva", "Ganti M4, udah ga ngopi", "Oke.", at(12));
    h.clock.now = at(12, 30);
    await h.memory.pass(scripted([{ when: "Ganti M4", answer: { summary: "M4.", facts: [{ person: "gading", op: "update", n: 1, text: "Uses a MacBook M4 laptop." }, { person: "gading", op: "remove", n: 2 }] } }]).ask);

    expect(kinds().sort()).toEqual([
      ["added", "pass", "Likes coffee.", null, "2026-09-25-0800-nouva"],
      ["added", "pass", "Uses a MacBook M3 laptop.", null, "2026-09-25-0800-nouva"],
      ["removed", "pass", "Likes coffee.", null, "2026-09-25-1200-nouva"],
      ["updated", "pass", "Uses a MacBook M4 laptop.", "Uses a MacBook M3 laptop.", "2026-09-25-1200-nouva"],
    ]);
  });

  test("what someone said about a person who was not there is marked secondhand; their own words are not", async () => {
    h.dm(SAM_DM, "nix", "Mas Gading baru beli laptop", "Oke.", at(9));
    h.dm(GADING_DM, "nouva", "Aku suka kopi hitam", "Dicatat.", at(9, 5));
    h.clock.now = at(9, 30);
    await h.memory.pass(
      scripted([
        { when: "baru beli laptop", answer: { summary: "Sam says Gading bought a laptop.", facts: [{ person: "gading", op: "add", section: "Hardware", text: "Bought a new laptop." }] } },
        { when: "kopi hitam", answer: { summary: "Coffee.", facts: [{ person: "gading", op: "add", section: "Food", text: "Likes black coffee." }] } },
      ]).ask,
    );
    const changes = h.memory.changes({ subject: "gading", limit: 10 });
    expect(changes.find((change) => change.text === "Bought a new laptop.")?.secondhand).toBe(true);
    expect(changes.find((change) => change.text === "Likes black coffee.")?.secondhand).toBeUndefined();
  });

  test("an agent in a chat, and an approved proposal", async () => {
    await createMemoryWriteTool(h.memory).execute({ about: "person", section: "Health", content: "Allergic to peanuts." }, toolCtx());
    expect(kinds()).toEqual([["added", "agent", "Allergic to peanuts.", null, null]]);

    h.config.memory.facts = "ask";
    h.dm(GADING_DM, "nouva", "Aku alergi udang juga", "Dicatat.", at(9));
    h.clock.now = at(9, 30);
    await h.memory.pass(scripted([{ when: "udang", answer: { summary: "Allergy.", facts: [{ person: "gading", op: "update", n: 1, text: "Allergic to peanuts and shrimp." }] } }]).ask);
    expect(kinds()).toHaveLength(1);
    const [proposal] = await h.memory.proposals();
    expect(await h.memory.approve(proposal!.id)).toMatchObject({ status: "applied" });
    expect(kinds().find((change) => change[1] === "approval")).toEqual(["updated", "approval", "Allergic to peanuts and shrimp.", "Allergic to peanuts.", "2026-09-25-0900-nouva"]);
  });

  test("nothing is recorded for what did not change: an addition already there", async () => {
    await createMemoryWriteTool(h.memory).execute({ about: "person", section: "Health", content: "Allergic to peanuts." }, toolCtx());
    await createMemoryWriteTool(h.memory).execute({ about: "person", section: "Health", content: "Allergic to peanuts." }, toolCtx());
    expect(kinds()).toHaveLength(1);
  });
});

describe("found again, in the language it is kept in", () => {
  test("the agent is told to search in English keywords, and to retry before saying it does not recall", () => {
    const memory = renderMemory({ ctx: { harness: {}, tools: [{ name: "memory_search" }] }, toolNames: [], gated: [], free: [] } as never).join("\n");
    expect(memory).toContain("Memory is written in English");
    expect(memory).toContain('asked "what laptop do I have?", search `laptop`');
    expect(memory).toContain("try a synonym or a broader word");
    const search = createMemorySearchTool(h.memory).definition;
    expect(search.description).toContain("query in English keywords");
    expect(JSON.stringify(search.parameters)).toContain("English keywords for what to find");
  });

  test("the pass writes facts a keyword finds: what a thing is, as well as its name", () => {
    const rules = buildPassPrompt({ agents: ["nouva"], day: "2026-09-25", time: "09:00", kind: "dm", participants: ["Gading"], transcript: "", people: [], known: [], shared: [], sharedWaiting: [], vocabulary: [], chatTags: [] }).system[0]!.text;
    expect(rules).toContain('"a MacBook Air M1 laptop"');
    expect(rules).toContain("a search for the kind (laptop, database, daughter) finds it");
  });

  test("the pass keeps no credential — nor the handle that stands for one sent in chat, which is gone within the hour", () => {
    const rules = buildPassPrompt({ agents: ["nouva"], day: "2026-09-25", time: "09:00", kind: "dm", participants: ["Gading"], transcript: "", people: [], known: [], shared: [], sharedWaiting: [], vocabulary: [], chatTags: [] }).system[0]!.text;
    expect(rules).toContain("Never write credentials");
    expect(rules).toContain("or a $TMP_SECRET_… handle");
  });

  test("a plural in the query finds the singular kept, as the singular already found the plural", async () => {
    await createMemoryWriteTool(h.memory).execute({ about: "person", section: "Hardware", content: "Owns a ThinkPad laptop and a spare battery." }, toolCtx());
    for (const query of ["laptops", "batteries", "laptop"]) {
      expect((await createMemorySearchTool(h.memory).execute({ query }, toolCtx())).content).toContain("Owns a ThinkPad laptop and a spare battery.");
    }
  });

  test("so an English keyword finds a fact the conversation said in Indonesian", async () => {
    h.dm(GADING_DM, "nouva", "Laptopku MacBook Air M1", "Oke.", at(9));
    h.clock.now = at(9, 30);
    await h.memory.pass(scripted([{ when: "Laptopku", answer: { summary: "Gading's laptop.", facts: [{ person: "gading", op: "add", section: "Hardware", text: "Owns a MacBook Air M1 laptop." }] } }]).ask);
    const found = await createMemorySearchTool(h.memory).execute({ query: "laptop" }, toolCtx());
    expect(found.content).toContain("Owns a MacBook Air M1 laptop.");
  });
});
