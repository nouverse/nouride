/**
 * A person's own collection goes with them into a group, on the turns they are the one speaking, and what is found
 * there is that turn's alone.
 *
 * A collection of named people was never searched in a group, "even one its reader is in": a person who had an agent
 * keep a photo asked for it in a family group and was told there was no such thing. It is reached now on their own
 * turn, by search, by reading and by `send_file`; on anyone else's turn it is as it was; and a result that held any of
 * it is marked so the conversation keeps a line in its place (`ToolResult.turnOnly`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "@nouride/shared";
import type { BuiltPrompt, HarnessFacts } from "@/modules/llm/prompt/index.ts";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import type { Audience } from "@/modules/memory/access.ts";
import { goesWithItsReader, mayUse, parseSettings, renderSettings, type CollectionSettings } from "@/modules/memory/knowledge/collections.ts";
import { createSendFileTool } from "@/modules/tools/builtins/attach.ts";
import { createMemoryReadTool, OWN_FOR_THE_TURN, OWN_NOTE, speakerOf } from "@/modules/tools/builtins/memory.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { fakeAgent } from "../helpers.ts";
import { FAMILY, GADING_DM, TZ, at, household, speaker, type Household } from "./fixture.ts";

const GADING_HERE = { ...FAMILY, senderId: "62811" };
const SAM_HERE = { ...FAMILY, senderId: "62877" };
const ITEM = "knowledge:car/fuel-code.md#0";

let h: Household;

const put = (path: string, text: string) => {
  mkdirSync(join(h.knowledgeRoot, path, ".."), { recursive: true });
  writeFileSync(join(h.knowledgeRoot, path), text);
};

beforeEach(async () => {
  h = await household();
  h.group(GADING_HERE, "Halo semua", at(9));
  h.group(SAM_HERE, "Halo juga", at(9, 5));
  // His own, as one kept from his direct chat is; the family's, kept from the group; and one for everybody.
  put("car/knowledge.toml", 'name = "Car"\ndescription = "The car and its papers."\nreaders = ["gading"]\n');
  put("car/fuel-code.md", "# Fuel code\nThe subsidy code for plate BG 1891 ZD is renewed every October.\n");
  put("family/knowledge.toml", 'name = "Family rules"\nreaders = "group:whatsapp:main:1203@g.us"\n');
  put("family/rules.md", "# Rules\nQuiet after ten in the evening.\n");
  put("house/knowledge.toml", 'name = "House"\nreaders = "everyone"\n');
  put("house/wifi.md", "# Wifi\nThe guest network is called Tamu.\n");
  await h.memory.knowledge.sync();
});

afterEach(() => h.close());

const ctx = (where: typeof GADING_DM, extra: Record<string, unknown> = {}) => ({ agentId: "nouva", agentDir: join(h.dir, "agents", "nouva"), sessionId: "s", signal: new AbortController().signal, ...where, workspaceDir: h.dir, workspaceRoots: [h.dir], readOnlyRoots: [], ...extra }) as never;
const found = async (where: typeof GADING_DM, query: string) => (await h.memory.search(speaker(where), { query, kind: "knowledge" })).map((hit) => (hit.kind === "section" ? `${hit.section.item}${hit.own ? " own" : ""}` : ""));

describe("the rule, by whose turn it is", () => {
  const family: Audience = { kind: "group", chat: "whatsapp:main:1203@g.us", present: ["gading", "sam"] };
  const settings = (extra: Partial<CollectionSettings>): { settings: CollectionSettings } => ({ settings: { name: "Car", description: "", agents: null, readers: { kind: "people", people: ["gading"] }, about: [], archived: false, ...extra } });
  const who = (speaker: string | undefined, brings = true) => ({ agentId: "nouva", audience: { ...family, ...(speaker ? { speaker } : {}) }, admins: ["gading"], brings });

  test("a collection of named people is its reader's in a group on their own turn, and nobody else's", () => {
    expect(goesWithItsReader(settings({}), who("gading"))).toBe(true);
    expect(goesWithItsReader(settings({}), who("sam"))).toBe(false);
    expect(goesWithItsReader(settings({}), who(undefined))).toBe(false);
    expect(goesWithItsReader(settings({}), who("whatsapp:62899"))).toBe(false);
    // The admins': a folder made by hand, with no settings.
    expect(goesWithItsReader(settings({ readers: { kind: "admins" } }), who("gading"))).toBe(true);
    expect(goesWithItsReader(settings({ readers: { kind: "admins" } }), who("sam"))).toBe(false);
    // What the group reads whoever speaks is never counted twice, and another group's is not brought.
    expect(goesWithItsReader(settings({ readers: { kind: "everyone" } }), who("gading"))).toBe(false);
    expect(goesWithItsReader(settings({ readers: { kind: "group", chat: "whatsapp:main:9900@g.us" } }), who("gading"))).toBe(false);
    expect(mayUse(settings({}), who("gading"))).toBe(false);
  });

  test("the collection's own switch decides, and the install's where it says nothing", () => {
    expect(goesWithItsReader(settings({}), who("gading", false))).toBe(false);
    expect(goesWithItsReader(settings({ inGroups: true }), who("gading", false))).toBe(true);
    expect(goesWithItsReader(settings({ inGroups: false }), who("gading", true))).toBe(false);
  });

  test("never one put away, one another agent searches, or a direct chat", () => {
    expect(goesWithItsReader(settings({ archived: true }), who("gading"))).toBe(false);
    expect(goesWithItsReader(settings({ agents: ["nix"] }), who("gading"))).toBe(false);
    expect(goesWithItsReader(settings({}), { agentId: "nouva", audience: { kind: "dm", chat: "telegram:nouva:814", person: "gading" }, admins: [], brings: true })).toBe(false);
  });

  test("`in_groups` is read from the settings file and written back, and left out where it was never set", () => {
    expect(parseSettings("car", 'name = "Car"\nreaders = ["gading"]\nin_groups = false\n').settings.inGroups).toBe(false);
    expect(parseSettings("car", 'name = "Car"\nreaders = ["gading"]\n').settings.inGroups).toBeUndefined();
    expect(renderSettings(settings({ inGroups: false }).settings)).toContain("in_groups = false");
    expect(renderSettings(settings({}).settings)).not.toContain("in_groups");
  });
});

describe("through the memory service, as a turn asks it", () => {
  test("his turn in the family group finds his own, marked; hers finds the group's and everybody's, as before", async () => {
    expect(await found(GADING_HERE, "subsidy")).toEqual([`${ITEM} own`]);
    expect(await found(SAM_HERE, "subsidy")).toEqual([]);
    // What the group reads is found by both, and is nobody's own.
    expect(await found(GADING_HERE, "quiet")).toEqual(["knowledge:family/rules.md#0"]);
    expect(await found(SAM_HERE, "quiet")).toEqual(["knowledge:family/rules.md#0"]);
    expect(await found(SAM_HERE, "guest")).toEqual(["knowledge:house/wifi.md#0"]);
    // In his direct chat it is his collection as it always was: found, and not as something brought.
    expect(await found(GADING_DM, "subsidy")).toEqual([ITEM]);
  });

  test("the collections a group's prompt names are the same whoever speaks, and his own are named with what is his", () => {
    const asGading = h.memory.recall(speaker(GADING_HERE));
    const asSam = h.memory.recall(speaker(SAM_HERE));
    expect(asGading.knowledge!.map((one) => one.name)).toEqual(["Family rules", "House"]);
    expect(asSam.knowledge).toEqual(asGading.knowledge);
    expect(asGading.own).toEqual({ name: "Gading", facts: [], collections: [{ name: "Car", description: "The car and its papers." }] });
    expect(asSam.own).toBeUndefined();
  });

  test("the collection's switch off, or the install's with the collection saying nothing: his turn finds none of it", async () => {
    put("car/knowledge.toml", 'name = "Car"\nreaders = ["gading"]\nin_groups = false\n');
    expect(await found(GADING_HERE, "subsidy")).toEqual([]);
    expect(h.memory.recall(speaker(GADING_HERE)).own).toBeUndefined();

    put("car/knowledge.toml", 'name = "Car"\nreaders = ["gading"]\n');
    h.config.memory.privateInGroups = false;
    expect(await found(GADING_HERE, "subsidy")).toEqual([]);
    // Its own switch on is its own, whatever the install says.
    put("car/knowledge.toml", 'name = "Car"\nreaders = ["gading"]\nin_groups = true\n');
    expect(await found(GADING_HERE, "subsidy")).toEqual([`${ITEM} own`]);
  });

  test("a coding CLI's own call brings nothing: its session keeps what it is told", async () => {
    const hits = await h.memory.search({ ...speaker(GADING_HERE), keeps: true }, { query: "subsidy", kind: "knowledge" });
    expect(hits).toEqual([]);
    expect(h.memory.knowledge.fileOf({ ...speaker(GADING_HERE), keeps: true }, ITEM)).toMatchObject({ refused: expect.stringContaining("that this chat may read") });
  });
});

describe("the tools, and what the conversation keeps of what they found", () => {
  test("a search that found his own says whose it is, and is the turn's alone; one that found the group's is kept as ever", async () => {
    const search = createMemorySearchTool(h.memory);
    const own = await search.execute({ query: "subsidy" }, ctx(GADING_HERE));
    expect(own.isError).toBe(false);
    expect(String(own.content)).toContain(OWN_NOTE);
    expect(String(own.content)).toContain(`- document · Car (theirs) · Fuel code`);
    expect(own.turnOnly).toBe(OWN_FOR_THE_TURN);
    expect(OWN_FOR_THE_TURN).not.toContain("BG 1891");

    const group = await search.execute({ query: "quiet" }, ctx(GADING_HERE));
    expect(group.turnOnly).toBeUndefined();
    expect(String(group.content)).not.toContain("(theirs)");
    // His direct chat: his own collection is what the chat reads, kept in the conversation as any result.
    expect((await search.execute({ query: "subsidy" }, ctx(GADING_DM))).turnOnly).toBeUndefined();
    // Her turn: nothing of it, and the plain answer of a search that found nothing.
    expect((await search.execute({ query: "subsidy" }, ctx(SAM_HERE))).content).toBe("Nothing found that this chat may see. Try other words, a wider date range, or no filter.");
  });

  test("a fact he told in private is found by search on his turn there, marked and the turn's alone", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), { op: "add", section: "Vehicles", text: "The spare key of the BR-V is in the top drawer." });
    const search = createMemorySearchTool(h.memory);
    const own = await search.execute({ query: "spare key" }, ctx(GADING_HERE));
    expect(String(own.content)).toContain("- gading (theirs) · Vehicles: The spare key of the BR-V is in the top drawer.");
    expect(own.turnOnly).toBe(OWN_FOR_THE_TURN);
    expect((await search.execute({ query: "spare key" }, ctx(SAM_HERE))).content).toContain("Nothing found");
    // With the setting off, his own turn finds nothing either.
    h.config.memory.privateInGroups = false;
    expect((await search.execute({ query: "spare key" }, ctx(GADING_HERE))).content).toContain("Nothing found");
  });

  test("a document of his read there is the turn's alone; hers is refused as a document that is not there", async () => {
    const read = createMemoryReadTool(h.memory);
    const own = await read.execute({ document: ITEM }, ctx(GADING_HERE));
    expect(own.isError).toBe(false);
    expect(String(own.content)).toContain("Car (theirs) · Fuel code (fuel-code.md)");
    expect(String(own.content)).toContain("renewed every October");
    expect(own.turnOnly).toBe(OWN_FOR_THE_TURN);
    expect(await read.execute({ document: ITEM }, ctx(SAM_HERE))).toMatchObject({ isError: true, content: `no document "${ITEM}" that this chat may read` });
    expect((await read.execute({ document: "knowledge:family/rules.md#0" }, ctx(SAM_HERE))).turnOnly).toBeUndefined();
  });

  test("`send_file` hands his kept file to the group on his turn, and refuses on hers; a CLI's own call is refused", async () => {
    const sent: Attachment[] = [];
    const send = createSendFileTool({ send: async (_ctx, attachment) => (sent.push(attachment), { ids: ["m1"], delivered: true }), maxBytes: 1024 * 1024, documentFile: (toolCtx, item) => h.memory.knowledge.fileOf(speakerOf(toolCtx), item) });
    expect((await send.execute({ document: ITEM }, ctx(GADING_HERE))).isError).toBe(false);
    expect(sent.map((file) => file.filename)).toEqual(["fuel-code.md"]);
    expect(await send.execute({ document: ITEM }, ctx(SAM_HERE))).toMatchObject({ isError: true, content: `no document "${ITEM}" that this chat may read` });
    expect((await send.execute({ document: ITEM }, ctx(GADING_HERE, { lent: true }))).isError).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("an answer that somebody else's conversation keeps", () => {
  test("an agent asked by another, on his turn in the group, finds none of his own: its answer goes into the asker's conversation", async () => {
    const search = createMemorySearchTool(h.memory);
    const asked = await search.execute({ query: "subsidy" }, ctx(GADING_HERE, { askedBy: "nix" }));
    expect(asked.content).toContain("Nothing found");
    expect(asked.turnOnly).toBeUndefined();
    expect((await createMemoryReadTool(h.memory).execute({ document: ITEM }, ctx(GADING_HERE, { askedBy: "nix" }))).isError).toBe(true);
    // What the group reads is found as ever.
    expect(String((await search.execute({ query: "quiet" }, ctx(GADING_HERE, { askedBy: "nix" }))).content)).toContain("Family rules");
  });

  test("a helper started from the group reads as the group reads, though its own turn is built as a direct chat's", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), { op: "add", section: "Vehicles", text: "The spare key of the BR-V is in the top drawer." });
    const search = createMemorySearchTool(h.memory);
    // As the daemon hands a helper its calls: the group's chat, the one who spoke, a direct chat's kind, and where it reports.
    const helper = (reportsInto?: "dm" | "group") => ctx({ ...GADING_HERE, chatType: "dm" as const }, reportsInto ? { reportsInto } : {});
    const fromGroup = await search.execute({ query: "spare key" }, helper("group"));
    expect(fromGroup.content).toContain("Nothing found");
    expect((await search.execute({ query: "subsidy" }, helper("group"))).content).toContain("Nothing found");
    expect(String((await search.execute({ query: "quiet" }, helper("group"))).content)).toContain("Family rules");
    // Not told where it reports, it read his private fact from the group: what this is for.
    expect(String((await search.execute({ query: "spare key" }, helper())).content)).toContain("The spare key of the BR-V");
  });

  test("a helper started from his direct chat reads what that chat reads, as before", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), { op: "add", section: "Vehicles", text: "The spare key of the BR-V is in the top drawer." });
    const found = await createMemorySearchTool(h.memory).execute({ query: "spare key" }, ctx(GADING_DM, { reportsInto: "dm" }));
    expect(String(found.content)).toContain("gading · Vehicles: The spare key of the BR-V is in the top drawer.");
    expect(found.turnOnly).toBeUndefined();
  });
});

describe("in the prompt", () => {
  const HARNESS: HarnessFacts = { approvalRequired: [], approvalAvailable: true, maxToolIterations: 25, maxTurnDurationMs: 300_000, commands: ["/new"], truncates: true };
  const promptFor = (where: typeof GADING_DM, person: string): BuiltPrompt =>
    buildSystemPrompt({
      agent: fakeAgent({ persona: { identity: "# IDENTITY\n- Name: Nouva" } }),
      tools: [{ name: "memory_search", description: "search", parameters: { type: "object" } }],
      harness: HARNESS,
      gateway: "whatsapp",
      chatId: FAMILY.chatId,
      chatType: "group",
      sessionId: "ses_nouva:whatsapp:main:1203@g.us",
      model: "claude-sonnet-4-20250514",
      now: new Date(at(12)),
      timezone: TZ,
      recall: h.memory.recall(speaker(where))!,
      person: { name: person },
    });

  test("his turn is told which collections are his to search there; the cached blocks are the same for both, and her turn names none of his", () => {
    const asGading = promptFor(GADING_HERE, "Gading");
    const asSam = promptFor(SAM_HERE, "Kak Sam");
    expect(asSam.blocks).toEqual(asGading.blocks);
    expect(asGading.situation).toContain("Gading's own collections, which `memory_search`, `memory_read` and `send_file` reach on this turn because Gading is the one speaking:\n- Car: The car and its papers.\n");
    expect(asGading.situation).toContain("It is theirs, and the others here have not been told it.");
    expect(`${asSam.text}\n${asSam.situation}`).not.toContain("The car and its papers.");
  });

  test("the agent is told that a search in a group returns the speaker's own, marked, for that turn only", () => {
    expect(promptFor(GADING_HERE, "Gading").text).toContain("in a group, nothing from anyone's DM but what is the own of the person speaking, marked (theirs) and shown to you for that turn only.");
  });
});
