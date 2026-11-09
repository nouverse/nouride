/**
 * The keyword index in FTS5, on a real database: what a query finds and in what order, how an item is
 * replaced and forgotten, what a scope keeps out, and the two-way walk over `related` that search hops
 * along.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { MemoryIndexStore, type IndexedEpisode } from "@/modules/memory/memory-index.store.ts";
import { firstPassOfWeek } from "@/modules/memory/run.ts";
import { searchMemory } from "@/modules/memory/search.ts";
import { ftsDoc, ftsExact, ftsQuery } from "@/modules/memory/terms.ts";
import { tempDir } from "../helpers.ts";

const CHAT = "telegram:nouva:814";
const ELSEWHERE = "telegram:nix:777";

let dir: string;
let db: SqliteDb;
let index: MemoryIndexStore;

beforeEach(async () => {
  dir = tempDir("fts");
  db = await openAndMigrate(join(dir, "test.db"));
  index = new MemoryIndexStore(db);
});

afterEach(() => {
  db.close();
  removePath(dir);
});

const episode = (id: string, more: Partial<IndexedEpisode> = {}): IndexedEpisode => ({
  id,
  status: "summarized",
  kind: "dm",
  chat: CHAT,
  day: "2026-09-25",
  week: "2026-W39",
  month: "2026-09",
  startedAt: 0,
  endedAt: 0,
  agents: [],
  participants: [],
  mentions: [],
  tags: [],
  related: [],
  ...more,
});

const put = (id: string, parts: { summary?: string; tags?: string; body?: string }, more: Partial<IndexedEpisode> = {}) =>
  index.putEpisode(episode(id, more), ftsDoc(parts), { path: `episodes/${id}.md`, state: { mtimeMs: 0, size: 0 } });

const rank = (query: string, facts: string[] = [], chat = CHAT) => index.rank(ftsQuery(query)!, { scope: { chat } }, facts, 10);

describe("what a query finds", () => {
  test("an item matching more of the query's words ranks above one repeating a single word", () => {
    put("a", { body: "bali desember" });
    put("b", { body: "bali bali bali bali" });
    expect(rank("bali desember")).toEqual(["a", "b"]);
  });

  test("a word of four letters or more matches the words it begins; a shorter one only itself", () => {
    put("a", { body: "laptopnya rusak" });
    put("b", { body: "lap kotor" });
    expect(rank("lapt")).toEqual(["a"]);
    expect(rank("lap")).toEqual(["b"]);
  });

  test("an English plural in the query finds the word it was cut from: laptops finds laptop", () => {
    put("a", { body: "laptop baru" });
    expect(rank("laptops")).toEqual(["a"]);
  });

  test("an Indonesian word finds another form of it by its root: liburan finds berlibur", () => {
    put("a", { body: "minggu depan berlibur ke lombok" });
    expect(rank("liburan")).toEqual(["a"]);
  });

  test("diacritics fold on both sides: kafé finds kafe", () => {
    put("a", { body: "ngopi di kafe dekat rumah" });
    expect(rank("kafé")).toEqual(["a"]);
  });

  test("stop words are never indexed or asked for", () => {
    expect(ftsDoc({ body: "yang dan di the of" }).body).toBe("");
    expect(ftsQuery("yang dan di")).toBeNull();
  });

  test("the summary weighs double: a word there outranks the same word in a transcript", () => {
    put("transcript", { body: "lombok" });
    put("summary", { summary: "lombok" });
    expect(rank("lombok")).toEqual(["summary", "transcript"]);
  });

  test("a query is quoted words only, so operators a person types are just words", () => {
    // A column filter and NEAR, typed: split into words and quoted, so FTS5 never reads them as syntax.
    expect(String(ftsQuery("summary:bali NEAR lombok"))).toBe('"summary"* OR "bali"* OR "near"* OR "lombok"*');
    expect(String(ftsExact("Kak Sam"))).toBe('"kak" OR "sam"');
  });
});

describe("what a scope keeps out", () => {
  test("an episode in another chat is never ranked, and a fact only when the caller passes it", () => {
    put("mine", { body: "bali" });
    put("theirs", { body: "bali" }, { chat: ELSEWHERE });
    index.putFacts("gading", [{ id: "fact:gading:1", subject: "gading", section: "Places", text: "Bali", doc: ftsDoc({ body: "Places Bali" }) }], {
      path: "people/gading.md",
      state: { mtimeMs: 0, size: 0 },
    });
    expect(rank("bali")).toEqual(["mine"]);
    expect(rank("bali", ["fact:gading:1"]).toSorted()).toEqual(["fact:gading:1", "mine"]);
  });
});

describe("keeping it true to the files", () => {
  test("a replaced item keeps its row and only its new words", () => {
    put("a", { body: "bali" });
    const before = db.prepare<{ id: number }>("SELECT id FROM memory_fts_items WHERE item = 'a'").get()!.id;
    put("a", { body: "lombok" });
    expect(db.prepare<{ id: number }>("SELECT id FROM memory_fts_items WHERE item = 'a'").get()!.id).toBe(before);
    expect(rank("bali")).toEqual([]);
    expect(rank("lombok")).toEqual(["a"]);
  });

  test("a dropped episode, a replaced subject's facts and a cleared index are gone from the words too", () => {
    put("a", { body: "bali" });
    put("b", { body: "bali" });
    index.dropEpisode("a", "episodes/a.md");
    expect(index.matching(ftsQuery("bali")!)).toEqual(["b"]);

    const facts = (text: string) => [{ id: `fact:gading:${text}`, subject: "gading", section: "Places", text, doc: ftsDoc({ body: text }) }];
    const file = { path: "people/gading.md", state: { mtimeMs: 0, size: 0 } };
    index.putFacts("gading", facts("bali"), file);
    index.putFacts("gading", facts("lombok"), file);
    expect(index.matching(ftsQuery("bali")!).toSorted()).toEqual(["b"]);

    index.clear();
    expect(index.matching(ftsQuery("lombok")!)).toEqual([]);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM memory_fts_items").get()!.n).toBe(0);
  });

  test("FTS5's own check passes on a healthy index, after a night's bounded merge and a week's whole one", () => {
    put("a", { body: "bali" });
    index.optimizeText(false);
    expect(index.checkText()).toEqual({ ok: true, detail: "ok" });
    put("b", { body: "lombok" });
    index.optimizeText(true);
    expect(index.checkText()).toEqual({ ok: true, detail: "ok" });
    expect(index.matching(ftsQuery("lombok")!)).toEqual(["b"]);
  });

  test("the whole index is rewritten by the week's first pass, not every night's (E12)", () => {
    expect(firstPassOfWeek(null, "2026-10-14")).toBe(true);
    // Wednesday after Monday of the same ISO week: a bounded merge.
    expect(firstPassOfWeek("2026-10-12", "2026-10-14")).toBe(false);
    // Monday after Sunday: a new week, whichever night the daemon was off.
    expect(firstPassOfWeek("2026-10-11", "2026-10-12")).toBe(true);
    expect(firstPassOfWeek("2026-09-30", "2026-10-14")).toBe(true);
  });
});

describe("the walk over related", () => {
  test("both ways round, two links out, each with its distance — a→b→c and d→a, from a", () => {
    put("a", {}, { related: ["b"] });
    put("b", {}, { related: ["c"] });
    put("c", {});
    put("d", {}, { related: ["a"] });
    const reached = index.reachable(["a"], 2).map(({ id, depth }) => `${id}:${depth}`).toSorted();
    expect(reached).toEqual(["b:1", "c:2", "d:1"]);
  });

  test("a cycle ends", () => {
    put("x", {}, { related: ["y"] });
    put("y", {}, { related: ["x"] });
    expect(index.reachable(["x"], 5)).toEqual([{ origin: "x", id: "y", depth: 1 }]);
  });
});

describe("the hop in search", () => {
  const search = (query: string, chat = CHAT) =>
    searchMemory({ index, people: [], now: () => Date.UTC(2026, 8, 26), timeZone: "Asia/Jakarta" }, { audience: { kind: "group", chat, present: [] }, query });

  test("a hit brings what it continues and what continued it, at 0.7 a link", async () => {
    put("a", { summary: "rencana mudik lebaran" }, { related: ["b"] });
    put("b", { summary: "tiket kereta" }, { related: ["c"] });
    put("c", { summary: "jadwal berangkat" });
    put("d", { summary: "souvenirs to bring back" }, { related: ["a"] });
    const hits = await search("mudik");
    const score = new Map(hits.map((hit) => [hit.kind === "episode" ? hit.episode.id : hit.kind === "fact" ? hit.fact.id : hit.section.item, hit.score]));
    expect(score.get("b")! / score.get("a")!).toBeCloseTo(0.7, 5);
    expect(score.get("d")! / score.get("a")!).toBeCloseTo(0.7, 5);
    expect(score.get("c")! / score.get("a")!).toBeCloseTo(0.49, 5);
  });

  test("never brings what the audience may not see", async () => {
    put("a", { summary: "rencana mudik" }, { related: ["hidden"] });
    put("hidden", { summary: "rahasia" }, { chat: ELSEWHERE });
    const hits = await search("mudik");
    expect(hits.map((hit) => (hit.kind === "episode" ? hit.episode.id : ""))).toEqual(["a"]);
  });

  /**
   * A long conversation is cut into pieces linked both ways (`episodesOf`), each summarised alone, so one
   * query found piece two and the hop brought one and three — three of ten results for one conversation.
   */
  test("the pieces of one conversation found together are one hit, the best match, naming the others in order", async () => {
    put("piece1", { summary: "mudik plans, the train" }, { related: ["piece2"], startedAt: 1 });
    put("piece2", { summary: "mudik plans, mudik tickets, mudik dates" }, { related: ["piece1", "piece3"], startedAt: 2 });
    put("piece3", { summary: "mudik plans, the souvenirs" }, { related: ["piece2"], startedAt: 3 });
    put("other", { summary: "mudik last year" }, { startedAt: 0 });
    const hits = await search("mudik");

    const ids = hits.map((hit) => (hit.kind === "episode" ? hit.episode.id : hit.kind === "fact" ? hit.fact.id : hit.section.item));
    expect(ids).toEqual(["piece2", "other"]);
    const kept = hits[0]!;
    expect(kept.kind === "episode" ? kept.parts : undefined).toEqual(["piece1", "piece3"]);
    expect(hits[1]!.kind === "episode" ? hits[1]!.parts : "").toBeUndefined();
  });

  test("a one-way link is a related conversation, not a piece: both stay", async () => {
    // The pass links an episode to older ones from the newer side only, so a link one way is never a cut's.
    put("a", { summary: "rencana mudik" }, { related: ["b"] });
    put("b", { summary: "mudik tahun lalu" });
    const ids = (await search("mudik")).map((hit) => (hit.kind === "episode" ? hit.episode.id : ""));
    expect(ids.toSorted()).toEqual(["a", "b"]);
  });

  test("pieces the hop brings are folded into their origin and leave it five others", async () => {
    const others = Array.from({ length: 5 }, (_, i) => `other${i}`);
    put("origin", { summary: "rencana mudik" }, { related: ["sibling", ...others], startedAt: 1 });
    put("sibling", { summary: "tiket kereta" }, { related: ["origin"], startedAt: 2 });
    others.forEach((id) => put(id, { summary: "something else" }));
    const hits = await search("mudik");

    const origin = hits.find((hit) => hit.kind === "episode" && hit.episode.id === "origin");
    expect(origin?.kind === "episode" ? origin.parts : undefined).toEqual(["sibling"]);
    const brought = hits.flatMap((hit) => (hit.kind === "episode" && hit.episode.id !== "origin" ? [hit.episode.id] : []));
    expect(brought.toSorted()).toEqual(others);
  });

  test("brings five per hit at most, nearest first", async () => {
    const near = Array.from({ length: 4 }, (_, i) => `near${i}`);
    const far = Array.from({ length: 4 }, (_, i) => `far${i}`);
    put("a", { summary: "rencana mudik" }, { related: near });
    near.forEach((id, i) => put(id, {}, { related: [far[i]!] }));
    far.forEach((id) => put(id, {}));
    const brought = (await search("mudik")).flatMap((hit) => (hit.kind === "episode" && hit.episode.id !== "a" ? [hit.episode.id] : []));
    expect(brought).toHaveLength(5);
    expect(near.every((id) => brought.includes(id))).toBe(true);
  });
});
