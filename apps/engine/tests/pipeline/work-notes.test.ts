/**
 * Work notes through the real pipeline (0.7.26): what the agent writes is at the end of every request after it, never in
 * the stored history, kept by `/new`, cleared by `/reset` — and a long turn that has written none is asked to.
 *
 * The case: a four-hour audit in a WhatsApp group lost its place to compaction and the trim (2026-10-20).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Tool } from "@nouride/shared";
import { NotesStore } from "@/modules/notes/store.ts";
import { createNotesTool } from "@/modules/tools/builtins/notes.ts";
import { createPlanTool } from "@/modules/tools/builtins/plan.ts";
import { envelope, scriptedOpenAI } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const probe: Tool = {
  requiresApproval: false,
  definition: { name: "probe", description: "looks at a document", parameters: { type: "object", properties: {} } },
  execute: async () => ({ content: "document checked", isError: false }),
};

const WRITE = { action: "write", title: "Verify 52 documents", body: "- Done: 1–30\n- Next: 31\n- Facts: close Excel before overwriting" };

async function bench(turns: Parameters<typeof scriptedOpenAI>[0]) {
  let notes!: NotesStore;
  const made = await pipelineBench({
    turns,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["plan", "probe"]\n',
    deps: ({ dataDir }) => {
      notes = new NotesStore(join(dataDir, "notes"));
      return { notes };
    },
  });
  cleanup.push(made.dispose);
  made.pipeline.setTools(new Map<string, Tool>([["probe", probe], ["plan", createPlanTool(notes)], ["notes", createNotesTool(notes)]]));
  made.pipeline.attach();
  let n = 0;
  const say = async (text: string) => {
    // Each its own id and time: the inbox takes a repeated id for a redelivery.
    made.gateway.receive(envelope({ id: `m${++n}`, timestamp: Date.now() + n, text, chatType: "dm", senderId: "operator", gatewayId: made.gateway.id }));
    await made.pipeline.idle();
  };
  return { ...made, notes, say };
}

/** The last message a request sent — where the notes ride. */
const lastOf = (request: { messages: { role: string; content: unknown }[] }) => request.messages.at(-1)!;
const said = (request: { messages: { content: unknown }[] }) => JSON.stringify(request.messages);

describe("work notes in a conversation", () => {
  test("written in one step, at the end of the next request — and of the next turn's — never in the history", async () => {
    const h = await bench([{ toolCalls: [{ id: "n1", name: "notes", args: WRITE }] }, { text: "Noted, carrying on." }, { text: "Document 31 next." }]);
    await h.say("cek dokumen satu per satu");
    await h.say("lanjut");

    expect(said(h.requests[0])).not.toContain("WORK NOTES");
    expect(lastOf(h.requests[1])).toMatchObject({ role: "user" });
    expect(String(lastOf(h.requests[1]).content)).toContain("## Verify 52 documents\n- Done: 1–30");
    expect(String(lastOf(h.requests[2]).content)).toStartWith("WORK NOTES");
    // Once per request, at the end — not carried into the history the next request is built from.
    expect(said(h.requests[2]).split("WORK NOTES").length - 1).toBe(1);
    const stored = JSON.stringify(h.sessions.load({ agentId: "nouva", gatewayId: h.gateway.id, chatId: "chat-1" }).messages);
    expect(stored).not.toContain("WORK NOTES");
  });

  test("/new keeps them and says so; /reset clears them and says how many", async () => {
    const h = await bench([{ toolCalls: [{ id: "n1", name: "notes", args: WRITE }] }, { text: "Noted." }, { text: "Still on 31." }, { text: "Fresh start." }]);
    await h.say("mulai");
    h.gateway.sent.splice(0);

    await h.say("/new");
    expect(h.gateway.lastText()).toContain("Work notes kept (1 task)");
    await h.say("sampai mana?");
    expect(String(lastOf(h.requests.at(-1)!).content)).toContain("Verify 52 documents");

    await h.say("/reset");
    expect(h.gateway.lastText()).toContain("1 work-notes task(s) cleared");
    await h.say("halo");
    expect(said(h.requests.at(-1)!)).not.toContain("WORK NOTES");
  });

  test("/notes shows them, and /notes clear empties them", async () => {
    const h = await bench([{ toolCalls: [{ id: "n1", name: "notes", args: WRITE }] }, { text: "Noted." }]);
    await h.say("mulai");
    await h.say("/notes");
    expect(h.gateway.lastText()).toContain("Work notes (1 task):\n\n## Verify 52 documents");
    await h.say("/notes clear");
    expect(h.gateway.lastText()).toBe("Cleared 1 task(s) from the work notes.");
    expect(h.notes.tasks({ agentId: "nouva", gatewayId: h.gateway.id, chatId: "chat-1" })).toEqual([]);
  });

  test("a conversation with no notes is asked at the first call whether the work goes on, and told outright at the eighth", async () => {
    // Live: asked to do two of four and wait, Gemini Flash made three calls, then two, and answered — nothing written.
    const calls = Array.from({ length: 9 }, (_, i) => ({ toolCalls: [{ id: `p${i}`, name: "probe", args: { n: i } }] }));
    const h = await bench([...calls, { text: "done" }]);
    await h.say("periksa semuanya");

    const results = h.requests.at(-1)!.messages.filter((message: { role: string }) => message.role === "tool").map((message: { content: string }) => message.content);
    const at = (said: string) => results.map((content: string, index: number) => (content.includes(said) ? index + 1 : null)).filter(Boolean);
    expect(at("[harness] If this work goes on after this turn")).toEqual([1]);
    expect(at("[harness] This is long work")).toEqual([8]);
  });

  test("where notes exist, a turn is not asked whether the work goes on — only told at the eighth call", async () => {
    const h = await bench([{ toolCalls: [{ id: "n1", name: "notes", args: WRITE }] }, { text: "Noted." }, ...Array.from({ length: 3 }, (_, i) => ({ toolCalls: [{ id: `q${i}`, name: "probe", args: {} }] })), { text: "three checked" }]);
    await h.say("mulai");
    await h.say("lanjut tiga lagi");
    expect(said(h.requests.at(-1)!)).not.toContain("[harness] If this work goes on");
  });

  test("a turn that has written its notes is not asked", async () => {
    const calls = Array.from({ length: 9 }, (_, i) => ({ toolCalls: [{ id: `p${i}`, name: i === 0 ? "notes" : "probe", args: i === 0 ? WRITE : {} }] }));
    const h = await bench([...calls, { text: "done" }]);
    await h.say("periksa semuanya");
    expect(said(h.requests.at(-1)!)).not.toContain("[harness] This is long work");
    expect(said(h.requests.at(-1)!)).not.toContain("[harness] If this work goes on");
  });
});
