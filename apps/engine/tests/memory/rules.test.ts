/**
 * The rules memory is built on: who may see a conversation and a fact, how keyword search ranks, and
 * how tags stay one vocabulary.
 */

import { describe, expect, test } from "bun:test";
import { audienceOf, canSeeEpisode, canSeeFact, readersOf } from "@/modules/memory/access.ts";
import { fileTags, normalizeTags } from "@/modules/memory/tags.ts";
import { ftsDoc, ftsQuery, queryTerms, tokens } from "@/modules/memory/terms.ts";

const gadingDm = audienceOf({ chat: "telegram:nouva:814", chatType: "dm", person: "gading" });
const miraDm = audienceOf({ chat: "telegram:nix:777", chatType: "dm", person: "sam" });
const family = audienceOf({ chat: "telegram:nouva:-1001", chatType: "group", person: "gading", present: ["sam"] });

describe("who may see a conversation", () => {
  const theirDm = { chat: "telegram:nix:777", people: ["sam"] };
  const group = { chat: "telegram:nouva:-1001", people: ["gading", "sam"] };
  const gadingWithNix = { chat: "telegram:nix:814", people: ["gading"] };

  test("a DM follows its person across agents, and never into someone else's DM", () => {
    expect(canSeeEpisode(gadingWithNix, gadingDm)).toBe(true);
    expect(canSeeEpisode(group, gadingDm)).toBe(true);
    expect(canSeeEpisode(theirDm, gadingDm)).toBe(false);
  });

  test("a group sees only what was said in it", () => {
    expect(canSeeEpisode(group, family)).toBe(true);
    expect(canSeeEpisode(gadingWithNix, family)).toBe(false);
  });
});

describe("who may read a fact", () => {
  test("a fact is readable where its source conversation is", () => {
    const toldNixInPrivate = { readers: readersOf({ kind: "dm", chat: "telegram:nix:777", people: ["sam"] }) };
    expect(canSeeFact(toldNixInPrivate, "sam", miraDm)).toBe(true);
    expect(canSeeFact(toldNixInPrivate, "sam", gadingDm)).toBe(false);
    expect(canSeeFact(toldNixInPrivate, "sam", family)).toBe(false);

    const saidInTheGroup = { readers: readersOf({ kind: "group", chat: "telegram:nouva:-1001", people: ["gading", "sam"] }) };
    expect(canSeeFact(saidInTheGroup, "sam", family)).toBe(true);
    expect(canSeeFact(saidInTheGroup, "sam", gadingDm)).toBe(true);
  });

  test("what Gading said about Sam behind her back never reaches her", () => {
    const aboutHer = { readers: readersOf({ kind: "dm", chat: "telegram:nouva:814", people: ["gading"] }) };
    expect(canSeeFact(aboutHer, "sam", miraDm)).toBe(false);
    expect(canSeeFact(aboutHer, "sam", gadingDm)).toBe(true);
  });

  test("a line a person wrote is readable wherever its subject is present", () => {
    expect(canSeeFact({}, "sam", miraDm)).toBe(true);
    expect(canSeeFact({}, "sam", family)).toBe(true);
    expect(canSeeFact({}, "sam", gadingDm)).toBe(false);
  });
});

describe("keyword search", () => {
  test("tokens fold case and diacritics and drop words that mean nothing", () => {
    expect(tokens("Rencana ke BALI di bulan Desember, kafé!")).toEqual(["rencana", "bali", "bulan", "desember", "kafe"]);
    expect(queryTerms("bali bali liburan")).toEqual(["bali", "liburan"]);
    expect(ftsDoc({ body: "bali bali liburan" })).toEqual({ summary: "", tags: "", body: "bali bali liburan", roots: "libur" });
  });

  /**
   * The ranking itself is FTS5's now, and tested against a real database in `fts.test.ts` — this is
   * the half that is still ours: what the query says.
   */
  test("a query is each word — as a prefix from four letters — or the roots its affixes hide", () => {
    expect(String(ftsQuery("liburan laptops"))).toBe('"liburan"* OR "libur" OR "laptop"*');
    expect(String(ftsQuery("ke bali"))).toBe('"bali"*');
    expect(String(ftsQuery("tv"))).toBe('"tv"');
  });
});

describe("tags", () => {
  test("folded to one spelling, aliased, stop words, dates and duplicates refused; the gate caps", () => {
    const aliases = new Map([["nouride-engine", "nouride"]]);
    const normal = normalizeTags(["#Nouride", "Nouride Engine", "[[tags/android]]", "chat", "android", "2026-09-25", "a", "b", "c", "d", "e"], aliases);
    expect(normal).toEqual(["nouride", "android", "a", "b", "c", "d", "e"]);
    // A young vault may coin three; the cap is four whatever was proposed.
    expect(fileTags(normal, { inUse: new Map(), aliases, newAllowed: 10, qualifiedAt: 5 }).tags).toEqual(["nouride", "android", "a", "b"]);
  });
});
