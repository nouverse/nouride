/**
 * The knowledge base's folders, sections and index (0.8.20): collections as folders, who may
 * be answered from one, documents cut at headings with their trail, and the index kept in line with the files.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAndMigrate } from "@/db/index.ts";
import type { Audience } from "@/modules/memory/access.ts";
import { mayUse, parseSettings, readCollections, renderSettings, widens } from "@/modules/memory/knowledge/collections.ts";
import { htmlText } from "@/modules/memory/knowledge/extract.ts";
import { KnowledgeStore, parseItem, sectionItem } from "@/modules/memory/knowledge/knowledge.store.ts";
import { sectionsOfTable, sectionsOfText, titleOf } from "@/modules/memory/knowledge/sections.ts";
import { syncKnowledge } from "@/modules/memory/knowledge/sync.ts";
import { ftsQuery } from "@/modules/memory/terms.ts";
import { tempDir } from "../helpers.ts";

const dm = (person: string): Audience => ({ kind: "dm", chat: `telegram:nouva:${person}`, person });
const group = (chat: string, present: string[]): Audience => ({ kind: "group", chat, present });
const settings = (toml: string | null) => ({ settings: parseSettings("homelab", toml).settings });

describe("who may be answered from a collection", () => {
  const who = (audience: Audience, agentId = "nouva") => ({ agentId, audience, admins: ["gading"] });

  test("a folder with no settings is the admins', in a one-to-one chat", () => {
    expect(mayUse(settings(null), who(dm("gading")))).toBe(true);
    expect(mayUse(settings(null), who(dm("sam")))).toBe(false);
    // Not in a group, even one an admin is in.
    expect(mayUse(settings(null), who(group("whatsapp:main:1203@g.us", ["gading"])))).toBe(false);
  });

  test("named people in their own chats; never in a group, even one they are all in", () => {
    const private_ = settings('readers = ["gading", "mum"]');
    expect(mayUse(private_, who(dm("mum")))).toBe(true);
    expect(mayUse(private_, who(dm("sam")))).toBe(false);
    expect(mayUse(private_, who(group("whatsapp:main:1203@g.us", ["gading", "mum"])))).toBe(false);
  });

  test("a group's in that group alone; everyone's anywhere", () => {
    const family = settings('readers = "group:whatsapp:main:1203@g.us"');
    expect(mayUse(family, who(group("whatsapp:main:1203@g.us", ["sam"])))).toBe(true);
    expect(mayUse(family, who(group("telegram:nouva:-100", ["sam"])))).toBe(false);
    expect(mayUse(family, who(dm("sam")))).toBe(false);
    const open = settings('readers = "everyone"');
    expect(mayUse(open, who(dm("anyone")))).toBe(true);
    expect(mayUse(open, who(group("telegram:nouva:-100", ["x"])))).toBe(true);
  });

  test("every agent unless it names some; archived is never searched", () => {
    expect(mayUse(settings('readers = "everyone"\nagents = ["nix"]'), who(dm("gading"), "nouva"))).toBe(false);
    expect(mayUse(settings('readers = "everyone"\nagents = ["nix"]'), who(dm("gading"), "nix"))).toBe(true);
    expect(mayUse(settings('readers = "everyone"\narchived = true'), who(dm("gading")))).toBe(false);
  });

  test("a settings file that cannot be read is closed, and says why", () => {
    const broken = parseSettings("homelab", "readers = [");
    expect(broken.settings.readers).toEqual({ kind: "admins" });
    expect(broken.problem).toContain("knowledge.toml could not be read");
    const wrong = parseSettings("homelab", "readers = 5");
    expect(wrong.settings.readers).toEqual({ kind: "admins" });
    expect(wrong.problem).toContain('write "everyone", "admins", "group:<chat>", or a list of people\'s keys');
  });

  test("wider than a chat: everyone, another person, another group, or admins beyond the chat's own", () => {
    const me = { kind: "people", people: ["gading"] } as const;
    expect(widens({ kind: "everyone" }, me)).toBe(true);
    expect(widens({ kind: "people", people: ["gading", "sam"] }, me)).toBe(true);
    expect(widens({ kind: "people", people: ["gading"] }, me)).toBe(false);
    expect(widens({ kind: "group", chat: "b" }, { kind: "group", chat: "a" })).toBe(true);
    expect(widens({ kind: "group", chat: "a" }, { kind: "group", chat: "a" })).toBe(false);
    // The admins are the people they are: the one admin's chat does not widen the admins' folder; two admins do.
    expect(widens({ kind: "admins" }, me, ["gading"])).toBe(false);
    expect(widens({ kind: "admins" }, me, ["gading", "sam"])).toBe(true);
    expect(widens({ kind: "admins" }, { kind: "group", chat: "a" }, ["gading"])).toBe(true);
  });

  test("written back as read", () => {
    const read = parseSettings("health", 'name = "Mum\'s health"\ndescription = "Lab results"\nreaders = ["gading"]\nabout = ["mum"]\n').settings;
    expect(parseSettings("health", renderSettings(read)).settings).toEqual(read);
  });
});

describe("a document in sections", () => {
  test("cut at headings, each with the trail above it; a code fence's # is no heading", () => {
    const text = [
      "---",
      "tags: [policy]",
      "---",
      "# Expense policy",
      "Who it covers.",
      "## Travel",
      "### Hotels",
      "Up to Rp 1.5 million a night.",
      "```sh",
      "# not a heading",
      "```",
      "## Meals",
      "Receipts above Rp 200k.",
    ].join("\n");
    expect(titleOf(text, "file")).toBe("Expense policy");
    const sections = sectionsOfText(text, "Expense policy");
    expect(sections.map((section) => section.trail)).toEqual(["Expense policy", "Expense policy › Travel › Hotels", "Expense policy › Meals"]);
    expect(sections[1]!.text).toContain("# not a heading");
    expect(sections.map((section) => section.n)).toEqual([0, 1, 2]);
    expect(sections.some((section) => section.text.includes("tags:"))).toBe(false);
  });

  test("a long section cut again at paragraphs, none past the size", () => {
    const paragraph = (i: number) => `Paragraph ${i}. ${"word ".repeat(60)}`;
    const sections = sectionsOfText(`# Manual\n${Array.from({ length: 20 }, (_, i) => paragraph(i)).join("\n\n")}`, "Manual", 1_500);
    expect(sections.length).toBeGreaterThan(3);
    expect(sections.every((section) => section.text.length <= 1_500)).toBe(true);
    expect(sections.every((section) => section.trail === "Manual")).toBe(true);
    expect(sections.map((section) => section.text).join(" ")).toContain("Paragraph 19.");
  });

  test("a table in row ranges, each with its header", () => {
    const csv = ["sku,price", ...Array.from({ length: 450 }, (_, i) => `item-${i},${i}`)].join("\n");
    const sections = sectionsOfTable(csv, "Prices");
    expect(sections.map((section) => section.trail)).toEqual(["Prices › rows 1 to 200", "Prices › rows 201 to 400", "Prices › rows 401 to 450"]);
    expect(sections.every((section) => section.text.startsWith("sku,price\n"))).toBe(true);
  });

  test("a web page's words, its headings kept", () => {
    expect(htmlText("<html><style>x{}</style><h2>Rates</h2><p>Rp 1 &amp; 2</p><script>bad()</script></html>")).toBe("## Rates\n\nRp 1 & 2");
  });

  test("an item names one section or a whole document", () => {
    expect(sectionItem("homelab", "ops/runbook.md", 3)).toBe("knowledge:homelab/ops/runbook.md#3");
    expect(parseItem("knowledge:homelab/ops/runbook.md#3")).toEqual({ collection: "homelab", path: "ops/runbook.md", n: 3 });
    expect(parseItem("knowledge:homelab/ops/runbook.md#all")).toEqual({ collection: "homelab", path: "ops/runbook.md", n: "all" });
    expect(parseItem("ep_123")).toBeNull();
  });
});

describe("the index, in line with the folders", () => {
  async function bench() {
    const dir = tempDir("knowledge");
    const root = join(dir, "knowledge");
    const db = await openAndMigrate(join(dir, "data", "test.db"));
    const store = new KnowledgeStore(db);
    let clock = 1_000;
    const sync = (only?: string) => syncKnowledge({ root, store, now: () => clock++ }, only);
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    return { root, store, sync, write };
  }

  test("a document read, found by its words and its trail; unchanged left alone; gone dropped", async () => {
    const b = await bench();
    b.write("homelab/runbook.md", "# Proxmox runbook\n## Backups\nVzdump runs at 02:00 to the NAS.\n");
    b.write("homelab/photo.jpg", "not really a picture");
    b.write("homelab/knowledge.toml", 'readers = "everyone"\n');
    b.write("homelab/.hidden.md", "# secret");
    expect(await b.sync()).toEqual({ indexed: 1, unchanged: 0, dropped: 0, notSearched: 1 });
    expect(b.store.documents("homelab").map((d) => [d.path, d.status])).toEqual([
      ["photo.jpg", "listed"],
      ["runbook.md", "indexed"],
    ]);
    expect(b.store.document("homelab", "photo.jpg")!.reason).toBe("Nouride does not read this kind of file, so it is kept here but not searched.");
    // By its words, and by a heading above it alone.
    expect(b.store.rank(ftsQuery("vzdump")!, ["homelab"], 10)).toEqual(["knowledge:homelab/runbook.md#0"]);
    expect(b.store.rank(ftsQuery("proxmox backups")!, ["homelab"], 10)).toContain("knowledge:homelab/runbook.md#0");
    // Never a collection it was not asked for.
    expect(b.store.rank(ftsQuery("vzdump")!, ["finance"], 10)).toEqual([]);

    expect(await b.sync()).toEqual({ indexed: 0, unchanged: 2, dropped: 0, notSearched: 0 });

    b.write("homelab/runbook.md", "# Proxmox runbook\n## Backups\nPBS runs at 03:00 now.\n");
    utimesSync(join(b.root, "homelab/runbook.md"), new Date(), new Date(Date.now() + 5_000));
    expect((await b.sync()).indexed).toBe(1);
    expect(b.store.rank(ftsQuery("vzdump")!, ["homelab"], 10)).toEqual([]);
    expect(b.store.rank(ftsQuery("pbs")!, ["homelab"], 10)).toEqual(["knowledge:homelab/runbook.md#0"]);

    rmSync(join(b.root, "homelab/runbook.md"));
    expect((await b.sync()).dropped).toBe(1);
    expect(b.store.rank(ftsQuery("pbs")!, ["homelab"], 10)).toEqual([]);
    expect(b.store.sections(["knowledge:homelab/runbook.md#0"])).toEqual([]);
  });

  test("a collection's folder gone takes its documents; one collection synced alone leaves the others", async () => {
    const b = await bench();
    b.write("homelab/a.md", "# A\nalpha");
    b.write("finance/b.md", "# B\nbravo");
    await b.sync();
    rmSync(join(b.root, "finance"), { recursive: true });
    await b.sync("homelab");
    expect(b.store.collections()).toEqual(["finance", "homelab"]);
    await b.sync();
    expect(b.store.collections()).toEqual(["homelab"]);
    expect(readCollections(b.root).map((collection) => collection.id)).toEqual(["homelab"]);
  });

  test("the words written again after memory's index is cleared", async () => {
    const b = await bench();
    b.write("homelab/a.md", "# A\nalpha bravo");
    await b.sync();
    expect(b.store.rewriteWords()).toBe(1);
    expect(b.store.rank(ftsQuery("bravo")!, ["homelab"], 5)).toEqual(["knowledge:homelab/a.md#0"]);
  });
});
