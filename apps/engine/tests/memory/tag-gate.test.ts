/**
 * The tag gate, the English check and the vocabulary — the rules every memory writer goes through.
 * Pure, so each rule is pinned from both sides here,
 * and the household shapes at the bottom check the behaviour holds on installs that are not the
 * production box: a fresh one, a big one, a model that coins on every answer.
 */

import { describe, expect, test } from "bun:test";
import { memoryTextIsEnglish } from "@/modules/memory/english.ts";
import { fileTags, foldTag, newAllowedFor, qualifiedAtFor, vocabularyOf, type TagContext } from "@/modules/memory/tags.ts";

const ctx = (inUse: Record<string, number>, extra: Partial<TagContext> = {}): TagContext => ({
  inUse: new Map(Object.entries(inUse)),
  aliases: new Map(),
  newAllowed: 1,
  qualifiedAt: 5,
  ...extra,
});

describe("folding into a tag in use", () => {
  const vault = { reminder: 9, "cron-job": 4, blogging: 3, homelab: 40, architecture: 12, "open-source": 3, kubernetes: 6 };

  test("R1: plurals and separators", () => {
    expect(foldTag("reminders", ctx(vault))).toMatchObject({ into: "reminder", rule: "R1" });
    expect(foldTag("opensource", ctx(vault))).toMatchObject({ into: "open-source", rule: "R1" });
  });

  test("R2: one edit apart, long enough, the other in real use", () => {
    expect(foldTag("kubernets", ctx(vault))).toMatchObject({ into: "kubernetes", rule: "R2" });
    expect(foldTag("rookie", ctx({ cookie: 9 }))).toBeNull();
    // An edit at the last letter is another word far more often than a typo.
    expect(foldTag("routes", ctx({ router: 9 }))).toBeNull();
    expect(foldTag("photon", ctx({ photos: 9 }))).toBeNull();
  });

  test("R3: a short form only by an English suffix — blog is blogging, home is not homelab", () => {
    expect(foldTag("blog", ctx(vault))).toMatchObject({ into: "blogging", rule: "R3" });
    expect(foldTag("home", ctx(vault))).toBeNull();
    expect(foldTag("book", ctx({ bookkeeping: 9 }))).toBeNull();
  });

  test("R5 folds a qualified tag only when asked; R4, two tags in use, never", () => {
    expect(foldTag("architecture-review", ctx(vault))).toBeNull();
    expect(foldTag("architecture-review", ctx(vault), { qualified: true })).toMatchObject({ into: "architecture", rule: "R5" });
    expect(foldTag("homelab-architecture", ctx(vault), { qualified: true })).toBeNull();
  });
});

describe("filing an episode's tags", () => {
  const vault = { homelab: 40, proxmox: 12, reminder: 9 };

  test("tags in use first, then at most one new — whatever the model proposed", () => {
    const filed = fileTags(["edge-computing", "homelab", "cctv-setup", "proxmox", "imposter-syndrome"], ctx(vault));
    expect(filed.tags).toEqual(["homelab", "proxmox", "edge-computing"]);
    expect(filed.created).toEqual(["edge-computing"]);
    expect(filed.dropped).toEqual(["cctv-setup", "imposter-syndrome"]);
  });

  test("a fold counts as reuse of the tag it lands on, and lands once", () => {
    const filed = fileTags(["reminders", "reminder"], ctx(vault));
    expect(filed).toMatchObject({ tags: ["reminder"], folded: [{ from: "reminders", into: "reminder", rule: "R1" }], created: [] });
  });

  test("an import coins nothing: it keeps what folds, else its first tag — never nothing", () => {
    expect(fileTags(["architecture-review", "foo-bar"], ctx({ architecture: 12 }, { newAllowed: 0 })).tags).toEqual(["architecture"]);
    expect(fileTags(["foo-bar", "baz"], ctx({}, { newAllowed: 0 })).tags).toEqual(["foo-bar"]);
  });

  test("at most four, and idempotent", () => {
    const first = fileTags(["homelab", "proxmox", "reminder", "a", "b", "c"], ctx(vault, { newAllowed: 3 }));
    expect(first.tags).toHaveLength(4);
    expect(fileTags(first.tags, ctx(vault, { newAllowed: 3 })).tags).toEqual(first.tags);
  });

  test("an audience's first twenty conversations may coin three, later ones one; R5's bar grows with the vault", () => {
    expect([newAllowedFor(0), newAllowedFor(19), newAllowedFor(20)]).toEqual([3, 3, 1]);
    expect([qualifiedAtFor(100), qualifiedAtFor(2_000)]).toEqual([5, 20]);
  });
});

describe("the vocabulary a model is shown", () => {
  const day = 86_400_000;
  const now = 100 * day;

  test("shared tags by use, then this month's once-used ones; an old one-off is left out", () => {
    const vocabulary = vocabularyOf(
      [
        { tag: "homelab", n: 9, last: now },
        { tag: "proxmox", n: 3, last: now - 50 * day },
        { tag: "fresh", n: 1, last: now - 2 * day },
        { tag: "old-import", n: 1, last: now - 90 * day },
      ],
      now,
    );
    expect(vocabulary).toEqual({ tags: ["homelab", "proxmox", "fresh"], shared: 2, tagged: 0 });
  });

  test("capped at about a thousand tokens of tags", () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({ tag: `tag-number-${i}`, n: 2, last: now }));
    expect(vocabularyOf(many, now).tags.join(", ").length).toBeLessThanOrEqual(4_000);
  });
});

describe("English", () => {
  test("English passes; Indonesian, Spanish, German and other scripts do not — names and quotes do not count", () => {
    expect(memoryTextIsEnglish("Gading is planning a holiday in Bali next month.")).toBe(true);
    expect(memoryTextIsEnglish("Prefers 'kopi susu' in the morning, from Warung Pak Dian.")).toBe(true);
    expect(memoryTextIsEnglish("Gading's wife and Sam's son went on the school trip.")).toBe(true);
    expect(memoryTextIsEnglish("Gading mau liburan ke Bali bulan depan dan tanya soal tiket.")).toBe(false);
    expect(memoryTextIsEnglish("Kerja di bank.")).toBe(false);
    expect(memoryTextIsEnglish("El usuario quiere que el asistente le recuerde la reunión.")).toBe(false);
    expect(memoryTextIsEnglish("Der Benutzer ist nicht zu Hause.")).toBe(false);
    expect(memoryTextIsEnglish("ユーザーは明日会議があります")).toBe(false);
    // Nothing to judge is not another language: a date, a number or an empty line is let through. With
    // that line inverted every case above still passed, and a fact that is only a date was refused.
    expect(memoryTextIsEnglish("2026-10-17, 08:30")).toBe(true);
    expect(memoryTextIsEnglish("")).toBe(true);
  });

  test("other languages in Latin letters are caught by their own words; English with borrowed terms is not", () => {
    expect(memoryTextIsEnglish("Người dùng muốn được nhắc về cuộc họp của gia đình.")).toBe(false);
    expect(memoryTextIsEnglish("Kullanıcı yarın için bir toplantı planlıyor ve çok heyecanlı.")).toBe(false);
    expect(memoryTextIsEnglish("Användaren vill inte att mötet flyttas och är på semester.")).toBe(false);
    expect(memoryTextIsEnglish("Gusto niya ng kape at hindi siya umiinom ng tsaa, sabi naman ni Ana.")).toBe(false);
    expect(memoryTextIsEnglish("Ora iso teka, aku karo kowe arep lunga.")).toBe(false);
    expect(memoryTextIsEnglish("Ordered kung pao chicken from the place on example.com after the ng build failed.")).toBe(true);
    expect(memoryTextIsEnglish("Moved the project to es2022 and lo-fi music for focus.")).toBe(true);
  });
});

/**
 * The same rules on households that are not the production box. Each night's model is a script; what
 * is measured is what the gate lets through over thirty nights.
 */
describe("other households", () => {
  function nights(input: { nights: number; perNight: number; propose: (night: number, i: number) => string[] }) {
    const inUse = new Map<string, number>();
    let created = 0;
    let empty = 0;
    let tagged = 0;
    for (let night = 0; night < input.nights; night += 1) {
      for (let i = 0; i < input.perNight; i += 1) {
        const filed = fileTags(input.propose(night, i), { inUse, aliases: new Map(), newAllowed: newAllowedFor(tagged), qualifiedAt: qualifiedAtFor(tagged) });
        created += filed.created.length;
        if (filed.tags.length === 0) empty += 1;
        else tagged += 1;
        for (const tag of filed.tags) inUse.set(tag, (inUse.get(tag) ?? 0) + 1);
      }
    }
    const once = [...inUse.values()].filter((n) => n === 1).length;
    return { tags: inUse.size, once, created, empty };
  }

  test("a model that coins five new tags on every answer: one per conversation, never an empty one", () => {
    const spam = nights({ nights: 30, perNight: 10, propose: (night, i) => Array.from({ length: 5 }, (_, k) => `topic-${night}-${i}-${k}`) });
    expect(spam.empty).toBe(0);
    // Three for the first twenty conversations, then one: 1,500 proposed became 340 — and a model that never
    // reuses a word cannot keep the audience young, because young is counted in conversations.
    expect(spam.created).toBe(20 * 3 + 280 * 1);
  });

  test("a fresh install whose model reuses its words: a vocabulary forms in the first nights and then holds", () => {
    const topics = ["school", "groceries", "health", "travel", "garden", "car", "bills", "birthday"];
    const family = nights({ nights: 30, perNight: 6, propose: (night, i) => [topics[(night + i) % topics.length]!, topics[(night * 3 + i) % topics.length]!] });
    expect(family.tags).toBe(topics.length);
    expect(family.once).toBe(0);
  });
});
