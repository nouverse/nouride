/**
 * A coding CLI's updates read as a turn of Nouride's (0.8.1): the same steps, deltas and plan a model's turn writes,
 * so the turn record, the chat bubble and a mission's count show a CLI's work with nothing told which it was.
 */

import { describe, expect, test } from "bun:test";
import type { PlanEntry, SessionUpdate } from "@nouride/acp";
import { UpdateReader } from "@/modules/external-agents/updates.ts";

function reader(sent = false) {
  const said: string[] = [];
  const preambles: string[] = [];
  const steps: { kind: string; text: string; detail?: Record<string, unknown> }[] = [];
  const plans: PlanEntry[][] = [];
  let now = 1_000;
  const read = new UpdateReader(
    { text: (delta) => said.push(delta), activity: (kind, text, detail) => steps.push({ kind, text, ...(detail ? { detail } : {}) }), plan: (entries) => plans.push(entries), preamble: async (words) => (preambles.push(words), sent) },
    () => now,
  );
  return { read, said, steps, plans, preambles, tick: (ms: number) => void (now += ms) };
}

const text = (sessionUpdate: "agent_message_chunk" | "agent_thought_chunk", value: string): SessionUpdate => ({ sessionUpdate, content: { type: "text", text: value } });

describe("a CLI's turn", () => {
  test("its reply streams as deltas; a thought is one reasoning step, written when something else begins", () => {
    const r = reader();
    r.read.read(text("agent_thought_chunk", "Reading the "));
    r.read.read(text("agent_thought_chunk", "repo first."));
    r.read.read(text("agent_message_chunk", "Done: "));
    r.read.read(text("agent_message_chunk", "two files."));
    r.read.end();
    expect(r.steps).toEqual([{ kind: "reasoning", text: "Reading the repo first." }]);
    expect(r.said).toEqual(["Done: ", "two files."]);
    expect(r.read.text).toBe("Done: two files.");
  });

  test("a plan without its entries is passed over; one with them is kept (0.8.1)", () => {
    const r = reader();
    r.read.read({ sessionUpdate: "plan" } as never);
    r.read.read({ sessionUpdate: "plan", entries: [{ content: "push it", priority: "high", status: "pending" }] });
    expect(r.plans).toEqual([[{ content: "push it", priority: "high", status: "pending" }]]);
  });

  test("its messages around a step are paragraphs of the reply, not one run-on line (0.8.1, the live box)", () => {
    // "…sekarang gw cek `internals/pro` sama branch lain.Masih audit." — two messages, a tool call between, joined.
    const r = reader();
    r.read.read(text("agent_message_chunk", "Checking the branches."));
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "git branch", kind: "execute", name: "Bash", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    r.read.read(text("agent_message_chunk", "Still auditing."));
    r.read.read(text("agent_message_chunk", " One more check."));
    expect(r.read.text).toBe("Checking the branches.\n\nStill auditing. One more check.");
    expect(r.said.join("")).toBe(r.read.text);
  });

  test("a step's line is the output's first words, not the code fence Claude Code wraps it in (0.8.1, the live box)", () => {
    const r = reader();
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", name: "Bash", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "```console\nREADME.md\nsrc\n```" } }] });
    expect(r.steps[1]!.text.replace(/ · \d+ms$/, "")).toBe("Bash ok: README.md");
  });

  test("a call of kind other is named by its title's first word, as omp names an MCP tool there (seen on omp 18.12)", () => {
    const r = reader();
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "m1", title: "mcp__nouride_notes", kind: "other", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "m1", status: "completed", content: [{ type: "content", content: { type: "text", text: "No work notes yet." } }] });
    expect(r.steps.map((step) => step.text.replace(/ · \d+ms$/, ""))).toEqual(["mcp__nouride_notes", "mcp__nouride_notes ok: No work notes yet."]);
  });

  test("a tool call is a step and its end another, paired by its id, named by the agent's own name else its kind", () => {
    const r = reader();
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", name: "Bash", status: "in_progress" });
    r.tick(250);
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "12 passed\nmore" } }] });
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit src/app.ts", kind: "edit", status: "pending" });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", rawOutput: "file is read-only" });
    expect(r.steps).toEqual([
      { kind: "tool", text: "npm test", detail: { callId: "t1", name: "Bash", like: "exec" } },
      { kind: "tool_done", text: "Bash ok: 12 passed · 250ms", detail: { callId: "t1", name: "Bash", error: false, outcome: "ok" } },
      { kind: "tool", text: "Edit src/app.ts", detail: { callId: "t2", name: "edit", like: "edit" } },
      { kind: "tool_done", text: "edit failed: file is read-only · 0ms", detail: { callId: "t2", name: "edit", error: true, outcome: "failed" } },
    ]);
    expect(r.read.steps).toEqual([{ name: "Bash", ok: true }, { name: "edit", ok: false }]);
    expect(r.read.toolCalls).toBe(2);
  });

  test("an update for a call it never announced opens it; one never closed is closed as cut off at the end", () => {
    const r = reader();
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "late", title: "git status", kind: "execute", status: "in_progress" });
    r.read.end();
    expect(r.steps.map((step) => `${step.kind}:${step.text}`)).toEqual(["tool:git status", "tool_done:execute did not finish"]);
    expect(r.read.steps).toEqual([{ name: "execute", ok: false }]);
  });

  test("its plan goes to the plan beside the chat — a mission's checklist — and what a turn does not show is passed by", () => {
    const r = reader();
    const entries: PlanEntry[] = [{ content: "write the test", priority: "high", status: "completed" }, { content: "fix it", priority: "high", status: "in_progress" }];
    r.read.read({ sessionUpdate: "plan", entries });
    r.read.read({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    r.read.read({ sessionUpdate: "usage_update", used: 12_000, size: 200_000 });
    expect(r.plans).toEqual([entries]);
    expect(r.steps).toEqual([]);
  });
});

describe("a call Claude Code reports while its input still streams (0.8.5)", () => {
  test("is announced once, under the command, not as \"Terminal\"", () => {
    // claude-agent-acp 0.95.0: the first `tool_call` carries `rawInput: {}` and the title "Terminal"; the command comes in
    // an update. Every step read "🔧 Terminal", and the bubble — one unchanged line — looked stuck.
    const r = reader();
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal", kind: "execute", name: "Bash", status: "pending", rawInput: {} });
    expect(r.steps).toEqual([]);
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", title: "git status", rawInput: { command: "git status" } });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(r.steps.map((step) => step.kind === "tool" ? step.text : step.kind)).toEqual(["git status", "tool_done"]);
    expect(r.read.toolCalls).toBe(1);
  });

  test("is announced once it runs, or when asked about, where no better title came", () => {
    const r = reader();
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal", kind: "execute", name: "Bash", status: "pending", rawInput: {} });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Terminal", kind: "execute", name: "Bash", status: "pending", rawInput: {} });
    r.read.announce("t2", "rm -rf build");
    r.read.announce("t2", "rm -rf build");
    expect(r.steps.map((step) => step.text)).toEqual(["Terminal", "rm -rf build"]);
  });
});

describe("the reply's words before a step (0.8.5)", () => {
  test("are offered to the chat before the step, and the answer leaves out those that went out", async () => {
    // The CLI's "checking the code now" reached the chat only inside the final answer, minutes later, with everything.
    const r = reader(true);
    r.read.read(text("agent_message_chunk", "Checking the code."));
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", name: "Bash", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    r.read.read(text("agent_message_chunk", "Found it."));
    await r.read.settled();
    expect(r.preambles).toEqual(["Checking the code."]);
    expect(r.read.text).toBe("Checking the code.\n\nFound it.");
    expect(r.read.unsaid).toBe("Found it.");
  });

  test("held back by the chat stay in the answer", async () => {
    const r = reader(false);
    r.read.read(text("agent_message_chunk", "Checking the code."));
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", name: "Bash", status: "in_progress" });
    r.read.read(text("agent_message_chunk", "Found it."));
    await r.read.settled();
    expect(r.read.unsaid).toBe("Checking the code.\n\nFound it.");
  });
});

describe("a CLI's messages, each said as it is written (0.8.5)", () => {
  test("two a thought stood between both go out before the step, not the last alone", async () => {
    // Two parts of the reply: the first stayed out of the chat until the answer, minutes later.
    const r = reader(true);
    r.read.read(text("agent_message_chunk", "Reading the typing path."));
    r.read.read(text("agent_thought_chunk", "The executor has a keepalive; the runner?"));
    r.read.read(text("agent_message_chunk", "Now the CLI's path."));
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "grep -rn typing", kind: "search", name: "Grep", status: "in_progress" });
    await r.read.settled();
    expect(r.preambles).toEqual(["Reading the typing path.\n\nNow the CLI's path."]);
    expect(r.read.unsaid).toBe("");
  });

  test("the answer to a message another one follows is said when it is finished", async () => {
    const r = reader(true);
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "git push", kind: "execute", name: "Bash", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    r.read.read(text("agent_message_chunk", "Pushed."));
    await r.read.sayRest();
    expect(r.preambles).toEqual(["Pushed."]);
    expect(r.read.unsaid).toBe("");
    expect(r.read.text).toBe("Pushed.");
  });

  test("a step names the tool of Nouride's its kind is like, for the bubble's mark", () => {
    const r = reader();
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "git status", kind: "execute", name: "Bash", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t2", title: "src/index.ts", kind: "read", name: "Read", status: "in_progress" });
    r.read.read({ sessionUpdate: "tool_call", toolCallId: "t3", title: "mcp__nouride__notes", kind: "other", status: "in_progress" });
    expect(r.steps.map((step) => step.detail?.like)).toEqual(["exec", "read", undefined]);
  });
});

describe("what a prompt has spent while it runs (0.8.8)", () => {
  // claude-agent-acp 0.95.0 sends `usage_update` at each model call's start and as its output streams: `used` is the
  // call's input, cache and output together. msn_3d28e0's CLI spent 140M tokens in one prompt that nothing could see.
  const usage = (used: number): SessionUpdate => ({ sessionUpdate: "usage_update", used, size: 1_000_000 });
  const step = (id: string): SessionUpdate[] => [
    { sessionUpdate: "tool_call", toolCallId: id, title: `cat ${id}`, kind: "execute", status: "pending", rawInput: { command: `cat ${id}` } },
    { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" },
  ];

  test("each model call counts its last context once — a call ends where a step finished", () => {
    const r = reader();
    // Call 1: 100k in, its output grows it to 101k; a step; call 2 reads all of it again, and more.
    for (const update of [usage(100_000), usage(101_000), ...step("a"), usage(103_000), usage(104_500)]) r.read.read(update);
    expect(r.read.spent).toBe(101_000 + 104_500);
    // Two steps from one call (run side by side) end that call once.
    for (const update of [...step("b"), ...step("c"), usage(110_000)]) r.read.read(update);
    expect(r.read.spent).toBe(101_000 + 104_500 + 110_000);
  });

  test("a call whose steps run side by side ends when the last is done — one finished while its output streamed counts it once", () => {
    // Live, 0.8.8's first build: Claude Code ran a call's commands together; one finished before the call's last usage,
    // and the next was read as a new call — 1.25M estimated for 1.12M reported.
    const r = reader();
    const open = (id: string): SessionUpdate => ({ sessionUpdate: "tool_call", toolCallId: id, title: `wc -l ${id}`, kind: "execute", status: "in_progress", rawInput: { command: `wc -l ${id}` } });
    const done = (id: string): SessionUpdate => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    for (const update of [usage(100_000), open("a"), open("b"), done("a"), usage(100_800), done("b"), usage(102_000)]) r.read.read(update);
    expect(r.read.spent).toBe(100_800 + 102_000);
  });

  test("a compaction's smaller context is the same call's, and the larger stands", () => {
    const r = reader();
    for (const update of [usage(180_000), usage(40_000)]) r.read.read(update);
    expect(r.read.spent).toBe(180_000);
    for (const update of [...step("a"), usage(42_000)]) r.read.read(update);
    expect(r.read.spent).toBe(180_000 + 42_000);
  });

  test("nothing said of the context is nothing spent", () => {
    const r = reader();
    for (const update of step("a")) r.read.read(update);
    expect(r.read.spent).toBe(0);
  });
});

describe("the last tool call open ending (0.8.10)", () => {
  test("is told at once — a message held for it goes in then — and not while another is still open", () => {
    let idle = 0;
    const read = new UpdateReader({ text: () => {}, activity: () => {}, plan: () => {}, preamble: async () => false, idle: () => void (idle += 1) });
    const call = (id: string, status: "in_progress" | "completed") =>
      read.read(status === "in_progress" ? { sessionUpdate: "tool_call", toolCallId: id, title: "cat", kind: "execute", name: "Bash", status } : { sessionUpdate: "tool_call_update", toolCallId: id, status });
    call("t1", "in_progress");
    call("t2", "in_progress");
    call("t1", "completed");
    expect(idle).toBe(0);
    call("t2", "completed");
    expect(idle).toBe(1);
    expect(read.running).toBe(0);
  });
});
