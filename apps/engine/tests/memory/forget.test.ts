/**
 * Forgetting a person, both ways — `docs/SPEC.md` §12.2. What must be true after either: none
 * of their conversations, their profile, the facts their conversations taught, or their name in the
 * index; and in `forget` mode, not even what was said about them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gunzipText, readFileBytes, readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import { anonymize, namesOf } from "@/modules/memory/forget.ts";
import type { ForgetReport } from "@/modules/memory/forget.ts";
import { GADING_DM, SAM_DM, at, household, scripted, speaker, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
  // The conversations below are fifteen days old; a week makes them archived, so forget reaches archives too.
  h.config.memory.transcriptDays = 7;
  h.dm(SAM_DM, "nix", "Aku suka rendang", "Siap.", at(9, 0, 10));
  h.dm(GADING_DM, "nouva", "Sam mau pindah ke Bandung, cari hadiah", "Bagaimana kalau buku?", at(9, 0, 10));
  await h.memory.pass(
    scripted([
      { when: "rendang", answer: { summary: "Sam likes rendang.", facts: [{ person: "sam", op: "add", section: "Food", text: "Likes rendang." }, { person: "gading", op: "add", section: "Family", text: "His older sister is Sam." }] } },
      { when: "Bandung", answer: { summary: "Gading is looking for a farewell gift for Sam, who is moving to Bandung.", mentions: ["sam"], facts: [{ person: "gading", op: "add", section: "Plans", text: "Looking for a gift." }] } },
    ]).ask,
  );
});

afterEach(() => h.close());

/** Forget someone who exists — the refusal is its own test. */
async function forget(mode: "forget" | "anonymize", rewrite?: () => Promise<string | null>): Promise<ForgetReport> {
  const result = await h.memory.forget("sam", mode, rewrite);
  if ("refused" in result) throw new Error(result.refused);
  return result;
}

describe("what both modes do", () => {
  test("their conversations, archives, profile and the facts those conversations taught are gone", async () => {
    const report = await forget("anonymize");
    // Her own fact, and the one about Gading she told in her DM: both came from her conversation.
    expect(report).toMatchObject({ episodesDeleted: 1, factsRemoved: 2 });
    expect(await h.memory.episode("2026-09-10-0900-nix")).toBeNull();
    expect(await readTextFileIfExists(h.vault.archive("2026-09-10-0900-nix"))).toBeNull();
    expect(await readTextFileIfExists(h.vault.person("sam"))).toBeNull();
    // Gading's fact came from Sam's conversation, so it goes with it.
    expect(await readTextFileIfExists(h.vault.person("gading"))).not.toContain("His older sister is Sam");
    expect(await readTextFileIfExists(h.vault.person("gading"))).toContain("Looking for a gift.");
  });

  test("someone already removed from People is forgotten by the key their memory is under", async () => {
    // Removing a person kept their memory, and forgetting it was then refused: nobody had the key.
    h.config.people = h.config.people.filter((person) => person.key !== "sam");
    expect(h.memory.keyHeld("sam")).toBe("memory keeps a profile, people/sam.md and 2 conversation(s) with or about them");
    const report = await h.memory.forget("sam", "anonymize");
    expect(report).toMatchObject({ episodesDeleted: 1, summariesAnonymized: 1 });
    expect(h.memory.keyHeld("sam")).toBeNull();
    // Their profile named them "Kak Sam": the name its words are anonymized by.
    expect((await h.memory.episode("2026-09-10-0900-nouva"))?.episode.summary).not.toContain("Sam");
  });

  test("a key nobody holds is refused", async () => {
    expect(await h.memory.forget("nobody", "forget")).toEqual({ refused: 'no person with key "nobody"' });
  });
});

describe("what they said since their chat was last cut", () => {
  test("is cut first and forgotten with the rest: the next cut finds nothing of them to file", async () => {
    h.dm(SAM_DM, "nix", "Kode pintu rumahku 4242", "Siap, dicatat.", at(9, 0, 26));
    h.clock.now = at(23, 0, 26);
    const report = await forget("anonymize");
    // Her DM from the tenth, and the one not yet cut.
    expect(report.episodesDeleted).toBe(2);
    expect(await h.memory.cutAll()).toBe(0);
    expect(h.memory.episodes({ people: ["sam"] }, 10)).toEqual([]);
    expect(h.memory.episodes({ query: "4242" }, 10)).toEqual([]);
  });
});

describe("nothing is kept where Undo or a person could find it again", () => {
  /** Gading's profile, edited once by hand: the version kept is the text that still holds what Sam's DM taught. */
  async function versioned(): Promise<void> {
    const opened = await h.memory.readDocument("gading");
    if ("refused" in opened) throw new Error(opened.refused);
    expect(opened.content).toContain("His older sister is Sam.");
    await h.memory.writeDocument("gading", `${opened.content}- Writes by hand.\n`, opened.content);
  }

  test("no earlier version of anyone's profile keeps what their conversations taught, and Undo brings none of it back", async () => {
    await versioned();
    await forget("anonymize");
    const document = await h.memory.readDocument("gading");
    if ("refused" in document) throw new Error(document.refused);
    expect(document.versions.length).toBeGreaterThan(0);
    for (const version of document.versions) {
      const old = await h.memory.readDocumentVersion("gading", version);
      expect("content" in old ? old.content : "").not.toContain("His older sister is Sam.");
    }
    expect(await h.memory.undoDocument("gading")).toEqual({ restored: true });
    const undone = (await readTextFileIfExists(h.vault.person("gading"))) ?? "";
    expect(undone).not.toContain("His older sister is Sam.");
    expect(undone).toContain("Looking for a gift.");
  });

  test("Recent changes and Gave up keep nothing about them or from their conversations", async () => {
    h.db.prepare("INSERT INTO memory_attempts (episode_id, attempts, last_error, updated_at) VALUES (?, 3, 'no summary', 0)").run("2026-09-10-0900-nix");
    expect(h.memory.changes({ limit: 100 }).some((change) => change.subject === "sam")).toBe(true);
    await forget("anonymize");
    const left = h.memory.changes({ limit: 100 });
    expect(left.filter((change) => change.subject === "sam" || change.source === "2026-09-10-0900-nix")).toEqual([]);
    expect(left.map((change) => change.text)).toContain("Looking for a gift.");
    expect(h.memory.failed()).toEqual([]);
  });

  test("a day hub listing a summary that named them is drawn again", async () => {
    await forget("anonymize");
    const hub = (await readTextFileIfExists(h.vault.day("2026-09-10"))) ?? "";
    expect(hub).toContain("[forgotten]");
    expect(hub).not.toMatch(/\bSam\b/);
  });

  test("an archive that cannot be read is named, and the rest of the forget is done", async () => {
    await writeTextFile(h.vault.archive("2026-09-10-0900-nouva"), "not gzip at all");
    const report = await forget("anonymize");
    expect(report).toMatchObject({ unreadable: ["2026-09-10-0900-nouva"], summariesAnonymized: 1 });
    expect((await h.memory.episode("2026-09-10-0900-nouva"))?.episode.summary).toContain("[forgotten]");
    expect(await readTextFileIfExists(h.vault.person("sam"))).toBeNull();
  });

  test("deleting one of their conversations takes what it taught out of the earlier versions too", async () => {
    await versioned();
    const versions = async () => {
      const document = await h.memory.readDocument("gading");
      return "refused" in document ? [] : document.versions;
    };
    const before = await versions();
    expect(await h.memory.deleteEpisode("2026-09-10-0900-nix")).toMatchObject({ episodes: 1, facts: 2 });
    // The delete keeps no version of its own: an Undo that put back the text before it would put the facts back.
    expect(await versions()).toEqual(before);
    expect(await h.memory.undoDocument("gading")).toEqual({ restored: true });
    expect((await readTextFileIfExists(h.vault.person("gading"))) ?? "").not.toContain("His older sister is Sam.");
    expect(h.memory.changes({ limit: 100 }).filter((change) => change.source === "2026-09-10-0900-nix")).toEqual([]);
  });
});

describe("what is searched by meaning", () => {
  test("their facts' vectors go, and a summary rewritten is made again from what it says now", async () => {
    h.close();
    const vector = (text: string) => [text.length % 7, text.includes("Sam") ? 1 : 0, 1, 0.5];
    h = await household({ embed: (texts) => texts.map(vector) });
    h.config.memory.transcriptDays = 7;
    h.dm(SAM_DM, "nix", "Aku suka rendang", "Siap.", at(9, 0, 10));
    h.dm(GADING_DM, "nouva", "Sam mau pindah ke Bandung, cari hadiah", "Bagaimana kalau buku?", at(9, 0, 10));
    await h.memory.pass(
      scripted([
        { when: "rendang", answer: { summary: "Sam likes rendang.", facts: [{ person: "sam", op: "add", section: "Food", text: "Likes rendang." }] } },
        // Told about Sam in Gading's DM: a fact on her profile that none of her own conversations taught.
        { when: "Bandung", answer: { summary: "Gading is looking for a farewell gift for Sam.", mentions: ["sam"], facts: [{ person: "gading", op: "add", section: "Plans", text: "Looking for a gift." }, { person: "sam", op: "add", section: "Life", text: "Moving to Bandung." }] } },
      ]).ask,
    );
    await h.memory.embedCatchUp();
    const vectors = () => [...(h.db.prepare<{ item: string }>("SELECT item FROM memory_vectors").all().map((row) => row.item))].sort();
    expect(vectors().some((item) => item.startsWith("fact:sam:"))).toBe(true);
    expect(vectors()).toContain("2026-09-10-0900-nouva");

    await forget("anonymize");
    expect(vectors().filter((item) => item.startsWith("fact:sam:") || item === "2026-09-10-0900-nix" || item === "2026-09-10-0900-nouva")).toEqual([]);
  });
});

describe("anonymize", () => {
  test("their name becomes [forgotten] where others talked about them — summary, transcript and archive", async () => {
    const report = await forget("anonymize");
    expect(report).toMatchObject({ summariesAnonymized: 1, summariesRewritten: 0, flagged: [] });
    const file = await h.memory.episode("2026-09-10-0900-nouva");
    expect(file?.episode.summary).toBe("Gading is looking for a farewell gift for [forgotten], who is moving to Bandung.");
    expect(file?.episode.mentions).toEqual([]);
    expect(file?.archived ?? "").not.toMatch(/Sam/);
    expect(gunzipText(await readFileBytes(h.vault.archive("2026-09-10-0900-nouva")))).toContain("[forgotten] mau pindah");
    expect(await h.memory.search(speaker(GADING_DM), { query: "sam" })).toEqual([]);
  });

  test("every spelling: key and full name in any case, each name word only as written; whole words only", () => {
    const names = namesOf("sam", "Kak Sam");
    expect([...names.whole, ...names.words]).not.toContain("Kak");
    expect(anonymize("Kak Sam bilang SAM dan sam, bukan Rinaldi.", names)).toBe("[forgotten] bilang [forgotten] dan [forgotten], bukan Rinaldi.");
    expect(anonymize("Claude Test ran a test with Claude, then claude.", namesOf("claude-test", "Claude Test"))).toBe("[forgotten] ran a test with [forgotten], then claude.");
  });

  test("a word of their name alone never ties someone else's conversation to them", async () => {
    // Live, forgetting "Claude Test" replaced "test" and "Claude" in 119 summaries nobody had about them.
    const sam = h.config.people.find((person) => person.key === "sam");
    if (sam) sam.name = "Sam Test";
    h.dm(GADING_DM, "nouva", "Test koneksi dulu ya", "Masuk.", at(9, 0, 26));
    h.clock.now = at(23, 0, 26);
    await h.memory.pass(scripted([{ when: "koneksi", answer: { summary: "Gading ran a quick connectivity test. Test passed." } }]).ask);
    expect((await h.memory.episode("2026-09-26-0900-nouva"))?.episode.summary).toBe("Gading ran a quick connectivity test. Test passed.");
    const report = await forget("anonymize");
    expect(report.summariesAnonymized).toBe(1);
    expect((await h.memory.episode("2026-09-26-0900-nouva"))?.episode.summary).toBe("Gading ran a quick connectivity test. Test passed.");
  });
});

describe("forget", () => {
  test("the summary is rewritten without them by a model, and checked", async () => {
    const report = await forget("forget", async () => JSON.stringify({ summary: "Gading is looking for a farewell gift." }));
    expect(report).toMatchObject({ summariesRewritten: 1, flagged: [] });
    expect((await h.memory.episode("2026-09-10-0900-nouva"))?.episode.summary).toBe("Gading is looking for a farewell gift.");
  });

  test("a rewrite that still names them is anonymized and flagged for a person", async () => {
    const report = await forget("forget", async () => JSON.stringify({ summary: "Gading is looking for a gift for Sam." }));
    expect(report.flagged).toEqual(["2026-09-10-0900-nouva"]);
    expect((await h.memory.episode("2026-09-10-0900-nouva"))?.episode.summary).toBe("Gading is looking for a gift for [forgotten].");
  });

  test("an episode that was only about them is deleted instead of rewritten", async () => {
    const report = await forget("forget", async () => JSON.stringify({ delete: true }));
    expect(report.episodesDeleted).toBe(2);
    expect(await h.memory.episode("2026-09-10-0900-nouva")).toBeNull();
    expect(await readTextFileIfExists(h.vault.person("gading"))).not.toContain("Looking for a gift.");
  });

  test("a model that cannot be reached still leaves nothing of the name", async () => {
    const report = await forget("forget", async () => null);
    expect(report.flagged).toEqual(["2026-09-10-0900-nouva"]);
    expect((await h.memory.episode("2026-09-10-0900-nouva"))?.episode.summary).not.toContain("Sam");
  });
});
