/**
 * A plan the model can hold across tool iterations — and, since 0.7.26, across turns, kept with a task in the work notes.
 *
 * The failure it exists for is quiet: on a turn of many steps, the model's only record of the plan is
 * the conversation, which is the first thing truncation eats. So it repeats a step, or skips one, or
 * says it is finished having done half — and on infrastructure work "drain, roll, verify, uncordon"
 * with the last step missing is worse than not starting.
 *
 * The tests are mostly refusals, because a plan tool that accepts an incoherent plan is a plan tool
 * that hides the thing it was added to catch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { childSessionId, sessionIdFor, type ToolContext } from "@nouride/shared";
import { NotesStore } from "@/modules/notes/store.ts";
import { createPlanTool, planTool, settleNotes } from "@/modules/tools/builtins/plan.ts";
import { tempDir } from "../helpers.ts";

const WHO = { agentId: "nouva", gatewayId: "web:dashboard", chatId: "c1" };

function ctx(chatId = "c1", sessionId = sessionIdFor({ ...WHO, chatId })): ToolContext {
  return { ...WHO, chatId, sessionId, gateway: "web", senderId: "u" } as ToolContext;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removePath(dir);
});

function kept() {
  const dir = tempDir("plan-notes");
  dirs.push(dir);
  const notes = new NotesStore(join(dir, "notes"));
  return { notes, tool: createPlanTool(notes) };
}

describe("plan", () => {
  test("accepts bare strings and renders the list back", async () => {
    // Rendered back on every call so the model is never asked to remember what it wrote — which is
    // the entire reason for keeping the plan outside the model.
    const result = await planTool.execute(
      { steps: ["drain the node", "roll the deployment", "verify"] },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("0/3 done");
    expect(result.content).toContain("1. [ ] drain the node");
  });

  test("tracks state and counts what is done", async () => {
    const result = await planTool.execute(
      {
        steps: [
          { text: "drain", state: "done" },
          { text: "roll", state: "active" },
          { text: "verify", state: "pending" },
        ],
      },
      ctx(),
    );

    expect(result.content).toContain("1/3 done");
    expect(result.content).toContain("[x] drain");
    expect(result.content).toContain("[~] roll");
    expect(result.metadata).toMatchObject({ count: 3, done: 1 });
  });

  test("refuses two active steps", async () => {
    // Not tidiness. Two active steps means the model has lost track of where it is, and that is the
    // failure this tool exists to surface rather than smooth over.
    const result = await planTool.execute(
      { steps: [{ text: "a", state: "active" }, { text: "b", state: "active" }] },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("one step");
  });

  test("refuses a plan longer than a plan", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `step ${i}`);
    const result = await planTool.execute({ steps: many }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Group the small ones");
  });

  test("refuses malformed entries by name", async () => {
    expect(await planTool.execute({ steps: "not an array" }, ctx())).toMatchObject({
      isError: true,
    });
    expect(await planTool.execute({ steps: [{ text: "" }] }, ctx())).toMatchObject({
      isError: true,
    });
    expect(
      await planTool.execute({ steps: [{ text: "a", state: "maybe" }] }, ctx()),
    ).toMatchObject({ isError: true });
  });

  test("an empty plan is allowed and says so", async () => {
    // Clearing the plan is a legitimate move: work turned out to be one step after all.
    const result = await planTool.execute({ steps: [] }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("empty");
  });

  test("long text is clipped rather than refused", async () => {
    // A too-long step is still a step. Refusing it would cost the model an iteration to rephrase
    // something that reads fine truncated.
    const { notes, tool } = kept();
    const result = await tool.execute({ steps: ["x".repeat(500)] }, ctx());
    expect(result.isError).toBe(false);
    expect(notes.plan(WHO)?.steps[0]?.text.length).toBe(200);
  });

  test("a skipped step says why, and is shown with it", async () => {
    expect(await planTool.execute({ steps: [{ text: "documents 5 and 7", state: "skipped" }] }, ctx())).toMatchObject({ isError: true });
    const result = await planTool.execute({ steps: [{ text: "documents 5 and 7", state: "skipped", reason: "no physical document yet" }] }, ctx());
    expect(result.content).toContain("[-] documents 5 and 7 (skipped: no physical document yet)");
  });
});

describe("kept with the task, across turns (0.7.26)", () => {
  test("goes with the task written last, survives the turn's end while steps are left, and goes when they are done", async () => {
    // A group's audit waited on "confirm first" at every step: each wait ended the turn, and the turn took the plan.
    const { notes, tool } = kept();
    await notes.write(WHO, "Verify 52 documents", "- Next: 31");
    const said = await tool.execute({ steps: [{ text: "check 1–30", state: "done" }, { text: "check 31–52", state: "active" }] }, ctx());
    expect(said.content).toContain('Kept with "Verify 52 documents"');
    await settleNotes(notes, { ...WHO, sessionId: ctx().sessionId });
    expect(notes.plan(WHO)?.steps).toHaveLength(2);

    await tool.execute({ steps: [{ text: "check 1–30", state: "done" }, { text: "check 31–52", state: "done" }] }, ctx());
    await settleNotes(notes, { ...WHO, sessionId: ctx().sessionId });
    expect(notes.plan(WHO)).toBeUndefined();
    // The task stays: its words are the agent's to remove.
    expect(notes.tasks(WHO).map((task) => task.title)).toEqual(["Verify 52 documents"]);
  });

  test("replaces the whole list rather than merging", async () => {
    // Whole-list writes cannot desynchronise from what the model believes. Partial updates would need
    // stable ids, and a model inventing ids edits the wrong row silently.
    const { notes, tool } = kept();
    await tool.execute({ steps: ["a", "b", "c"] }, ctx());
    await tool.execute({ steps: ["only this"] }, ctx());
    expect(notes.plan(WHO)?.steps).toEqual([{ text: "only this", state: "pending" }]);
  });

  test("two conversations do not share a plan", async () => {
    const { notes, tool } = kept();
    await tool.execute({ steps: ["from c1"] }, ctx("c1"));
    await tool.execute({ steps: ["from c2"] }, ctx("c2"));
    expect(notes.plan(WHO)?.steps[0]?.text).toBe("from c1");
    expect(notes.plan({ ...WHO, chatId: "c2" })?.steps[0]?.text).toBe("from c2");
  });

  test("a helper's plan is its own — the conversation's is not touched", async () => {
    // A helper runs in its parent's chat; keyed by the chat, its plan overwrote the parent's and its end cleared it.
    const { notes, tool } = kept();
    await tool.execute({ steps: [{ text: "the parent's step", state: "active" }] }, ctx());
    const helper = ctx("c1", childSessionId(ctx().sessionId, "sub"));
    await tool.execute({ steps: ["the helper's step"] }, helper);
    await settleNotes(notes, { ...WHO, sessionId: helper.sessionId });
    expect(notes.plan(WHO)?.steps).toEqual([{ text: "the parent's step", state: "active" }]);
  });

  test("an empty list clears the kept plan", async () => {
    const { notes, tool } = kept();
    await tool.execute({ steps: ["a"] }, ctx());
    expect((await tool.execute({ steps: [] }, ctx())).content).toContain("cleared");
    expect(notes.plan(WHO)).toBeUndefined();
  });
});
