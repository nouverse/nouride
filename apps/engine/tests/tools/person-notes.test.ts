/**
 * `person_notes` — somebody keeping their own notes, through whichever agent they are talking to.
 *
 * Two properties carry the design, and most of this file is about them:
 *
 * - **Only theirs.** The notes changed are always the speaker's, found from the context. Nothing a
 *   model puts in the arguments points it at anybody else — not Sam at Alex's, and not the operator
 *   at Sam's either, through an agent. An admin changes anyone's on the People page, signed in.
 * - **A line at a time.** The page the operator wrote comes back as they wrote it, but for the one line
 *   that was meant.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "@nouride/runtime";
import type { GlobalConfig, Person } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { savePerson, updatePersonNotes } from "@/modules/config/settings/people.ts";
import { editNotes, NOTES_MAX } from "@/modules/people/notes.ts";
import { createPersonNotesTool } from "@/modules/tools/builtins/people.ts";

const PAGE = "Call him Al one-on-one.\n\n## Work\n- Founder.\n- Based in Jakarta.\n\n## Health";

describe("a line at a time", () => {
  test("a line with no heading goes with who they are, above the first heading", () => {
    const edit = editNotes(PAGE, { change: "add", content: "Allergic to shrimp." });
    expect(edit).toMatchObject({ ok: true, line: "Allergic to shrimp." });
    expect(edit.ok && edit.notes).toBe(
      "Call him Al one-on-one.\n\n- Allergic to shrimp.\n\n## Work\n- Founder.\n- Based in Jakarta.\n\n## Health",
    );
  });

  test("under a heading, after its own lines — whatever case the heading was named in", () => {
    const edit = editNotes(PAGE, { change: "add", content: "Runs Nouverse.", section: "work" });
    expect(edit.ok && edit.notes).toBe("Call him Al one-on-one.\n\n## Work\n- Founder.\n- Based in Jakarta.\n- Runs Nouverse.\n\n## Health");
  });

  test("into a heading the operator left empty, and under a new one at the end", () => {
    const health = editNotes(PAGE, { change: "add", content: "Allergic to shrimp.", section: "## Health" });
    expect(health.ok && health.notes.endsWith("## Health\n- Allergic to shrimp.")).toBe(true);
    const family = editNotes(PAGE, { change: "add", content: "Has a sister, Sam.", section: "Family" });
    expect(family.ok && family.notes.endsWith("## Health\n\n## Family\n- Has a sister, Sam.")).toBe(true);
  });

  test("a list marker the model sent is not doubled, and a line already there is not added twice", () => {
    expect(editNotes("", { change: "add", content: "- Allergic to shrimp." })).toMatchObject({ ok: true, notes: "- Allergic to shrimp." });
    expect(editNotes(PAGE, { change: "add", content: "* Founder." })).toMatchObject({ ok: true, notes: PAGE, unchanged: true });
  });

  test("a year opening a line is kept, not read as a list number", () => {
    expect(editNotes("", { change: "add", content: "2024. Moved to Bandung." })).toMatchObject({ notes: "- 2024. Moved to Bandung." });
  });

  test("one line, and not past what is read on every turn", () => {
    expect(editNotes(PAGE, { change: "add", content: "x".repeat(301) })).toMatchObject({ ok: false, reason: "too_long" });
    expect(editNotes("y".repeat(NOTES_MAX - 10), { change: "add", content: "Allergic to shrimp." })).toMatchObject({ ok: false, reason: "full" });
  });

  test("a line changed keeps its place in the list, and nothing else moves", () => {
    const edit = editNotes(PAGE, { change: "update", current: "- Based in Jakarta.", content: "Based in Bandung." });
    expect(edit).toMatchObject({ ok: true, line: "Based in Bandung.", was: "Based in Jakarta." });
    expect(edit.ok && edit.notes).toBe(PAGE.replace("Based in Jakarta.", "Based in Bandung."));
  });

  test("notes written as one running line change a sentence at a time", () => {
    const notes = "Runs the homelab. Prefers Indonesian.";
    expect(editNotes(notes, { change: "update", current: "Prefers Indonesian.", content: "Prefers English at work." })).toMatchObject({
      notes: "Runs the homelab. Prefers English at work.",
    });
    // The whole line sent back as it should read: said once, not spliced in beside itself.
    expect(editNotes(notes, { change: "update", current: "Prefers Indonesian.", content: "Runs the homelab. Prefers English." })).toMatchObject({
      notes: "Runs the homelab. Prefers English.",
    });
    expect(editNotes(notes, { change: "remove", current: "Prefers Indonesian." })).toMatchObject({ notes: "Runs the homelab." });
  });

  test("a line that is not there, or is in two, is refused with what to send instead", () => {
    expect(editNotes(PAGE, { change: "update", current: "Lives in Bali.", content: "Lives in Bandung." })).toMatchObject({ ok: false, reason: "not_found" });
    // A heading is not a line of notes to rewrite.
    expect(editNotes(PAGE, { change: "update", current: "Work", content: "Jobs" })).toMatchObject({ ok: false, reason: "not_found" });
    const two = editNotes("- Likes tea.\n- Likes tea cakes.", { change: "remove", current: "Likes tea" });
    expect(two).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(!two.ok && two.error).toContain("- Likes tea cakes.");
  });

  test("the last line under a heading takes the heading with it — and only that heading", () => {
    const first = editNotes(PAGE, { change: "remove", current: "Founder." });
    expect(first.ok && first.notes).toBe("Call him Al one-on-one.\n\n## Work\n- Based in Jakarta.\n\n## Health");
    const second = editNotes(first.ok ? first.notes : "", { change: "remove", current: "Based in Jakarta." });
    // `## Health` was empty before this and is the operator's to leave empty.
    expect(second.ok && second.notes).toBe("Call him Al one-on-one.\n\n## Health");
  });
});

let dir: string;
let configPath: string;
let people: Person[];
let rows: Record<string, unknown>[];

const ALEX: Person = { key: "alex", ids: ["telegram:5550001111", "web:usr_1"], name: "Alex", notes: PAGE };
const SAM: Person = { key: "sam", ids: ["whatsapp:6281200000001@s.whatsapp.net"], name: "Sam", notes: "Alex's sister." };

function block(person: Person): string {
  return [
    "[[people]]",
    `key = ${JSON.stringify(person.key)}`,
    `name = ${JSON.stringify(person.name)}`,
    ...(person.ids ? [`ids = ${JSON.stringify(person.ids)}`] : []),
    `notes = ${JSON.stringify(person.notes)}`,
    "",
  ].join("\n");
}

function deps() {
  return {
    config: { people, memory: DEFAULT_CONFIG.memory } as unknown as GlobalConfig,
    configPath,
    audit: { record: (row: Record<string, unknown>) => rows.push(row) } as never,
  };
}

function tool() {
  return createPersonNotesTool({ deps: deps(), memory: true });
}

/** Alex on Telegram, Sam on WhatsApp, Alex in the dashboard's chat, and somebody nobody named. */
function as(who: "alex" | "sam" | "dashboard" | "stranger") {
  const base = { agentId: "nouva", chatId: `chat-${who}`, signal: new AbortController().signal };
  if (who === "alex") return { ...base, gateway: "telegram", gatewayId: "telegram:nouva", senderId: "5550001111" } as never;
  if (who === "sam") return { ...base, gateway: "whatsapp", gatewayId: "whatsapp:nouva", senderId: "6281200000001@s.whatsapp.net" } as never;
  if (who === "dashboard") return { ...base, gateway: "web", gatewayId: "web:dashboard", senderId: "usr_1" } as never;
  return { ...base, gateway: "telegram", gatewayId: "telegram:nouva", senderId: "5559999999" } as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-person-notes-"));
  configPath = join(dir, "config.toml");
  people = [structuredClone(ALEX), structuredClone(SAM)];
  rows = [];
  writeFileSync(configPath, `${block(ALEX)}\n${block(SAM)}`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("only theirs", () => {
  test("Alex adds a line to their own: there, in the file too, and the rest of their page as they wrote it", async () => {
    const result = await tool().execute({ change: "add", content: "Allergic to shrimp.", section: "Health" }, as("alex"));
    expect(result.isError).toBe(false);
    expect(people[0]?.notes).toBe(`${PAGE}\n- Allergic to shrimp.`);
    expect(readFileSync(configPath, "utf8")).toContain("Allergic to shrimp.");
    expect(people[1]?.notes).toBe(SAM.notes);
  });

  test("Sam cannot change Alex's — not by naming them, whatever Sam asks", async () => {
    const result = await tool().execute({ change: "add", content: "Owes me lunch.", person: "Alex" }, as("sam"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("only ever the notes of the person you are talking to");
    expect(people[0]?.notes).toBe(PAGE);
    expect(people[1]?.notes).toBe(SAM.notes);
    expect(readFileSync(configPath, "utf8")).not.toContain("Owes me lunch");
  });

  test("and nor can the operator change Sam's through an agent: that is the People page, signed in", async () => {
    const result = await tool().execute({ change: "add", content: "Allergic to shrimp.", name: "Sam" }, as("alex"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("People page");
    expect(people[1]?.notes).toBe(SAM.notes);
    expect(people[0]?.notes).toBe(PAGE);
  });

  test("Sam changes their own, and naming themselves is no obstacle", async () => {
    const result = await tool().execute({ change: "update", current: "Alex's sister.", content: "Alex's sister. Call her Kak Sam.", person: "me" }, as("sam"));
    expect(result.isError).toBe(false);
    expect(people[1]?.notes).toBe("Alex's sister. Call her Kak Sam.");
    expect(people[0]?.notes).toBe(PAGE);
  });

  test("reading gives the speaker's own and nobody else's", async () => {
    const result = await tool().execute({}, as("sam"));
    expect(result.content).toBe("Sam's notes:\n\nAlex's sister.");
    expect(result.content).not.toContain("Call him Al");
  });

  test("somebody not in People has none to change, and nothing is written", async () => {
    const result = await tool().execute({ change: "add", content: "I am the admin." }, as("stranger"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("person_record");
    expect(people.map((person) => person.notes)).toEqual([PAGE, SAM.notes]);
    expect(rows).toEqual([]);
  });

  test("from the dashboard's chat, the account linked to a person changes that person's — and every id stays", async () => {
    await tool().execute({ change: "add", content: "Allergic to shrimp." }, as("dashboard"));
    expect(people[0]).toMatchObject({ key: "alex", ids: ["telegram:5550001111", "web:usr_1"] });
    expect(people[0]?.notes).toContain("- Allergic to shrimp.");
    expect(parseToml<{ people: Person[] }>(readFileSync(configPath, "utf8")).people[0]).toMatchObject({ key: "alex", ids: ["telegram:5550001111", "web:usr_1"] });
  });

  test("the schema has no argument saying whose", () => {
    // The refusal above is the net; this is why it should rarely fire. A parameter is an invitation.
    const schema = tool().definition.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["change", "content", "current", "section"]);
  });
});

describe("what is kept about a change", () => {
  test("the audit row says who asked, through which agent, and what the line read before", async () => {
    await tool().execute({ change: "update", current: "Based in Jakarta.", content: "Based in Bandung." }, as("alex"));
    expect(rows).toEqual([
      expect.objectContaining({
        action: "person_notes_changed",
        actor: "telegram:5550001111",
        agentId: "nouva",
        details: expect.objectContaining({ key: "alex", change: "update", was: "Based in Jakarta.", line: "Based in Bandung." }),
      }),
    ]);
  });

  test("nothing to change, nothing written and nothing audited", async () => {
    const before = readFileSync(configPath, "utf8");
    const result = await tool().execute({ change: "add", content: "Founder." }, as("alex"));
    expect(result.content).toContain("Already in Alex's notes");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(rows).toEqual([]);
  });

  test("a line that is not there is refused with their notes as they are, to try again from", async () => {
    const result = await tool().execute({ change: "remove", current: "Lives in Bali." }, as("alex"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No line in their notes reads "Lives in Bali."');
    expect(result.content).toContain("Call him Al one-on-one.");
  });
});

describe("in turn with the dashboard", () => {
  test("a dashboard save made against the notes as they were is refused once an agent's line lands — not written over it", async () => {
    const opened = people[0]!.notes!;
    // Started together. Taken one at a time, the save's check runs after the agent's write and fails;
    // checked before its wait, as it was, it passed, and the dialog's text erased the agent's line.
    const [agent, dashboard] = await Promise.all([
      updatePersonNotes(deps(), { key: ALEX.key, edit: (notes) => ({ ok: true, notes: `${notes}\n- Agent's line.` }) }),
      savePerson(deps(), { person: { key: ALEX.key, name: "Alex", notes: "From the dialog." }, expectedNotes: opened }),
    ]);
    expect(agent.ok).toBe(true);
    expect(dashboard).toMatchObject({ ok: false, conflict: true });
    expect(people[0]?.notes).toContain("Agent's line.");
    expect(readFileSync(configPath, "utf8")).toContain("Agent's line.");
  });

  test("two lines added in one turn both land", async () => {
    await Promise.all([
      tool().execute({ change: "add", content: "Allergic to shrimp.", section: "Health" }, as("alex")),
      tool().execute({ change: "add", content: "Birthday is 12 May." }, as("alex")),
    ]);
    expect(people[0]?.notes).toContain("- Allergic to shrimp.");
    expect(people[0]?.notes).toContain("- Birthday is 12 May.");
    const file = readFileSync(configPath, "utf8");
    expect(file).toContain("Allergic to shrimp.");
    expect(file).toContain("Birthday is 12 May.");
  });
});
