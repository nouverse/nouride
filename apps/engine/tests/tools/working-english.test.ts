/**
 * Working text is refused unless it is English where it passes through a tool — `plan`, `notes`, `ask_agent`'s task and
 * `delegate`'s brief — the way memory refuses a fact: the answer says to write it again, and nothing is kept or sent.
 * Each also takes English with a person's words quoted in their own language.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { sessionIdFor, type ToolContext } from "@nouride/shared";
import { NotesStore } from "@/modules/notes/store.ts";
import { createPlanTool } from "@/modules/tools/builtins/plan.ts";
import { createNotesTool } from "@/modules/tools/builtins/notes.ts";
import { createAskAgentTool, type PeerTurnRequest } from "@/modules/tools/builtins/ask-agent.ts";
import { createDelegateTool, type SubagentRequest } from "@/modules/tools/builtins/delegate.ts";
import { parseBriefs } from "@/modules/tools/builtins/delegate-brief.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { tempDir } from "../helpers.ts";

const WHO = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "c1" };
const ctx = () => ({ ...WHO, sessionId: sessionIdFor(WHO), gateway: "telegram", senderId: "u", signal: new AbortController().signal }) as ToolContext;

const QUOTED = 'Gading asked: "bisa lu settingin ga pemindahannya?" Please move the share to the new NAS and report back.';
const REFUSED = "is not in English. Plans, notes and what you hand to another agent are written in English";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removePath(dir);
});

function store(): NotesStore {
  const dir = tempDir("working-english");
  dirs.push(dir);
  return new NotesStore(join(dir, "notes"));
}

describe("plan", () => {
  test("a step, its note or its reason not in English is refused, and the plan kept is the one before", async () => {
    const notes = store();
    const tool = createPlanTool(notes);
    await tool.execute({ steps: ["Survey the code", "Write the fix"] }, ctx());
    for (const steps of [
      [{ text: "Survey the code", state: "done" }, { text: "Commit dan push ke branch", state: "active" }],
      [{ text: "Survey the code", state: "done", note: "Sudah dicek semua file yang berubah" }, { text: "Write the fix", state: "active" }],
      [{ text: "Survey the code", state: "skipped", reason: "tidak perlu karena sudah ada" }, { text: "Write the fix", state: "active" }],
    ]) {
      const result = await tool.execute({ steps }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain(REFUSED);
    }
    expect((await tool.execute({ steps: [{ text: "Commit dan push ke branch" }] }, ctx())).content).toStartWith('Step 1, "Commit dan push ke branch", is not in English.');
    expect(notes.plan(WHO)?.steps.map((step) => step.text)).toEqual(["Survey the code", "Write the fix"]);
  });

  test("a step is judged before it is cut to length, and a task named for it is judged too", async () => {
    // Cut at 200 characters first, a quote lost its closing mark and the person's words were counted as the step's (Nox, A4).
    const notes = store();
    const tool = createPlanTool(notes);
    const long = `Reply to Mira's question: "${"tolong cek dulu semua log di server yang lama ya, ".repeat(4)}" with the list of errors found`;
    expect((await tool.execute({ steps: [{ text: long, state: "active" }] }, ctx())).isError).toBe(false);
    const task = await tool.execute({ steps: ["Survey the code"], task: "Pindahan NAS ke rak yang baru" }, ctx());
    expect(task.isError).toBe(true);
    expect(task.content).toStartWith('The task "Pindahan NAS ke rak yang baru" is not in English.');
  });

  test("short technical steps, paths and commands are English", async () => {
    const notes = store();
    const result = await createPlanTool(notes).execute(
      { steps: [{ text: "du -sh /var/lib", state: "done", note: "Fixed the non-empty check in config.ini" }, { text: "Merge --no-ff into releases/v0.8.8", state: "active" }] },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(notes.plan(WHO)?.steps).toHaveLength(2);
  });
});

describe("notes", () => {
  test("a task not in English is refused and not written", async () => {
    const notes = store();
    const tool = createNotesTool(notes);
    const result = await tool.execute({ action: "write", title: "Audit", body: "Goal: cek semua dokumen yang belum ditandatangani\nNext: dokumen 31" }, ctx());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toStartWith('The task "Audit" is not in English.');
    expect(notes.tasks(WHO)).toEqual([]);
  });

  test("a person's rule quoted as they said it is English around it", async () => {
    const notes = store();
    const body = "Goal: move the share to the new NAS\nRules the person set: \"jangan hapus yang lama dulu\"\nNext: copy /srv/share with rsync -a";
    expect((await createNotesTool(notes).execute({ action: "write", title: "NAS move", body }, ctx())).isError).toBe(false);
    expect(notes.tasks(WHO).map((task) => task.title)).toEqual(["NAS move"]);
  });
});

describe("ask_agent", () => {
  const handoff: SubAgentHandoff = { agentId: "nox", status: "success", summary: "done", files: [], spills: [], metrics: { toolCalls: 1, steps: 1, ms: 1 } };

  test("a task not in English is refused and the other agent is not asked", async () => {
    const asked: PeerTurnRequest[] = [];
    const tool = createAskAgentTool({ peers: () => ["nox"], run: async (request) => (asked.push(request), handoff) });
    const result = await tool.execute({ agent: "nox", task: "Tolong review diff di branch fix/english-working-language, cari bug dan kasih tau hasilnya" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("The task is not in English.");
    expect(asked).toEqual([]);
  });

  test("an English task quoting the person is sent as it was written", async () => {
    const asked: PeerTurnRequest[] = [];
    const tool = createAskAgentTool({ peers: () => ["nox"], run: async (request) => (asked.push(request), handoff) });
    expect((await tool.execute({ agent: "nox", task: QUOTED }, ctx())).isError).toBe(false);
    expect(asked.map((request) => request.task)).toEqual([QUOTED]);
  });
});

describe("delegate", () => {
  const brief = { goal: "Find the errors in the NAS logs", context: "The logs are in /var/log on nas.lan.", deliverable: "Each error with its file and line." };

  test("a brief not in English is refused, naming which, and no helper starts", async () => {
    const started: SubagentRequest[] = [];
    const tool = createDelegateTool({ run: async (request) => (started.push(request), { ok: true, text: "" }) as never });
    const foreign = { ...brief, context: "Lognya ada di /var/log di nas.lan, dan yang dicari adalah error dari tadi pagi." };
    const result = await tool.execute({ tasks: [brief, foreign] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("Task 2's brief is not in English.");
    expect(started).toEqual([]);
  });

  test("an English brief quoting the person passes", () => {
    expect(parseBriefs([{ ...brief, context: `${QUOTED} The logs are in /var/log on nas.lan.` }], 4)).toEqual({ briefs: [{ ...brief, context: `${QUOTED} The logs are in /var/log on nas.lan.` }] });
  });
});
