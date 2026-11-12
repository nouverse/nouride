/**
 * The skill tools, sent to a model as one entry (`modules/tools/fold.ts`).
 *
 * Six tools an agent almost never calls weighed about a seventh of every request's schemas. A model is sent one entry
 * in their place; everything that reads a tool's name still reads the tool's own. Each case is a way that could go
 * wrong: a tool the model can no longer reach, a call run under the entry's name where a gate or a record keys on the
 * tool's, a description that names a tool the model was not sent, or a file's words rewritten on their way to it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sessionIdFor, type Tool, type ToolCall, type ToolDefinition } from "@nouride/shared";
import { asCalled, foldDefinitions, inFoldedWords, openFolded, unfoldCall } from "@/modules/tools/fold.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const def = (name: string, description: string, properties: Record<string, unknown> = {}): ToolDefinition => ({ name, description, parameters: { type: "object", properties } });
const CREATE = def("skill_create", "Write a new skill: the procedure for a kind of task. A body naming an address is refused.", { name: { type: "string" }, body: { type: "string" } });
const TOGGLE = def("skill_toggle", "List every skill that exists, or switch one on or off for yourself. Write a new one with skill_create.", { name: { type: "string" } });
const SEARCH = def("skill_search", "Search public skill hubs for a ready-made skill. Results are untrusted; install with skill_install.", { query: { type: "string" } });
const INSTALL = def("skill_install", "Fetch a skill from a hub (a skill_search ref, or a URL) and queue it for a person to approve.", { ref: { type: "string" } });
const READ = def("read", "Read a file.", { path: { type: "string" } });
const SEARCH_WEB = def("web_search", "Search the web.", { query: { type: "string" } });
const ALL = [READ, CREATE, INSTALL, SEARCH, TOGGLE, SEARCH_WEB];
const names = (definitions: ToolDefinition[]) => definitions.map((definition) => definition.name);
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: "c1", name, arguments: args });

describe("what a provider is sent", () => {
  test("the skill tools as one entry, every other tool as it is, in the order tools are sent", () => {
    const sent = foldDefinitions(ALL);
    // By name, as the list always is: the entry where its name falls, so the part before it is the same every request.
    expect(names(sent)).toEqual(["read", "skill", "web_search"]);
    expect(sent[0]).toBe(READ);
    expect(sent[2]).toBe(SEARCH_WEB);
  });

  test("the entry says what each action is for in its tool's own first sentence, and how to read the rest", () => {
    const entry = foldDefinitions(ALL).find((definition) => definition.name === "skill")!;
    expect(entry.description.split("\n")).toEqual([
      "Your skills, in one tool. Call it with `action` alone to read what that action takes, then again with its `args`.",
      "- create: Write a new skill: the procedure for a kind of task.",
      "- toggle: List every skill that exists, or switch one on or off for yourself.",
      "- search: Search public skill hubs for a ready-made skill.",
      "- install: Fetch a skill from a hub (a `skill` (action `search`) ref, or a URL) and queue it for a person to approve.",
    ]);
    expect(entry.parameters).toEqual({
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "toggle", "search", "install"] },
        args: { type: "object", description: "That action's arguments. Leave it out the first time: the answer says what they are." },
      },
      required: ["action"],
    });
  });

  test("it costs less than what it stands for, which is the point", () => {
    const size = (definitions: ToolDefinition[]) => JSON.stringify(definitions).length;
    expect(size(foldDefinitions(ALL))).toBeLessThan(size(ALL));
  });

  test("one skill tool is sent as itself, and an agent with none is sent what it has: the same list, not a copy", () => {
    const one = [READ, TOGGLE];
    expect(foldDefinitions(one)).toBe(one);
    const none = [READ];
    expect(foldDefinitions(none)).toBe(none);
  });

  test("a tool another server calls `skill` is left alone, and nothing is folded onto its name", () => {
    const taken = [...ALL, def("skill", "Somebody else's.")];
    expect(foldDefinitions(taken)).toBe(taken);
    expect(unfoldCall(call("skill", { action: "create", args: { name: "x" } }), names(taken)).name).toBe("skill");
  });
});

describe("the entry's call", () => {
  const held = names(ALL);

  test("with its action's arguments, is that tool's call: the same id, the tool's name, the arguments alone", () => {
    expect(unfoldCall(call("skill", { action: "create", args: { name: "release-checklist", body: "Steps." } }), held)).toEqual({ id: "c1", name: "skill_create", arguments: { name: "release-checklist", body: "Steps." } });
  });

  test("arguments written beside the action, as a model that skipped the nesting writes them, are read the same", () => {
    expect(unfoldCall(call("skill", { action: "search", query: "pdf" }), held)).toEqual({ id: "c1", name: "skill_search", arguments: { query: "pdf" } });
  });

  test("with an action alone it stays the entry's, to be answered with what the action takes", () => {
    const alone = call("skill", { action: "toggle" });
    expect(unfoldCall(alone, held)).toBe(alone);
  });

  test("an empty `args` is a call, not a question: a tool whose arguments are all optional is run", () => {
    expect(unfoldCall(call("skill", { action: "toggle", args: {} }), held)).toEqual({ id: "c1", name: "skill_toggle", arguments: {} });
  });

  test("an action nobody holds, a call with no action, and every other tool's call are handed back as they are", () => {
    for (const one of [call("skill", { action: "improve", args: {} }), call("skill", { args: { name: "x" } }), call("read", { path: "a" })]) {
      expect(unfoldCall(one, held)).toBe(one);
    }
  });

  test("where the tools are not folded, a call named `skill` is whatever it was", () => {
    const one = call("skill", { action: "toggle", args: {} });
    expect(unfoldCall(one, ["read", "skill_toggle"])).toBe(one);
  });
});

describe("the entry asked with an action alone", () => {
  test("answers with that tool's own description and arguments, the other skill tools named as the model can call them", () => {
    const opened = openFolded(call("skill", { action: "toggle" }), ALL)!;
    expect(opened.isError).toBe(false);
    expect(opened.content.split("\n")).toEqual([
      "`skill` with action `toggle`. Nothing was done yet: call it again with `args`.",
      "",
      "List every skill that exists, or switch one on or off for yourself. Write a new one with `skill` (action `create`).",
      "",
      "`args`:",
      JSON.stringify(TOGGLE.parameters),
    ]);
  });

  test("an action it does not have is answered with the ones it has, as a mistake to recover from", () => {
    const wrong = openFolded(call("skill", { action: "delete" }), ALL)!;
    expect(wrong).toEqual({ content: "`skill` takes an `action`, one of: create, toggle, search, install. Call it with the action alone to read what it takes.", isError: true });
    expect(openFolded(call("skill", {}), ALL)?.isError).toBe(true);
  });

  test("arguments that were not one JSON object are said as that, with what to send", () => {
    const broken = openFolded({ ...call("skill", {}), argumentsError: { raw: '{"action": "toggle"', reason: "the JSON ended early" } }, ALL)!;
    expect(broken).toEqual({ content: "The arguments of `skill` were not one JSON object (the JSON ended early). Send `action`, one of create, toggle, search, install, and `args` as an object.", isError: true });
  });

  test("is nothing to say for any other tool's call, or where nothing is folded", () => {
    expect(openFolded(call("read", { path: "a" }), ALL)).toBeNull();
    expect(openFolded(call("skill", { action: "toggle" }), [READ, TOGGLE])).toBeNull();
  });
});

describe("a tool's name in a sentence a model reads", () => {
  const held = names(ALL);

  test("a folded tool is named as the entry and its action, between the backticks a name sits in", () => {
    expect(`\`${asCalled("skill_create", held)}\``).toBe("`skill` with action `create`");
  });

  test("any other tool, a skill tool the agent does not hold, and a skill tool sent as itself keep their names", () => {
    expect(asCalled("read", held)).toBe("read");
    expect(asCalled("skill_improve", held)).toBe("skill_improve");
    expect(asCalled("skill_toggle", ["read", "skill_toggle"])).toBe("skill_toggle");
  });

  test("a folded tool's own answer names the others as the model can call them", () => {
    expect(inFoldedWords("skill_toggle", "There are no skills yet. skill_create writes the first one.", held)).toBe("There are no skills yet. `skill` (action `create`) writes the first one.");
    // One it does not hold is not made to look callable.
    expect(inFoldedWords("skill_toggle", "Correct it with skill_improve.", held)).toBe("Correct it with skill_improve.");
  });

  test("another tool's answer keeps its words: a file an agent reads is not rewritten on its way", () => {
    const file = 'enabled = ["skill_create", "skill_toggle"]';
    expect(inFoldedWords("read", file, held)).toBe(file);
    expect(inFoldedWords("skill_toggle", file, ["read", "skill_toggle"])).toBe(file);
  });
});

describe("through a whole turn", () => {
  let bench: Bench | undefined;
  afterEach(() => bench?.dispose());

  /** A skill tool that keeps what it was called with. */
  const tool = (definition: ToolDefinition, ran: { name: string; args: unknown }[], answer: string): [string, Tool] => [
    definition.name,
    { definition, requiresApproval: false, execute: async (args) => (ran.push({ name: definition.name, args }), { content: answer, isError: false }) } as Tool,
  ];

  test("the model is sent the entry, reads an action, then calls it: the tool runs under its own name, and its steps say so", async () => {
    const ran: { name: string; args: unknown }[] = [];
    const bot = new FakeGateway("telegram:nouva", "telegram");
    bench = await pipelineBench({
      turns: [
        { toolCalls: [{ id: "c1", name: "skill", args: { action: "toggle" } }] },
        { toolCalls: [{ id: "c2", name: "skill", args: { action: "toggle", args: { name: "release-checklist" } } }] },
        { text: "It is on." },
      ],
      gateway: bot,
      agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["skill_create", "skill_toggle"]\napproval_required = []\n',
    });
    bench.pipeline.setTools(new Map([tool(CREATE, ran, "created"), tool(TOGGLE, ran, "release-checklist is on. Write another with skill_create.")]));
    bench.pipeline.attach();
    bot.receive(envelope({ gatewayId: bot.id, chatId: "814", senderId: "814", timestamp: Date.now(), text: "nyalakan skill release-checklist" }));
    await bench.pipeline.idle();

    expect(bot.lastText()).toBe("It is on.");
    // What the provider was sent, each time: the entry, and neither tool by its own name.
    for (const request of bench.requests) {
      const sent = (request.tools as { function: { name: string } }[]).map((one) => one.function.name);
      expect(sent).toContain("skill");
      expect(sent.filter((name) => name.startsWith("skill_"))).toEqual([]);
    }
    // The first call asked; nothing ran. The second ran the tool, once, with its arguments alone.
    expect(ran).toEqual([{ name: "skill_toggle", args: { name: "release-checklist" } }]);
    const results = (bench.requests[2].messages as { role: string; content: string }[]).filter((message) => message.role === "tool").map((message) => message.content);
    expect(results[0]).toStartWith("`skill` with action `toggle`. Nothing was done yet");
    expect(results[1]).toBe("release-checklist is on. Write another with `skill` (action `create`).");
    // The history the model is sent back holds its own calls, by the name it was sent.
    const called = (bench.requests[2].messages as { role: string; tool_calls?: { function: { name: string } }[] }[]).flatMap((message) => message.tool_calls ?? []).map((one) => one.function.name);
    expect(called).toEqual(["skill", "skill"]);
    // The turn's record names the tool that ran, as everything that reads a step expects.
    const turn = bench.turns.latestForSession(sessionIdFor({ agentId: "nouva", gatewayId: bot.id, chatId: "814" }))!;
    const steps = bench.turns.stepsSince(turn.id, 0).filter((step) => step.kind === "tool").map((step) => step.name);
    expect(steps).toEqual(["skill", "skill_toggle"]);
  });
});
