/**
 * `/btw` through the real pipeline (0.8.17, RFC_SIDE_QUESTIONS §3 with the owner's three answers; 0.8.20, the owner's
 * rule of 2026-11-05): a side question is answered beside the turn by one of its own, on the agent's own model at low
 * effort, as the agent itself in the person's language, seeing the conversation and the work in flight; it can do
 * nothing, and writes nothing back. Its answer reaches the chat marked, and the turn log as a `note` record memory
 * skips; neither the running turn nor the next one sees it. One at a time per chat.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@nouride/shared";
import { stepsOf } from "@/modules/pipeline/aside-context.ts";
import { isSideAnswer, isSideQuestion, sideQuestionMessage, SIDE_ROUNDS, SIDE_SAYS, withinTheMinute } from "@/modules/pipeline/side-question.ts";
import { envelope, scriptedOpenAI } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { eventually } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const SIDE = "[A side question, asked with /btw";
type Turns = Parameters<typeof scriptedOpenAI>[0];
type Body = { messages?: { role: string; content: unknown }[]; tools?: { function: { name: string } }[]; reasoning_effort?: string };

const fakeTool = (name: string, run: () => Promise<string>, parallelSafe = false): Tool => ({
  requiresApproval: false,
  parallelSafe,
  definition: { name, description: `${name} for the test`, parameters: { type: "object", properties: {} } },
  execute: async () => ({ content: await run(), isError: false }),
});

/** The main conversation on `main`, side questions on `side`; `sideGate` holds each side request until it opens. */
async function bench(options: { main: Turns; side: Turns; probe?: () => Promise<string>; sideGate?: Promise<void> }) {
  const side = scriptedOpenAI(options.side);
  const sideBodies: Body[] = [];
  const mainBodies: Body[] = [];
  const counts = { read: 0, exec: 0 };
  const made = await pipelineBench({
    turns: options.main,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["read", "exec", "probe"]\n',
    fetch: (scripted) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Body;
        if (!JSON.stringify(body.messages ?? []).includes(SIDE)) {
          mainBodies.push(body);
          return await scripted(url, init);
        }
        sideBodies.push(body);
        await options.sideGate;
        return await side.fetchImpl(url, init);
      }) as typeof fetch,
  });
  cleanup.push(made.dispose);
  made.pipeline.setTools(
    new Map<string, Tool>([
      // A different line each read: the same answer twice is the same-answer guard's to stop, not the round cap's.
      ["read", fakeTool("read", async () => (counts.read++, `port = 1839${counts.read}`), true)],
      ["exec", fakeTool("exec", async () => (counts.exec++, "ran"))],
      ["probe", fakeTool("probe", options.probe ?? (async () => "document 7 checked"))],
    ]),
  );
  made.pipeline.attach();
  let n = 0;
  const send = (text: string) => made.gateway.receive(envelope({ id: `m${++n}`, timestamp: Date.now() + n, text, chatType: "dm", senderId: "operator", gatewayId: made.gateway.id }));
  const say = async (text: string) => {
    send(text);
    await made.pipeline.idle();
    return made.gateway.lastText();
  };
  const said = () => made.gateway.sent.map((message) => message.text);
  const stored = () => JSON.stringify(made.sessions.load({ agentId: "nouva", gatewayId: made.gateway.id, chatId: "chat-1" }).messages);
  return { ...made, send, say, said, stored, sideBodies, mainBodies, counts };
}

const lastUser = (body: Body) => JSON.stringify([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "");
const offered = (body: Body) => (body.tools ?? []).map((tool) => tool.function.name).sort();

describe("/btw", () => {
  test("with no turn running: answered marked, a note record memory skips, and nothing the next turn reads", async () => {
    const h = await bench({ main: [{ text: "first answer" }, { text: "second answer" }], side: [{ text: "Port 18390." }] });
    await h.say("what are we doing");
    expect(await h.say("/btw what port was that?")).toBe("btw: Port 18390.");
    // No tool at all, not even one that reads: it does nothing (the owner, 2026-11-05).
    expect(offered(h.sideBodies[0]!)).toEqual([]);
    // At low effort: at the agent's own, Nix thought for 24 s before a word and its minute ran out (live, 2026-11-05).
    expect(h.sideBodies[0]!.reasoning_effort).toBe("low");
    expect(h.mainBodies[0]!.reasoning_effort).toBeUndefined();
    // It saw the conversation so far: what was asked and what the agent answered.
    expect(lastUser(h.sideBodies[0]!)).toContain("They said: what are we doing");
    expect(lastUser(h.sideBodies[0]!)).toContain("You said: first answer");
    await h.say("and now?");
    expect(JSON.stringify(h.mainBodies.at(-1)!.messages)).not.toContain("what port");
    expect(JSON.stringify(h.mainBodies.at(-1)!.messages)).not.toContain("18390");
    expect(h.stored()).not.toContain("what port");
    const note = h.turns.forChat(h.gateway.id, "chat-1").find((turn) => turn.prompt.startsWith("/btw"))!;
    expect(note).toMatchObject({ prompt: "/btw what port was that?", reply: "btw: Port 18390.", status: "done" });
    expect(note.model).toBeUndefined();
    expect(h.turns.exchangesBetween(h.gateway.id, "chat-1", 0, Date.now() + 60_000).map((exchange) => exchange.prompt)).not.toContain("/btw what port was that?");
  });

  test("while a turn runs: sees its last steps, and the turn ends as it would have, without the side question", async () => {
    let entered!: () => void;
    let release!: () => void;
    const inProbe = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = await bench({
      main: [{ toolCalls: [{ id: "p1", name: "probe", args: { doc: 7 } }] }, { text: "probe done" }],
      side: [{ text: "Document 7." }],
      probe: async () => (entered(), await gate, "document 7 checked"),
    });
    h.send("check document seven");
    await inProbe;
    h.send("/btw which document?");
    await eventually(() => h.said().includes("btw: Document 7."), 5_000, "the side answer while the turn runs");
    expect(lastUser(h.sideBodies[0]!)).toContain("[Your turn still running, its last steps:]");
    expect(lastUser(h.sideBodies[0]!)).toContain("You called probe");
    release();
    await h.pipeline.idle();
    expect(h.gateway.lastText()).toBe("probe done");
    expect(h.stored()).toContain("probe done");
    expect(h.stored()).not.toContain("which document");
    expect(h.stored()).not.toContain("Document 7.");
  });

  test("one at a time per chat: a second while one is answered is refused", async () => {
    let open!: () => void;
    const sideGate = new Promise<void>((resolve) => (open = resolve));
    const h = await bench({ main: [{ text: "unused" }], side: [{ text: "First." }], sideGate });
    h.send("/btw first?");
    await eventually(() => h.sideBodies.length === 1, 5_000, "the first side request");
    h.send("/btw second?");
    await eventually(() => h.said().includes(SIDE_SAYS.busy), 5_000, "the second refused");
    open();
    await eventually(() => h.said().includes("btw: First."), 5_000, "the first answered");
    expect(h.sideBodies).toHaveLength(1);
  });

  test("a tool called anyway is refused and runs nothing: one that reads as much as one that runs", async () => {
    const h = await bench({
      main: [{ text: "unused" }],
      side: [{ toolCalls: [{ id: "x1", name: "exec", args: { command: "id -un" } }, { id: "r1", name: "read", args: { path: "f" } }] }, { text: "Better asked in the chat." }],
    });
    expect(await h.say("/btw TOOL:exec who am I?")).toBe("btw: Better asked in the chat.");
    expect(h.counts.exec).toBe(0);
    expect(h.counts.read).toBe(0);
  });

  test("a few rounds at most: a model that keeps calling tools is stopped, runs none of them, and answers", async () => {
    const reads = Array.from({ length: 12 }, (_, i) => ({ toolCalls: [{ id: `r${i}`, name: "read", args: { path: `f${i}` } }] }));
    const h = await bench({ main: [{ text: "unused" }], side: [...reads, { text: "Read enough." }] });
    const reply = await h.say("/btw read everything");
    expect(h.counts.read).toBe(0);
    expect(h.sideBodies.length).toBeLessThanOrEqual(SIDE_ROUNDS + 1);
    expect(reply?.startsWith("btw: ")).toBe(true);
  });

  test("what it is told carries the owner's rule: itself, their language, a question answered, a request sent to the chat", () => {
    const asked = sideQuestionMessage("what do you think of effort?", "They said: hi\nYou said: hello", "Asked: check the release");
    expect(asked).toContain("Answer it as yourself, in your own voice and in the language it was asked in");
    expect(asked).toContain("From here you can do nothing: no tools, nothing run, nothing changed.");
    expect(asked).toContain("If it asks you to do something, or the answer needs something looked up or run, say so in a sentence, in your voice and their language: that it is better said in the chat itself, where you can do it.");
    expect(asked).toContain("[The conversation so far:]\nThey said: hi\nYou said: hello");
    expect(asked).toContain("[Your turn still running, its last steps:]\nAsked: check the release");
    expect(asked.endsWith("\nwhat do you think of effort?")).toBe(true);
    // Nothing shown that is not there.
    expect(sideQuestionMessage("q", "", "")).not.toContain("[The conversation so far:]");
    expect(sideQuestionMessage("q", "", "")).not.toContain("[Your turn still running");
  });

  test("the daemon's own words never send the question to the chat: that is the agent's to say", () => {
    for (const said of [SIDE_SAYS.late, SIDE_SAYS.empty, SIDE_SAYS.failed("the model is down")]) expect(said).not.toContain("as a message");
  });

  test("no question: says how to ask one", async () => {
    const h = await bench({ main: [{ text: "unused" }], side: [{ text: "unused" }] });
    expect(await h.say("/btw")).toBe(SIDE_SAYS.usage);
    expect(h.sideBodies).toHaveLength(0);
  });
});

describe("what is a side question, and its answer", () => {
  test("`/btw`, as sent and as addressed in a room; the answer by its mark", () => {
    for (const text of ["/btw what port?", "/btw@nova_bot what port?", "@nova_bot /btw what port?", "nova: /btw what port?"]) expect(isSideQuestion(text)).toBe(true);
    for (const text of ["/btwx", "what is /btw?", "/status"]) expect(isSideQuestion(text)).toBe(false);
    expect(isSideAnswer("btw: Port 18390.")).toBe(true);
    expect(isSideAnswer("Port 18390.")).toBe(false);
  });

  test("its minute holds when a tool does not stop: the answer comes at the minute, whatever the tool is doing", async () => {
    // A read stuck on a pipe in the VM sandbox kept one past its minute, and the chat refused every /btw after it.
    const minute = new AbortController();
    let outcome = "still waiting";
    void withinTheMinute(new Promise<string>(() => {}), minute.signal).then(
      () => (outcome = "answered"),
      (reason: unknown) => (outcome = `stopped: ${String(reason)}`),
    );
    minute.abort("a side question's minute is up");
    // No wait for time to pass: the stop is said in the same few microtasks, or never.
    for (let tick = 0; tick < 3; tick++) await Promise.resolve();
    expect(outcome).toBe("stopped: a side question's minute is up");
    expect(await withinTheMinute(Promise.resolve("answered"), new AbortController().signal)).toBe("answered");
  }, 1_000);

  test("the running turn's steps: the newest kept within the budget, in the order they happened", () => {
    const call = (i: number) => ({ message: { role: "assistant" as const, content: "", toolCalls: [{ id: `c${i}`, name: "read", arguments: { path: `f${i}`, pad: "x".repeat(200) } }] } });
    const steps = stepsOf(Array.from({ length: 60 }, (_, i) => call(i)));
    expect(steps.length).toBeLessThanOrEqual(6_000);
    expect(steps).toContain("f59");
    expect(steps).not.toContain('"f0"');
    expect(steps.indexOf("f58")).toBeLessThan(steps.indexOf("f59"));
  });
});
