/**
 * A person's own facts go with them: what they told an agent in a direct chat is read in a group on the turns they are
 * the one speaking, and on nobody else's.
 *
 * It was read in every direct chat with them and in no group, whoever spoke there: a person had an agent keep their
 * car's fuel code, asked for it in a family group a minute later, and the agent knew nothing of it. Driven here the
 * way the daemon drives it, from the memory service a turn asks, with the household of the other memory tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import type { BuiltPrompt, HarnessFacts } from "@/modules/llm/prompt/index.ts";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import { canSeeFact, followsItsPerson, type Audience } from "@/modules/memory/access.ts";
import type { Recall } from "@/modules/memory/index.ts";
import { factsOf } from "@/modules/memory/profile.ts";
import { createMemoryWriteTool, factReadWhere } from "@/modules/tools/builtins/memory.ts";
import { fakeAgent } from "../helpers.ts";
import { FAMILY, GADING_DM, SAM_DM, TZ, at, household, speaker, type Household } from "./fixture.ts";

const GADING_HERE = { ...FAMILY, senderId: "62811" };
const SAM_HERE = { ...FAMILY, senderId: "62877" };
/** A second group both of them are in, on another chat. */
const OFFICE = { ...FAMILY, chatId: "9900@g.us" };
const CODE = "Has a Honda BR-V, plate BG 1891 ZD; its fuel code is kept as a picture.";

let h: Household;

beforeEach(async () => {
  h = await household();
  // Both have spoken in the family group, so both are known to be in it.
  h.group(GADING_HERE, "Halo semua", at(9));
  h.group(SAM_HERE, "Halo juga", at(9, 5));
});

afterEach(() => h.close());

const said = (text: string, direct?: boolean) => ({ op: "add" as const, section: "Vehicles", text, ...(direct === undefined ? {} : { direct }) });
const own = (where: typeof GADING_DM) => h.memory.recall(speaker(where)).own;
const profileOf = async (key: string) => (await readTextFileIfExists(h.vault.person(key))) ?? "";

describe("the rule, by who is speaking", () => {
  const family: Audience = { kind: "group", chat: "whatsapp:main:1203@g.us", present: ["gading", "sam"] };
  const direct = { readers: { people: ["gading"] } };

  test("what was said in a direct chat is its person's on their own turn in a group, and nobody else's", () => {
    expect(followsItsPerson(direct, "gading", { ...family, speaker: "gading" })).toBe(true);
    expect(followsItsPerson(direct, "gading", { ...family, speaker: "sam" })).toBe(false);
    // No turn at all (the nightly pass, a list on the dashboard): nobody is speaking, so nothing is brought.
    expect(followsItsPerson(direct, "gading", family)).toBe(false);
    // A sender no person is known for is an id of the platform's, never a person's key.
    expect(followsItsPerson(direct, "gading", { ...family, speaker: "whatsapp:62899" })).toBe(false);
    // And what the group itself reads is not changed by who speaks: that block of the prompt is cached.
    expect(canSeeFact(direct, "gading", { ...family, speaker: "gading" })).toBe(false);
  });

  test("a fact kept to direct chats, one said in a conversation its person was not in, and a direct chat itself", () => {
    expect(followsItsPerson({ readers: { people: ["gading"], direct: true } }, "gading", { ...family, speaker: "gading" })).toBe(false);
    // Said about him in a chat he was not part of: his own direct chat does not read it, so it is not his to bring.
    expect(followsItsPerson({ readers: { people: ["sam"] } }, "gading", { ...family, speaker: "gading" })).toBe(false);
    expect(followsItsPerson(direct, "gading", { kind: "dm", chat: "telegram:nouva:814", person: "gading" })).toBe(false);
  });

  test("what the group reads anyway is never brought a second time", () => {
    const here = { readers: { people: ["gading", "sam"], chat: family.chat } };
    expect(canSeeFact(here, "gading", { ...family, speaker: "gading" })).toBe(true);
    expect(followsItsPerson(here, "gading", { ...family, speaker: "gading" })).toBe(false);
    // Written by hand, with no readers: read wherever he is present.
    expect(followsItsPerson({}, "gading", { ...family, speaker: "gading" })).toBe(false);
    // Said in another group he was in: this group does not read it, his direct chat does, so it goes with him.
    const elsewhere = { readers: { people: ["gading", "raka"], chat: "whatsapp:main:9900@g.us" } };
    expect(followsItsPerson(elsewhere, "gading", { ...family, speaker: "gading" })).toBe(true);
  });
});

describe("through the memory service, as a turn asks it", () => {
  test("told in his direct chat, asked for in the family group: his turn holds it, hers does not", async () => {
    const written = await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));
    expect(written).toEqual({ status: "written", reach: { said: "direct", directOnly: false, follows: true } });

    expect(own(GADING_HERE)).toEqual({ name: "Gading", facts: [{ section: "Vehicles", text: CODE }] });
    expect(own(SAM_HERE)).toBeUndefined();
    // What the group reads is the same for both: nothing of it, since it was not said there.
    const { own: _his, ...asGading } = h.memory.recall(speaker(GADING_HERE));
    expect(h.memory.recall(speaker(SAM_HERE))).toEqual(asGading);
    expect(JSON.stringify(asGading)).not.toContain("BR-V");
    // Her direct chat, and an agent of hers, never.
    expect(JSON.stringify(h.memory.recall(speaker(SAM_DM, "nix")))).not.toContain("BR-V");
    // And his own direct chat reads it as before, with any agent, as a fact of his profile and not as something brought.
    expect(h.memory.recall(speaker(GADING_DM, "nix")).profiles).toEqual([{ name: "Gading", facts: [{ section: "Vehicles", text: CODE }] }]);
    expect(own(GADING_DM)).toBeUndefined();
  });

  test("a sender the install does not know brings nothing, whatever name they give", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));
    expect(own({ ...FAMILY, senderId: "62899" })).toBeUndefined();
  });

  test("`[memory] private_in_groups` off: a group reads only what was said in it, and the answer says so", async () => {
    h.config.memory.privateInGroups = false;
    const written = await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));
    expect(written).toMatchObject({ reach: { said: "direct", directOnly: false, follows: false } });
    expect(own(GADING_HERE)).toBeUndefined();

    // Read live: switched on, the fact that was there all along goes with him.
    h.config.memory.privateInGroups = true;
    expect(own(GADING_HERE)?.facts).toEqual([{ section: "Vehicles", text: CODE }]);
  });

  test("a person whose facts are left out of prompts brings none either", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));
    h.config.people.find((person) => person.key === "gading")!.recall = false;
    expect(own(GADING_HERE)).toBeUndefined();
  });

  test("a fact said in the group is the group's, shown once; in another group it goes with him", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_HERE), said("Drives the family to school on Fridays."));
    const here = h.memory.recall(speaker(GADING_HERE));
    expect(here.profiles).toEqual([{ name: "Gading", facts: [{ section: "Vehicles", text: "Drives the family to school on Fridays." }] }]);
    expect(here.own).toBeUndefined();
    expect(h.memory.recall(speaker(SAM_HERE)).profiles).toEqual(here.profiles);

    h.group({ ...OFFICE, senderId: "62811" }, "Pagi", at(10));
    expect(own({ ...OFFICE, senderId: "62811" })?.facts).toEqual([{ section: "Vehicles", text: "Drives the family to school on Fridays." }]);
    expect(h.memory.recall(speaker({ ...OFFICE, senderId: "62811" })).profiles).toEqual([]);
  });
});

describe("a fact kept to direct chats", () => {
  test("is written so on its line, read in his direct chats, and not brought into a group", async () => {
    const written = await h.memory.noteAboutSpeaker(speaker(GADING_DM), said("Is planning a surprise for Sam's birthday.", true));
    expect(written).toEqual({ status: "written", reach: { said: "direct", directOnly: true, follows: false } });
    expect(await profileOf("gading")).toContain("- Is planning a surprise for Sam's birthday. {gading, direct only}");
    expect(factsOf(await profileOf("gading"))[0]!.readers).toEqual({ people: ["gading"], direct: true });

    expect(own(GADING_HERE)).toBeUndefined();
    expect(h.memory.recall(speaker(GADING_DM)).profiles[0]!.facts).toEqual([{ section: "Vehicles", text: "Is planning a surprise for Sam's birthday." }]);
  });

  test("an old line with no mark is not kept to direct chats, and the mark is never taken for a person", async () => {
    await writeTextFile(h.vault.person("gading"), "---\ntype: person\nname: Gading\n---\n\n## Vehicles\n- An old line. {gading}\n- A kept line. {gading, direct only}\n");
    const [old, kept] = factsOf(await profileOf("gading"));
    expect(old!.readers).toEqual({ people: ["gading"] });
    expect(kept!.readers).toEqual({ people: ["gading"], direct: true });
  });

  test("asked for afterwards, by the fact's own words; a correction keeps it; false lifts it", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));
    expect(own(GADING_HERE)).toBeDefined();

    const kept = await h.memory.noteAboutSpeaker(speaker(GADING_DM), { op: "update", current: CODE, text: CODE, direct: true });
    expect(kept).toMatchObject({ status: "written", reach: { directOnly: true, follows: false } });
    expect(own(GADING_HERE)).toBeUndefined();

    // A correction that says nothing of it leaves the fact kept as it was.
    const corrected = await h.memory.noteAboutSpeaker(speaker(GADING_DM), { op: "update", current: CODE, text: "Has a Honda BR-V, plate BG 1 XX." });
    expect(corrected).toMatchObject({ reach: { directOnly: true } });
    expect(await profileOf("gading")).toContain("- Has a Honda BR-V, plate BG 1 XX. {gading, direct only}");
    expect(own(GADING_HERE)).toBeUndefined();

    const lifted = await h.memory.noteAboutSpeaker(speaker(GADING_DM), { op: "update", current: "Has a Honda BR-V, plate BG 1 XX.", text: "Has a Honda BR-V, plate BG 1 XX.", direct: false });
    expect(lifted).toMatchObject({ reach: { directOnly: false, follows: true } });
    expect(own(GADING_HERE)?.facts).toEqual([{ section: "Vehicles", text: "Has a Honda BR-V, plate BG 1 XX." }]);
  });

  test("is not asked for in a group: what is said there the group has read", async () => {
    const refused = await h.memory.noteAboutSpeaker(speaker(GADING_HERE), said("Something said in front of everyone.", true));
    expect(refused).toMatchObject({ refused: expect.stringContaining("said in a group") });
    expect(await profileOf("gading")).toBe("");
  });
});

describe("changing what he brought, from the group", () => {
  test("on his own turn it is his to correct or drop; on hers there is no such fact", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));

    expect(await h.memory.noteAboutSpeaker(speaker(SAM_HERE), { op: "remove", current: CODE })).toMatchObject({ refused: expect.stringContaining("No fact reading") });
    expect(await profileOf("gading")).toContain(CODE);

    // Corrected in front of the group, it is the group's from then on: they have just read it.
    const corrected = await h.memory.noteAboutSpeaker(speaker(GADING_HERE), { op: "update", current: CODE, text: "Has a Honda BR-V, plate BG 2 YY." });
    expect(corrected).toMatchObject({ status: "written", reach: { said: "group" } });
    expect(await profileOf("gading")).toContain("- Has a Honda BR-V, plate BG 2 YY. {gading, sam, in whatsapp:main:1203@g.us}");
  });

  test("with the setting off, the group cannot touch what it does not read, whoever speaks", async () => {
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));
    h.config.memory.privateInGroups = false;
    expect(await h.memory.noteAboutSpeaker(speaker(GADING_HERE), { op: "remove", current: CODE })).toMatchObject({ refused: expect.stringContaining("No fact reading") });
  });
});

describe("in the prompt", () => {
  const HARNESS: HarnessFacts = { approvalRequired: [], approvalAvailable: true, maxToolIterations: 25, maxTurnDurationMs: 300_000, commands: ["/new"], truncates: true };
  const promptFor = (recall: Recall, person: string): BuiltPrompt =>
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
      recall,
      person: { name: person },
    });

  test("his turn is told what he brought, with whose it is and what to do with it; her turn holds no word of it", async () => {
    await h.memory.noteAboutSpeaker(speaker(SAM_HERE), { op: "add", section: "Hobbies", text: "Takes piano lessons." });
    await h.memory.noteAboutSpeaker(speaker(GADING_DM), said(CODE));

    const asGading = promptFor(h.memory.recall(speaker(GADING_HERE)), "Gading");
    const asSam = promptFor(h.memory.recall(speaker(SAM_HERE)), "Kak Sam");

    // Every block of the system prompt, the cached recall among them, is the same bytes for both.
    expect(asSam.blocks).toEqual(asGading.blocks);
    expect(asGading.blocks.some((block) => block.text.includes("Takes piano lessons."))).toBe(true);
    expect(asGading.blocks.some((block) => block.text.includes("BR-V"))).toBe(false);

    // What he brought is said with who is speaking, after the conversation, and built again on every turn.
    expect(asGading.situation).toContain("You are talking to Gading.");
    expect(asGading.situation).toContain(`What Gading told you outside this group, shown to you because Gading is the one speaking now:\nVehicles:\n- ${CODE}`);
    expect(asGading.situation).toContain("It is theirs, and the others here have not been told it.");
    expect(asGading.situation).toContain("Use what this message of theirs needs, and leave the rest unsaid.");
    expect(asGading.situation).toContain("On anyone else's turn you are not shown it: never tell it to them, and if they ask for it, say it is Gading's to ask for.");

    expect(asSam.situation).toContain("You are talking to Kak Sam.");
    expect(`${asSam.text}\n${asSam.situation}`).not.toContain("BR-V");
    expect(asSam.situation).not.toContain("outside this group");
  });

  test("the agent is told that what was said in private is its person's alone", () => {
    const prompt = promptFor(h.memory.recall(speaker(GADING_HERE)), "Gading");
    expect(prompt.text).toContain("In a group, what someone told you in private is theirs alone: say it only to them, on a turn of their own, when their message needs it.");
  });
});

describe("what the tool tells the agent, for it to say", () => {
  const toolCtx = (where: typeof GADING_DM) => ({ agentId: "nouva", agentDir: join(h.dir, "agents", "nouva"), sessionId: "s", signal: new AbortController().signal, ...where }) as never;
  const write = () => createMemoryWriteTool(h.memory);

  test("where a fact is read, by where it was said and how the install is set", () => {
    expect(factReadWhere({ said: "direct", directOnly: false, follows: true })).toBe("It is theirs: read on any turn they are the one speaking, in a direct chat or a group, with any agent, and on nobody else's turn.");
    expect(factReadWhere({ said: "direct", directOnly: false, follows: false })).toBe("It is read in their direct chats, with any agent, and in no group: this install keeps what is said in private out of groups.");
    expect(factReadWhere({ said: "direct", directOnly: true, follows: false })).toBe("It is kept to their direct chats, with any agent: not read in a group, even on a turn they are the one speaking.");
    expect(factReadWhere({ said: "group", directOnly: false, follows: true })).toBe("It is read in this group and in the direct chats of the people in it, and wherever its person is the one speaking.");
    expect(factReadWhere({ said: "group", directOnly: false, follows: false })).toBe("It is read in this group and in the direct chats of the people in it.");
  });

  test("a fact kept from a direct chat says it is its person's wherever they speak, and never this one chat's", async () => {
    const result = await write().execute({ about: "person", section: "Vehicles", content: CODE }, toolCtx(GADING_DM));
    expect(result).toMatchObject({ isError: false, content: "Kept in their profile. It is theirs: read on any turn they are the one speaking, in a direct chat or a group, with any agent, and on nobody else's turn." });
    expect(String(result.content)).not.toContain("only in this chat");
  });

  test("`only_direct` keeps it to direct chats, is a yes or a no, and is refused in a group", async () => {
    const kept = await write().execute({ about: "person", section: "Plans", content: "Is planning a surprise for Sam.", only_direct: true }, toolCtx(GADING_DM));
    expect(kept).toMatchObject({ isError: false, content: expect.stringContaining("It is kept to their direct chats") });
    expect(own(GADING_HERE)).toBeUndefined();

    expect(await write().execute({ about: "person", content: "Another one.", only_direct: "yes" }, toolCtx(GADING_DM))).toMatchObject({ isError: true, content: "`only_direct` must be true or false." });
    expect(await write().execute({ about: "person", content: "Said to everyone.", only_direct: true }, toolCtx(GADING_HERE))).toMatchObject({ isError: true, content: expect.stringContaining("said in a group") });
  });

  test("its own MEMORY.md: every chat reads it, whoever is speaking", async () => {
    const result = await createMemoryWriteTool().execute({ mode: "append", content: "## Conventions\n\n- Answer in the language asked in." }, toolCtx(GADING_DM));
    expect(result).toMatchObject({ isError: false, content: expect.stringContaining("It is your own file: every chat you are in reads it from its next turn, whoever is speaking there.") });
  });
});
