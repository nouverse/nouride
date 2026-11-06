/**
 * Work notes on disk (0.7.26, `modules/notes/`): a section per task, written whole, checked before it is kept, set aside
 * after two weeks untouched.
 *
 * The case they exist for: a four-hour audit in a WhatsApp group (2026-10-20) lost which documents were done, the rules
 * the person had set, and that Excel had to be closed first, to compaction and the trim. These hold that place.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { removePath } from "@nouride/runtime";
import { cleanBody, parseNotes, renderNotes } from "@/modules/notes/format.ts";
import { NotesRefused, NotesStore, STALE_AFTER_MS } from "@/modules/notes/store.ts";
import { notesTail, tailFor } from "@/modules/notes/tail.ts";
import { tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removePath(dir);
});

const MIRA = { agentId: "nouva", gatewayId: "whatsapp:nouva", chatId: "audit-group@g.us" };
const AUDIT = "Verify 52 documents in KK 1.1";
const BODY = "- Done: 1–30\n- Next: 31\n- Rules: certain fit → v; misfit → -\n- Facts: laptop 192.0.2.15 (user mira); close Excel before overwriting";

function store(now = () => 1_000_000) {
  const dir = tempDir("notes");
  dirs.push(dir);
  return { notes: new NotesStore(join(dir, "notes"), now), dir: join(dir, "notes") };
}

describe("the file", () => {
  test("a section per task, read back as written", () => {
    const tasks = [
      { title: AUDIT, body: BODY },
      { title: "Payment types", body: "- Next: LS / UP for each" },
    ];
    expect(parseNotes(renderNotes(tasks))).toEqual(tasks);
  });

  test("a heading inside a task's words would start a task of its own, so it becomes a smaller one", () => {
    expect(cleanBody("## Done\n# Next\n### Facts")).toBe("### Done\n### Next\n### Facts");
  });
});

describe("writing", () => {
  test("write creates a task and replaces it by its title — case and spacing do not make two", async () => {
    const { notes } = store();
    expect(await notes.write(MIRA, AUDIT, BODY)).toEqual({ created: true });
    expect(await notes.write(MIRA, "verify 52  documents in kk 1.1", "- Done: 1–40")).toEqual({ created: false });
    expect(notes.tasks(MIRA)).toEqual([{ title: AUDIT, body: "- Done: 1–40" }]);
  });

  test("remove takes one task out, and the plan kept with it", async () => {
    const { notes } = store();
    await notes.write(MIRA, AUDIT, BODY);
    await notes.write(MIRA, "Payment types", "- Next: LS / UP");
    await notes.keepPlan(MIRA, AUDIT, [{ text: "check 31–52", state: "active" }]);
    expect((await notes.remove(MIRA, AUDIT))?.title).toBe(AUDIT);
    expect(notes.tasks(MIRA).map((task) => task.title)).toEqual(["Payment types"]);
    expect(notes.plan(MIRA)).toBeUndefined();
    expect(await notes.remove(MIRA, "nothing of that name")).toBeNull();
  });

  test("past 8 KB a write is refused, with how to make room", async () => {
    const { notes } = store();
    await notes.write(MIRA, AUDIT, BODY);
    const refused = notes.write(MIRA, "Huge", "x".repeat(9_000));
    await expect(refused).rejects.toBeInstanceOf(NotesRefused);
    await expect(refused).rejects.toThrow(/condense what is finished/);
    expect(notes.tasks(MIRA)).toHaveLength(1);
  });

  test("a credential's value is refused — its name or handle is what goes in", async () => {
    const { notes } = store();
    await expect(notes.write(MIRA, "Deploy", "token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB")).rejects.toThrow(/credential/);
    await notes.write(MIRA, "Deploy", "- Facts: github_token is bound; the one sent in chat is $TMP_SECRET_0123456789ab");
    expect(notes.tasks(MIRA)).toHaveLength(1);
  });

  test("two chats are two files, even when their ids clean to the same name", async () => {
    const { notes } = store();
    await notes.write({ ...MIRA, chatId: "a:b" }, "One", "x");
    await notes.write({ ...MIRA, chatId: "a_b" }, "Two", "y");
    expect(notes.tasks({ ...MIRA, chatId: "a:b" }).map((task) => task.title)).toEqual(["One"]);
    expect(notes.tasks({ ...MIRA, chatId: "a_b" }).map((task) => task.title)).toEqual(["Two"]);
  });

  test("a person's edit of the whole file keeps when an unchanged task was written", async () => {
    let now = 1_000_000;
    const { notes } = store(() => now);
    await notes.write(MIRA, AUDIT, BODY);
    await notes.write(MIRA, "Payment types", "- Next: LS / UP");
    now += STALE_AFTER_MS - 1;
    // The person fixes a fact in one task; the other is not touched, and still goes stale on its own clock.
    await notes.replace(MIRA, renderNotes([{ title: AUDIT, body: `${BODY}\n- Facts: the file is on the D: drive` }, { title: "Payment types", body: "- Next: LS / UP" }]));
    now += 2;
    expect(await notes.sweep(now)).toBe(1);
    expect(notes.tasks(MIRA).map((task) => task.title)).toEqual([AUDIT]);
  });
});

describe("clearing and setting aside", () => {
  test("clear says how many tasks went, and keeps the file before a day", async () => {
    // The real clock: the copy's age is its file's.
    let now = Date.now();
    const { notes, dir } = store(() => now);
    await notes.write(MIRA, AUDIT, BODY);
    await notes.write(MIRA, "Payment types", "- Next");
    expect(await notes.clear(MIRA)).toBe(2);
    expect(notes.tasks(MIRA)).toEqual([]);
    expect(await notes.clear(MIRA)).toBe(0);
    const prev = `${notes.pathOf(MIRA).notes.replace(/\.md$/, "")}.prev.md`;
    expect(readFileSync(prev, "utf8")).toContain(AUDIT);
    now += 25 * 60 * 60_000;
    await notes.sweep(now);
    expect(existsSync(prev)).toBe(false);
    expect(dir).toBeTruthy();
  });

  test("a conversation deleted on purpose keeps no copy", async () => {
    const { notes } = store();
    await notes.write(MIRA, AUDIT, BODY);
    await notes.clear(MIRA);
    const prev = `${notes.pathOf(MIRA).notes.replace(/\.md$/, "")}.prev.md`;
    expect(existsSync(prev)).toBe(true);
    await notes.write(MIRA, AUDIT, BODY);
    expect(await notes.clear(MIRA, { keep: false })).toBe(1);
    expect(existsSync(prev)).toBe(false);
  });

  test("a task untouched two weeks is set aside to the archive, and the agent is told once", async () => {
    let now = 1_000_000;
    const { notes } = store(() => now);
    await notes.write(MIRA, AUDIT, BODY);
    now += STALE_AFTER_MS - 1;
    await notes.write(MIRA, "Payment types", "- Next");
    now += 2;
    expect(await notes.sweep(now)).toBe(1);
    expect(notes.tasks(MIRA).map((task) => task.title)).toEqual(["Payment types"]);
    expect(readFileSync(notes.pathOf(MIRA).archive, "utf8")).toContain(`## ${AUDIT} (set aside`);
    const tail = tailFor(notes, MIRA)!;
    expect(tail).toContain(`Set aside on`);
    expect(tail).toContain(notes.pathOf(MIRA).archive);
    await notes.acknowledge(MIRA);
    expect(tailFor(notes, MIRA)).not.toContain("Set aside");
  });
});

describe("what the model reads", () => {
  test("every task, with its plan under it — and nothing at all when there is nothing", async () => {
    const { notes } = store();
    expect(tailFor(notes, MIRA)).toBeUndefined();
    await notes.write(MIRA, AUDIT, BODY);
    await notes.keepPlan(MIRA, AUDIT, [
      { text: "copy the 52 rows", state: "done" },
      { text: "check 31–52", state: "active" },
      { text: "documents 5 and 7", state: "skipped", reason: "no physical document yet" },
    ]);
    const tail = tailFor(notes, MIRA)!;
    expect(tail).toStartWith("WORK NOTES");
    expect(tail).toContain(`## ${AUDIT}\n${BODY}\nPlan (2/3 done):`);
    expect(tail).toContain("2. [~] check 31–52");
    expect(tail).toContain("3. [-] documents 5 and 7 (skipped: no physical document yet)");
  });

  test("a plan for a task the notes do not have makes the task", async () => {
    const { notes } = store();
    await notes.keepPlan(MIRA, "Reorganise the sheet", [{ text: "sort", state: "pending" }]);
    expect(notes.tasks(MIRA)).toEqual([{ title: "Reorganise the sheet", body: "" }]);
    expect(notesTail({ tasks: notes.tasks(MIRA), plan: notes.plan(MIRA), archive: "x" })).toContain("1. [ ] sort");
  });
});
