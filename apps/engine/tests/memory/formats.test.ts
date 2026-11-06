/**
 * The vault's file formats, round-tripped: an episode, a profile's facts and who may read them,
 * frontmatter written one way and read back from hand edits, and the calendar memory dates by.
 *
 * Then the same files as builds wrote them, kept here as text and read through the parser — golden
 * files. A round trip stays green when the writer and the reader change together; these do not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { isoWeek, localTime } from "@/commons/clock.ts";
import { parseEpisode, renderEpisode, type Episode } from "@/modules/memory/episode.ts";
import { parseFront, renderFront } from "@/modules/memory/frontmatter.ts";
import type { MemoryIndexPort } from "@/modules/memory/memory-index.store.ts";
import { applyFacts, factsOf, readProfile, withoutSources, writeProfile } from "@/modules/memory/profile.ts";
import { applyWaiting, approveProposal, denyProposal, isProposal, listProposals, type Proposal } from "@/modules/memory/proposals.ts";
import { lastTidy, undoBlock } from "@/modules/memory/tidy.ts";
import { slugOf, vaultAt, type Vault } from "@/modules/memory/vault.ts";
import { tempDir } from "../helpers.ts";

const episode: Episode = {
  id: "2026-09-25-0459-nouva",
  status: "summarized",
  kind: "group",
  chat: "telegram:nouva:-1001",
  started: "2026-09-25T04:59:44+07:00",
  ended: "2026-09-25T05:31:10+07:00",
  day: "2026-09-25",
  agents: ["nouva", "nix"],
  people: ["gading", "telegram:814"],
  mentions: ["sam"],
  group: "keluarga",
  tags: ["nouride", "android"],
  importance: 3,
  related: ["2026-09-20-1405-nix"],
  summary: 'Gading asked: does Nouride run on an old "Android" phone?',
  transcript: "04:59 · Gading\nNouride bisa dipakein di android lawas?\n",
};

describe("an episode file", () => {
  test("round-trips, with wikilinks for what is a node and plain ids for what is not", () => {
    const text = renderEpisode(episode);
    expect(text).toContain('people: ["[[people/gading]]", "telegram:814"]');
    expect(text).toContain('group: "[[groups/keluarga]]"');
    expect(text).toContain('day: "[[days/2026/09/2026-09-25]]"');
    expect(parseEpisode(text, episode.id)).toEqual(episode);
  });

  test("a compacted episode has no body; a raw one has no summary", () => {
    const compacted = { ...episode, status: "compacted" as const, transcript: "" };
    expect(parseEpisode(renderEpisode(compacted), episode.id)).toEqual(compacted);
    const { summary: _s, importance: _i, ...raw } = { ...episode, status: "raw" as const, tags: [], related: [], mentions: [] };
    expect(parseEpisode(renderEpisode(raw as Episode), episode.id)).toEqual(raw as Episode);
  });

  test("the file name is the id, and a broken file says why", () => {
    expect(parseEpisode(renderEpisode(episode), "not-an-id")).toEqual({ problem: '"not-an-id" is not an episode id' });
    expect(parseEpisode("no frontmatter", episode.id)).toEqual({ problem: "no frontmatter" });
    expect(parseEpisode("---\nstatus: done\n---\n", episode.id)).toEqual({ problem: 'status "done"' });
  });
});

describe("frontmatter", () => {
  test("reads a hand edit: block lists, single quotes, bare words, numbers", () => {
    const parsed = parseFront("---\ntags:\n  - '[[tags/bali]]'\n  - liburan\nimportance: 4\nname: Kak Sam\nnote: 'it''s'\n---\nbody\n");
    expect(parsed).toEqual({ front: { tags: ["[[tags/bali]]", "liburan"], importance: 4, name: "Kak Sam", note: "it's" }, body: "body\n" });
  });

  test("quotes what YAML would read as something else", () => {
    const text = renderFront({ a: "yes", b: "12", c: "x: y", d: "plain words" }, "");
    expect(text).toBe('---\na: "yes"\nb: "12"\nc: "x: y"\nd: plain words\n---\n');
    expect(parseFront(text)?.front).toEqual({ a: "yes", b: "12", c: "x: y", d: "plain words" });
  });

  test("a list item with a quote and a comma in it comes back as one item", () => {
    // The escape inside a quoted flow item was not tested: reading `\"` as the end of the string split
    // this into pieces, with every test here green.
    const front = { titles: ['said "later, maybe" and left', "plain"] };
    expect(parseFront(renderFront(front, ""))?.front).toEqual(front);
  });
});

describe("a profile", () => {
  const body = [
    "## Work",
    "- Uses a MacBook Pro M3. ([[2026-09-20-1405-nix]]) {gading}",
    "- Porch light off at 22:00. ([[2026-09-26-1310-nix]]) {gading, sam, in telegram:nouva:-1001}",
    "",
    "Some prose a person wrote.",
    "",
    "## Life",
    "- Likes black coffee.",
  ].join("\n");

  test("reads facts with their source and readers; prose is not a fact", () => {
    expect(factsOf(body)).toEqual([
      { n: 1, section: "Work", text: "Uses a MacBook Pro M3.", source: "2026-09-20-1405-nix", readers: { people: ["gading"] } },
      { n: 2, section: "Work", text: "Porch light off at 22:00.", source: "2026-09-26-1310-nix", readers: { people: ["gading", "sam"], chat: "telegram:nouva:-1001" } },
      { n: 3, section: "Life", text: "Likes black coffee." },
    ]);
  });

  test("removing a heading's last fact drops the heading; one with prose under it stays", () => {
    const profile = ["## Follow-ups", "- Pay the bill (on 2026-09-30).", "", "## Notes", "Written by hand.", "", "## Family", "- Mother's birthday (on --10-02).", ""].join("\n");
    const result = applyFacts(profile, [{ op: "remove", n: 1 }]);
    expect(result.body).toBe(["## Notes", "Written by hand.", "", "## Family", "- Mother's birthday (on --10-02).", ""].join("\n"));
    expect(applyFacts(result.body, [{ op: "remove", n: 1 }]).body).toBe(["## Notes", "Written by hand.", ""].join("\n"));
  });

  test("operations by number, stamped with where they came from; a bad one is refused, a duplicate add skipped", () => {
    const provenance = { source: "2026-09-27-0900-nouva", readers: { people: ["gading"] } };
    const result = applyFacts(
      body,
      [
        { op: "update", n: 1, text: "Uses a MacBook Pro M4." },
        { op: "remove", n: 3 },
        { op: "add", section: "Life", text: "Moving to Bandung." },
        { op: "add", section: "Health", text: "Allergic to peanuts." },
        { op: "add", section: "Work", text: "porch light off at 22:00." },
        { op: "remove", n: 9 },
        { op: "update", n: 1, text: "twice" },
      ],
      provenance,
    );
    expect(result.rejected.map((r) => r.reason)).toEqual(["no fact 9", "fact 1 was already changed in this batch"]);
    expect(result.body).toBe(
      [
        "## Work",
        "- Uses a MacBook Pro M4. ([[2026-09-27-0900-nouva]]) {gading}",
        "- Porch light off at 22:00. ([[2026-09-26-1310-nix]]) {gading, sam, in telegram:nouva:-1001}",
        "",
        "Some prose a person wrote.",
        "",
        "## Life",
        "- Moving to Bandung. ([[2026-09-27-0900-nouva]]) {gading}",
        "",
        "## Health",
        "- Allergic to peanuts. ([[2026-09-27-0900-nouva]]) {gading}",
        "",
      ].join("\n"),
    );
  });

  test("the frontmatter survives an edit, and deleting an episode takes the facts it sourced", () => {
    const text = writeProfile({ front: { type: "person", name: "Gading" }, body });
    expect(readProfile(text)).toEqual({ front: { type: "person", name: "Gading" }, body: `${body}\n` });
    expect(withoutSources(body, new Set(["2026-09-26-1310-nix"]))).toEqual({ body: body.replace("- Porch light off at 22:00. ([[2026-09-26-1310-nix]]) {gading, sam, in telegram:nouva:-1001}\n", ""), removed: 1 });
  });
});

describe("the vault", () => {
  test("folders by kind, episodes by month, nothing climbs out", () => {
    const vault = vaultAt("/m");
    expect(vault.episode("2026-09-25-0459-nouva")).toBe("/m/episodes/2026/09/2026-09-25-0459-nouva.md");
    expect(vault.archive("2026-09-25-0459-nouva-2")).toBe("/m/archive/2026/09/2026-09-25-0459-nouva-2.md.gz");
    expect(vault.person("gading")).toBe("/m/people/gading.md");
    expect(vault.agent("Nouva")).toBe("/m/agents/nouva.md");
    expect(() => vault.person("../etc")).toThrow();
    expect(() => vault.episode("../2026")).toThrow();
    expect(() => vault.day("today")).toThrow();
  });

  test("slugs", () => {
    expect(slugOf("Liburan Bali!")).toBe("liburan-bali");
    expect(slugOf("Kafé")).toBe("kafe");
    expect(slugOf("☕")).toBeNull();
  });
});

describe("the calendar", () => {
  test("the day and time the person lives in, and ISO weeks across a year's edge", () => {
    expect(localTime(Date.UTC(2026, 8, 24, 21, 59, 44), "Asia/Jakarta")).toMatchObject({ day: "2026-09-25", time: "04:59", slug: "0459", iso: "2026-09-25T04:59:44+07:00", month: "2026-09" });
    expect(isoWeek("2026-09-25")).toBe("2026-W39");
    expect(isoWeek("2021-01-03")).toBe("2020-W53");
    expect(isoWeek("2024-12-30")).toBe("2025-W01");
  });
});

/**
 * Golden files: each is the text a build wrote, kept as it was, and asserted field by field through what reads it.
 * A change that makes one of these fail is a change of the vault's format: the marker has to move with it
 * (`format.ts`), and the files already written still have to read — or, for a form the floor's release brought
 * forward on disk, be refused by name.
 */
describe("golden files, as each build wrote them", () => {
  test("a 0.6 episode: its day linked flat — not read, every 0.7.x relinked it; the problem names the link to write", () => {
    const text = [
      "---",
      "id: 2026-09-20-1405-nix",
      "type: episode",
      "status: summarized",
      "kind: dm",
      "chat: telegram:nix:5550001111",
      "started: 2026-09-20T14:05:12+07:00",
      "ended: 2026-09-20T14:22:40+07:00",
      'day: "[[days/2026-09-20]]"',
      'agents: ["[[agents/nix]]"]',
      'people: ["[[people/gading]]"]',
      'tags: ["[[tags/macbook]]", "[[tags/work]]"]',
      "importance: 2",
      'summary: "Gading said he works on a MacBook Pro M3."',
      "---",
      "",
      "14:05 · Gading",
      "Laptopku MacBook Pro M3, buat kerja.",
      "",
      "14:06 · Nix",
      "Catat ya.",
      "",
    ].join("\n");
    expect(parseEpisode(text, "2026-09-20-1405-nix")).toEqual({ problem: 'day "days/2026-09-20" is not where its hub is: link it as [[days/2026/09/2026-09-20]]' });
    // Linked as 0.7 writes it, the same file reads.
    expect(parseEpisode(text.replace("[[days/2026-09-20]]", "[[days/2026/09/2026-09-20]]"), "2026-09-20-1405-nix")).toMatchObject({ day: "2026-09-20", tags: ["macbook", "work"] });
  });

  test("a 0.7 episode: its day linked by month — and this build still writes exactly that", () => {
    const text = [
      "---",
      "id: 2026-09-25-0459-nouva",
      "type: episode",
      "status: summarized",
      "kind: group",
      "chat: telegram:nouva:-1001",
      "started: 2026-09-25T04:59:44+07:00",
      "ended: 2026-09-25T05:31:10+07:00",
      'day: "[[days/2026/09/2026-09-25]]"',
      'agents: ["[[agents/nouva]]", "[[agents/nix]]"]',
      'people: ["[[people/gading]]", "telegram:814"]',
      'mentions: ["[[people/sam]]"]',
      'group: "[[groups/keluarga]]"',
      'tags: ["[[tags/nouride]]", "[[tags/android]]"]',
      "importance: 3",
      'related: ["[[2026-09-20-1405-nix]]"]',
      String.raw`summary: "Gading asked whether Nouride runs on an old \"Android\" phone."`,
      "---",
      "",
      "04:59 · Gading",
      "Nouride bisa dipakein di android lawas?",
      "",
      "05:01 · Nouva",
      "Bisa, asal RAM-nya cukup.",
      "",
    ].join("\n");
    const read: Episode = {
      id: "2026-09-25-0459-nouva",
      status: "summarized",
      kind: "group",
      chat: "telegram:nouva:-1001",
      started: "2026-09-25T04:59:44+07:00",
      ended: "2026-09-25T05:31:10+07:00",
      day: "2026-09-25",
      agents: ["nouva", "nix"],
      people: ["gading", "telegram:814"],
      mentions: ["sam"],
      group: "keluarga",
      tags: ["nouride", "android"],
      importance: 3,
      related: ["2026-09-20-1405-nix"],
      summary: 'Gading asked whether Nouride runs on an old "Android" phone.',
      transcript: "04:59 · Gading\nNouride bisa dipakein di android lawas?\n\n05:01 · Nouva\nBisa, asal RAM-nya cukup.\n",
    };
    expect(parseEpisode(text, "2026-09-25-0459-nouva")).toEqual(read);
    expect(renderEpisode(read)).toBe(text);
  });

  test("a profile: facts under headings, each with where it came from and who may read it", () => {
    const text = [
      "---",
      "type: person",
      "name: Gading",
      "---",
      "",
      "## Work",
      "- Uses a MacBook Pro M3. ([[2026-09-20-1405-nix]]) {gading}",
      "- Porch light off at 22:00. ([[2026-09-26-1310-nix]]) {gading, sam, in telegram:nouva:-1001}",
      "",
      "Some prose a person wrote.",
      "",
      "## Life",
      "- Likes black coffee.",
      "- Moving to Bandung. {gading}",
      "",
    ].join("\n");
    const profile = readProfile(text);
    expect(profile.front).toEqual({ type: "person", name: "Gading" });
    expect(factsOf(profile.body)).toEqual([
      { n: 1, section: "Work", text: "Uses a MacBook Pro M3.", source: "2026-09-20-1405-nix", readers: { people: ["gading"] } },
      { n: 2, section: "Work", text: "Porch light off at 22:00.", source: "2026-09-26-1310-nix", readers: { people: ["gading", "sam"], chat: "telegram:nouva:-1001" } },
      // Written by a person: no source, and no list of readers.
      { n: 3, section: "Life", text: "Likes black coffee." },
      // Told to a tool mid-conversation: readers, but no episode yet.
      { n: 4, section: "Life", text: "Moving to Bandung.", readers: { people: ["gading"] } },
    ]);
  });
});

describe("golden files in the vault's hidden folders", () => {
  let dir: string;
  let vault: Vault;
  beforeEach(() => {
    dir = tempDir("golden");
    vault = vaultAt(dir);
  });
  afterEach(() => removePath(dir));

  const put = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  /** What a decision writes through. Never reached below — a proposal of another shape is refused before a profile is read. */
  const writes = () => ({ vault, index: {} as MemoryIndexPort, state: { recordChanges: () => undefined }, now: () => 1 });

  /** A proposal revised by a later conversation, as `propose` writes one. */
  const PROPOSAL = [
    "{",
    '  "episode": "2026-09-27-2105-nouva",',
    '  "subject": "gading",',
    '  "operation": {',
    '    "op": "update",',
    '    "n": 2,',
    '    "text": "Porch light off at 23:00."',
    "  },",
    '  "provenance": {',
    '    "source": "2026-09-27-2105-nouva",',
    '    "readers": {',
    '      "people": [',
    '        "gading",',
    '        "sam"',
    "      ],",
    '      "chat": "telegram:nouva:-1001"',
    "    }",
    "  },",
    '  "why": "review",',
    '  "id": "3f9a0c1d2e4b",',
    '  "createdAt": 1790404800000,',
    '  "current": "Porch light off at 22:00.",',
    '  "revisedAt": 1790517900000',
    "}",
    "",
  ].join("\n");
  const READ: Proposal = {
    episode: "2026-09-27-2105-nouva",
    subject: "gading",
    operation: { op: "update", n: 2, text: "Porch light off at 23:00." },
    provenance: { source: "2026-09-27-2105-nouva", readers: { people: ["gading", "sam"], chat: "telegram:nouva:-1001" } },
    why: "review",
    id: "3f9a0c1d2e4b",
    createdAt: 1790404800000,
    current: "Porch light off at 22:00.",
    revisedAt: 1790517900000,
  };
  /** The shape proposals had for a day before 0.6.0 shipped — a file and an agent, no subject, no readers. */
  const BEFORE_060 = [
    "{",
    '  "id": "0a1b2c3d4e5f",',
    '  "createdAt": 1790301600000,',
    '  "agent": "nouva",',
    '  "source": "2026-09-25-0900-nouva",',
    '  "file": "people/gading.md",',
    '  "operation": { "op": "add", "section": "Work", "text": "Uses a MacBook Pro M3." },',
    '  "why": "shared"',
    "}",
    "",
  ].join("\n");

  test("a proposal file is read back whole; one of another shape, or broken, is not read at all", async () => {
    put(".proposals/3f9a0c1d2e4b.json", PROPOSAL);
    put(".proposals/0a1b2c3d4e5f.json", BEFORE_060);
    put(".proposals/9z8y7x6w5v4u.json", '{"id": "9z8y7x6w5v4u", "subject": "gading"');
    expect(await listProposals(vault)).toEqual([READ]);
  });

  test("one of another shape is refused when decided, named, and left where it is", async () => {
    put(".proposals/0a1b2c3d4e5f.json", BEFORE_060);
    const reason = "proposal 0a1b2c3d4e5f is not one this build can read: fix or remove .proposals/0a1b2c3d4e5f.json by hand";
    expect(await approveProposal(writes(), "0a1b2c3d4e5f", "approval")).toEqual({ status: "refused", reason });
    expect(await denyProposal(vault, "0a1b2c3d4e5f")).toEqual({ status: "refused", reason });
    expect(existsSync(join(dir, ".proposals", "0a1b2c3d4e5f.json"))).toBe(true);
  });

  test("the nightly pass does not apply one of another shape — it has no subject, so it would land in people/undefined.md", async () => {
    put(".proposals/0a1b2c3d4e5f.json", BEFORE_060);
    expect(await applyWaiting(writes(), () => true)).toBe(0);
    expect(existsSync(join(dir, "people", "undefined.md"))).toBe(false);
  });

  test("isProposal checks every field a decision reads", () => {
    expect(isProposal(READ)).toBe(true);
    const { current: _current, revisedAt: _revisedAt, ...fresh } = READ;
    expect(isProposal({ ...fresh, subject: "shared", operation: { op: "add", section: "Home", text: "The router is in the hall." } })).toBe(true);
    for (const broken of [
      { ...READ, subject: undefined },
      { ...READ, subject: "../etc" },
      { ...READ, id: "../../config" },
      { ...READ, createdAt: "yesterday" },
      { ...READ, episode: 7 },
      { ...READ, revisedAt: "later" },
      { ...READ, operation: { op: "update", text: "No number." } },
      { ...READ, operation: { op: "rename", n: 1 } },
      { ...READ, operation: { op: "remove", n: 0 } },
      { ...READ, current: 22 },
      { ...READ, provenance: { source: "2026-09-27-2105-nouva" } },
      { ...READ, provenance: { readers: { people: "gading" } } },
      { ...READ, why: "because" },
      [READ],
      null,
    ]) {
      expect({ broken, read: isProposal(broken) }).toEqual({ broken, read: false });
    }
  });

  /** A tag tidy's record, as `applyTidy` writes one into `tags/_tidy/`. */
  const TIDY = [
    "---",
    "type: tag-tidy",
    "at: 2026-10-02T09:15:00.000Z",
    "actor: gading",
    "changes: 1",
    "episodes: 2",
    "---",
    "",
    "## Changes",
    "- merge cron-jobs → cron-job (R1)",
    "",
    "## Episodes",
    "- 2026-09-10-0900-nouva: [cron-jobs, homelab] → [cron-job, homelab]",
    "- 2026-09-11-0930-nix: [cron-jobs] → [cron-job]",
    "",
    "## Undo",
    "```json",
    String.raw`{"episodes":{"2026-09-10-0900-nouva":{"before":["cron-jobs","homelab"],"after":["cron-job","homelab"]},"2026-09-11-0930-nix":{"before":["cron-jobs"],"after":["cron-job"]}},"stubs":{"cron-jobs":"---\ntype: tag\naliases: [\"cronjobs\"]\n---\n\nScheduled jobs.\n","cron-job":null}}`,
    "```",
    "",
  ].join("\n");

  test("a tidy record: what undo reads from its block, and what the card shows from its frontmatter", async () => {
    expect(undoBlock(TIDY)).toEqual({
      episodes: {
        "2026-09-10-0900-nouva": { before: ["cron-jobs", "homelab"], after: ["cron-job", "homelab"] },
        "2026-09-11-0930-nix": { before: ["cron-jobs"], after: ["cron-job"] },
      },
      stubs: { "cron-jobs": '---\ntype: tag\naliases: ["cronjobs"]\n---\n\nScheduled jobs.\n', "cron-job": null },
    });
    put("tags/_tidy/2026-10-02T09-15-00-000Z.md", TIDY);
    expect(await lastTidy(vault)).toEqual({ file: join(dir, "tags", "_tidy", "2026-10-02T09-15-00-000Z.md"), at: "2026-10-02T09:15:00.000Z", changes: 1, episodes: 2 });
  });

  test("a tidy record from before 0.7.7, its stubs keyed by where they were, is not read — 0.7.x rekeyed it by tag", () => {
    const before077 = TIDY.replace(
      /```json\n[\s\S]*?\n```/,
      ["```json", String.raw`{"episodes":{"2026-09-10-0900-nouva":{"before":["cron-jobs"],"after":["cron-job"]}},"stubs":{"/srv/nouride/.nouride/memories/tags/cron-jobs.md":"---\ntype: tag\n---\n","/srv/nouride/.nouride/memories/tags/cron-job.md":null}}`, "```"].join("\n"),
    );
    // Undo writes and removes what a record names, so a key that is not a tag is refused whole, never followed.
    expect(undoBlock(before077)).toBeNull();
  });

  test("a tidy record whose block is not one is not read, whole", () => {
    const block = (json: string) => TIDY.replace(/```json\n[\s\S]*?\n```/, `\`\`\`json\n${json}\n\`\`\``);
    expect(undoBlock(block(String.raw`{"episodes":{"../../config":{"before":[],"after":[]}},"stubs":{}}`))).toBeNull();
    expect(undoBlock(block(String.raw`{"episodes":{"2026-09-10-0900-nouva":{"before":"cron-jobs","after":["cron-job"]}},"stubs":{}}`))).toBeNull();
    expect(undoBlock(block(String.raw`{"episodes":{}}`))).toBeNull();
    expect(undoBlock(block("not json"))).toBeNull();
    expect(undoBlock(TIDY.replace("```json", "```"))).toBeNull();
  });
});
