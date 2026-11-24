/**
 * Memory as an agent open to everyone reads it: what was opened to everyone, and nothing of a person's, whoever asks.
 *
 * An open agent answers anybody who finds it. A person the install knows who writes to it (its own admin, trying it)
 * must get the public's answers: a bot that knew more for some senders could be made to say it to others. So the
 * rule is the agent's, held where memory is asked, on every path a prompt or a tool reads by.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextFile } from "@nouride/runtime";
import { nobody, publicAudience } from "@/modules/memory/public.ts";
import { FAMILY, GADING_DM, at, household, speaker, type Household } from "./fixture.ts";

const CODE = "Has a Honda BR-V, plate BG 1891 ZD, fuel code 7741.";
/** The same person, in the same chats, writing to the agent that is open and to one that is not. */
const open = (where: typeof GADING_DM) => speaker(where, "nora");
const closed = (where: typeof GADING_DM) => speaker(where, "nouva");
const GADING_HERE = { ...FAMILY, senderId: "62811" };

let h: Household;

const put = (path: string, text: string) => {
  mkdirSync(join(h.knowledgeRoot, path, ".."), { recursive: true });
  writeFileSync(join(h.knowledgeRoot, path), text);
};

beforeEach(async () => {
  h = await household({ publicAgent: (agentId) => agentId === "nora" });
  // What the household holds: a fact he told an agent in private, shared knowledge every chat is given, a conversation
  // of his, a collection of his own, the family's, and one opened to everyone.
  await h.memory.noteAboutSpeaker(closed(GADING_DM), { op: "add", section: "Things", text: CODE });
  await writeTextFile(h.vault.shared, "---\ntype: shared\n---\n\n## House\n- The alarm code is kept in the blue folder.\n");
  h.dm(GADING_DM, "nouva", "Where did I park?", "Level 3, by the lift.", at(8));
  await h.memory.cut(GADING_DM.gatewayId, GADING_DM.chatId);
  h.group(GADING_HERE, "Halo semua", at(9));
  put("car/knowledge.toml", 'name = "Car"\nreaders = ["gading"]\n');
  put("car/fuel-code.md", "# Fuel code\nThe subsidy code for plate BG 1891 ZD is renewed every October.\n");
  put("family/knowledge.toml", 'name = "Family rules"\nreaders = "group:whatsapp:main:1203@g.us"\n');
  put("family/rules.md", "# Rules\nQuiet after ten in the evening.\n");
  put("shop/knowledge.toml", 'name = "Shop"\ndescription = "Prices and opening hours."\nreaders = "everyone"\n');
  put("shop/hours.md", "# Opening hours\nOpen from nine to five, closed on Sundays. The October price list is renewed monthly.\n");
  await h.memory.sync();
  await h.memory.knowledge.sync();
});

afterEach(() => h.close());

describe("what an open agent's prompt is given", () => {
  test("the collections opened to everyone, by name, and nothing else, for a person the install knows", () => {
    const given = h.memory.recall(open(GADING_DM));
    expect(given).toEqual({ profiles: [], shared: [], upcoming: [], followUps: [], recent: [], waiting: [], knowledge: [{ name: "Shop", description: "Prices and opening hours." }] });
    // The same person, the same chat, an agent that is not open: his facts, the shared knowledge, his own collection.
    const usual = h.memory.recall(closed(GADING_DM));
    expect(usual.profiles.flatMap((profile) => profile.facts.map((fact) => fact.text))).toContain(CODE);
    expect(usual.shared.map((fact) => fact.text)).toContain("The alarm code is kept in the blue folder.");
    expect(usual.knowledge?.map((collection) => collection.name).sort()).toEqual(["Car", "Shop"]);
  });

  test("in a group too: nothing of the one speaking is brought to it, and the group's own collection is not its to read", () => {
    const given = h.memory.recall(open(GADING_HERE));
    expect(given.own).toBeUndefined();
    expect(given.profiles).toEqual([]);
    expect(given.knowledge?.map((collection) => collection.name)).toEqual(["Shop"]);
    // An agent that is not open is told what he brings, on his own turn.
    expect(h.memory.recall(closed(GADING_HERE)).own?.facts.map((fact) => fact.text)).toContain(CODE);
  });
});

describe("what an open agent's tools reach", () => {
  test("a search finds the collection opened to everyone, and no fact, conversation or other collection", async () => {
    const all = async (query: string) => await h.memory.search(open(GADING_DM), { query });
    const october = await all("October");
    expect(october.map((hit) => (hit.kind === "section" ? hit.section.item : hit.kind))).toEqual(["knowledge:shop/hours.md#0"]);
    expect(await all("fuel code plate")).toEqual([]);
    expect(await all("park lift level")).toEqual([]);
    expect(await all("quiet evening rules")).toEqual([]);
    expect(await all("alarm blue folder")).toEqual([]);
    // What the same asks find for an agent that is not open: his fact, his conversation, his own collection.
    const usual = (await h.memory.search(closed(GADING_DM), { query: "fuel code plate" })).map((hit) => hit.kind);
    expect(usual).toEqual(expect.arrayContaining(["fact", "section"]));
    expect((await h.memory.search(closed(GADING_DM), { query: "park lift level" })).length).toBeGreaterThan(0);
  });

  test("a document is read and its file found only in a collection opened to everyone", () => {
    expect(h.memory.readKnowledge(open(GADING_DM), "knowledge:shop/hours.md#0")).toMatchObject({ collection: "Shop" });
    expect(h.memory.readKnowledge(open(GADING_DM), "knowledge:car/fuel-code.md#0")).toMatchObject({ refused: expect.stringContaining("that this chat may read") });
    expect(h.memory.readKnowledge(open(GADING_HERE), "knowledge:family/rules.md#0")).toMatchObject({ refused: expect.any(String) });
    expect(h.memory.knowledge.fileOf(open(GADING_DM), "knowledge:shop/hours.md#0")).toMatchObject({ name: "hours.md" });
    expect(h.memory.knowledge.fileOf(open(GADING_DM), "knowledge:car/fuel-code.md#0")).toMatchObject({ refused: expect.any(String) });
    // His own, in his own direct chat with an agent that is not open: read.
    expect(h.memory.readKnowledge(closed(GADING_DM), "knowledge:car/fuel-code.md#0")).toMatchObject({ collection: "Car" });
  });

  test("a conversation of his is not opened for it", async () => {
    const his = h.memory.recall(closed(GADING_DM)).waiting[0]!.id;
    expect(await h.memory.read(closed(GADING_DM), his)).toMatchObject({ id: his });
    expect(await h.memory.read(open(GADING_DM), his)).toMatchObject({ refused: expect.stringContaining("that this chat may see") });
  });

  test("nothing a chat tells it is kept: a fact and a document are both refused", async () => {
    expect(await h.memory.noteAboutSpeaker(open(GADING_DM), { op: "add", section: "Things", text: "Likes durian." })).toEqual({ refused: "This agent is open to everyone and keeps nothing a chat tells it." });
    expect(await h.memory.knowledge.keep(open(GADING_DM), { title: "A note", text: "Kept by a stranger.", where: "a chat", day: "2026-09-25" } as never)).toEqual({ refused: "This agent is open to everyone and keeps nothing a chat tells it." });
    expect(h.memory.recall(closed(GADING_DM)).profiles.flatMap((profile) => profile.facts.map((fact) => fact.text))).not.toContain("Likes durian.");
  });
});

describe("nobody", () => {
  test("is an identity no person's key and no connection's sender can be", () => {
    expect(nobody("nora")).toBe("public:nora");
    expect(publicAudience("nora")).toEqual({ kind: "dm", chat: "public:nora", person: "public:nora" });
  });
});
