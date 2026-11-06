/**
 * `notes`, the tool (0.7.26): a section per task through three actions, refusals said as the model can act on them, and
 * a helper or a peer turned away — the conversation's own agent is the one writer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { childSessionId, sessionIdFor, type ToolContext } from "@nouride/shared";
import { NotesStore } from "@/modules/notes/store.ts";
import { workNotesCopy } from "@/modules/notes/tail.ts";
import { createNotesTool } from "@/modules/tools/builtins/notes.ts";
import { tempDir } from "../helpers.ts";

const WHO = { agentId: "nouva", gatewayId: "whatsapp:nouva", chatId: "group-1" };
const ctx = (sessionId = sessionIdFor(WHO)) => ({ ...WHO, sessionId, gateway: "whatsapp", senderId: "u" }) as ToolContext;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removePath(dir);
});

function made() {
  const dir = tempDir("notes-tool");
  dirs.push(dir);
  const notes = new NotesStore(join(dir, "notes"));
  return { notes, tool: createNotesTool(notes) };
}

describe("notes", () => {
  test("write, view, remove — and what is not there is named", async () => {
    const { tool } = made();
    expect((await tool.execute({ action: "view" }, ctx())).content).toBe("No work notes in this conversation yet.");
    expect((await tool.execute({ action: "write", title: "Audit", body: "- Next: 31" }, ctx())).content).toBe('Noted "Audit".');
    expect((await tool.execute({ action: "write", title: "Audit", body: "- Next: 32" }, ctx())).content).toBe('Updated "Audit".');
    expect((await tool.execute({ action: "view" }, ctx())).content).toContain("## Audit\n- Next: 32");
    const missing = await tool.execute({ action: "remove", title: "Payments" }, ctx());
    expect(missing).toMatchObject({ isError: true, content: 'No task "Payments" in the notes. There is "Audit".' });
    expect((await tool.execute({ action: "remove", title: "audit" }, ctx())).content).toBe('Removed "Audit".');
  });

  test("a refusal from the store is the model's to act on, not a crash", async () => {
    const { tool } = made();
    const result = await tool.execute({ action: "write", title: "Deploy", body: "AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("never its value");
  });

  test("one piece of work is one task: said once a third is written, not when one is updated", async () => {
    const { tool } = made();
    expect(tool.definition.description).toContain("never in a new task per status, step or hour");
    const write = async (title: string) => (await tool.execute({ action: "write", title, body: "- Next: x" }, ctx())).content;
    expect(await write("Audit KK 1.1a")).toBe('Noted "Audit KK 1.1a".');
    expect(await write("OCR 52 PDF")).toBe('Noted "OCR 52 PDF".');
    const third = await write("STATUS 23:15 (latest)");
    expect(third).toContain('3 tasks in the notes now: "Audit KK 1.1a", "OCR 52 PDF", "STATUS 23:15 (latest)"');
    expect(third).toContain("its progress goes in its own section, under the same title");
    expect(await write("OCR 52 PDF")).toBe('Updated "OCR 52 PDF".');
  });

  test("past the size, each task's share is said with what to do", async () => {
    const { tool } = made();
    for (const title of ["Plan", "STATUS 23:15", "STATUS 00:30"]) {
      await tool.execute({ action: "write", title, body: `- Done: ${"page ".repeat(500)}` }, ctx());
    }
    const refused = await tool.execute({ action: "write", title: "STATUS 00:55", body: `- Done: ${"page ".repeat(500)}` }, ctx());
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/they hold 8192 \("Plan" 2KB, "STATUS 23:15" 2KB, "STATUS 00:30" 2KB, "STATUS 00:55" 2KB\)\./);
    expect(refused.content).toContain("merge the sections that are one");
  });

  test("a helper's turn is turned away — it says what to keep in its answer", async () => {
    const { tool, notes } = made();
    const result = await tool.execute({ action: "write", title: "Audit", body: "x" }, ctx(childSessionId(sessionIdFor(WHO), "sub")));
    expect(result).toMatchObject({ isError: true });
    expect(notes.tasks(WHO)).toEqual([]);
  });
});

describe("what a helper or a peer is handed", () => {
  test("the task the plan is kept with — not the group's other tasks", async () => {
    const { notes } = made();
    await notes.write(WHO, "Audit", "- Next: 31");
    await notes.write(WHO, "Mira's private errand", "- not for a helper");
    await notes.keepPlan(WHO, "Audit", [{ text: "check 31–52", state: "active" }]);
    const copy = workNotesCopy(notes, WHO)!;
    expect(copy).toContain("## Audit\n- Next: 31\nPlan (0/1 done):");
    expect(copy).not.toContain("private errand");
  });

  test("with no plan, the task written last; with no notes, nothing", async () => {
    const { notes } = made();
    expect(workNotesCopy(notes, WHO)).toBeUndefined();
    await notes.write(WHO, "First", "a");
    await notes.write(WHO, "Second", "b");
    expect(workNotesCopy(notes, WHO)).toContain("## Second");
  });
});
