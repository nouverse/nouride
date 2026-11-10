/**
 * Asking another *permanent* agent, as opposed to spawning a blank one.
 *
 * `delegate.test.ts` covers the other half of the pair. What is proved here is the part a person
 * would notice if it broke: the peer's answer comes back to the *caller*, never into the chat, and a
 * wrong name is a recoverable mistake rather than a dead end — the tool answers with the agents that
 * do exist, because a model that is told only "no" retries the same word.
 */

import { describe, expect, test } from "bun:test";
import { announceDelegation } from "@/modules/pipeline/peer-turn.ts";
import type { ToolContext } from "@nouride/shared";
import { createAskAgentTool, peersFrom, type PeerTurnRequest } from "@/modules/tools/builtins/ask-agent.ts";
import { fakeAgent } from "../helpers.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";

/** What a peer turn hands back. The runner builds these with `buildHandoff`; a test states one. */
function handoff(over: Partial<SubAgentHandoff> = {}): SubAgentHandoff {
  return {
    agentId: "nox",
    status: "success",
    summary: "build fixed, PR is up",
    files: [],
    spills: [],
    metrics: { toolCalls: 3, steps: 2, ms: 17_000 },
    ...over,
  };
}

function ctx(): ToolContext {
  return {
    agentId: "nouva",
    sessionId: "ses_1",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u",
    chatType: "dm",
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    workspaceRoots: ["/tmp"],
    signal: new AbortController().signal,
  } as ToolContext;
}

const peers = () => ["nox", "nera"];

describe("ask_agent", () => {
  test("runs the named agent and hands its answer back to the caller", async () => {
    const seen: PeerTurnRequest[] = [];
    const tool = createAskAgentTool({
      peers,
      run: async (request) => {
        seen.push(request);
        return handoff({ files: ["/w/build.ts"] });
      },
    });

    const result = await tool.execute({ agent: "nox", task: "fix the build" }, ctx());

    expect(result.isError).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ to: "nox", from: "nouva", task: "fix the build" });
    // Named in the result, because the caller is about to relay this to a person and "somebody says
    // the build is fixed" is not a report.
    expect(result.content).toContain("nox");
    expect(result.content).toContain("build fixed, PR is up");
    expect(result.metadata).toMatchObject({ agent: "nox", status: "success", toolCalls: 3 });
    // The derived file list travels with it, so the audit row and the dashboard see what was touched.
    expect(result.metadata).toMatchObject({ files: ["/w/build.ts"] });
  });

  test("a name that is not an agent comes back with the ones that are", async () => {
    const tool = createAskAgentTool({ peers, run: async () => handoff() });

    const result = await tool.execute({ agent: "noxx", task: "fix the build" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("nox");
    expect(result.content).toContain("nera");
  });

  test("and with each one's capability line, so the next pick is by what they do", async () => {
    // The line OTHER AGENTS gives each peer (`describePeers`); a peer with none is still listed, by id.
    const tool = createAskAgentTool({
      peers,
      about: (ids) => {
        expect(ids).toEqual(["nox", "nera"]);
        return { nox: "Nox — Fixes the build and reviews pull requests" };
      },
      run: async () => handoff(),
    });

    const result = await tool.execute({ agent: "noxx", task: "fix the build" }, ctx());

    expect(result.content).toBe(
      'There is no agent called "noxx". Available:\n- nox: Nox — Fixes the build and reviews pull requests\n- nera',
    );
  });

  test("boot's peer list is the live registry's enabled agents, each with its OTHER AGENTS line", async () => {
    // `peersFrom` is what `boot/tools.ts` hands the tool: the wrong-name answer reads these, not bare ids.
    const nox = fakeAgent({ config: { id: "nox", displayName: "Nox" } as never, persona: { identity: "- **Headline:** Fixes the build" } as never });
    const nera = fakeAgent({ config: { id: "nera", displayName: "Nera" } as never });
    const off = fakeAgent({ config: { id: "off", displayName: "Off", enabled: false } as never });
    const all = [fakeAgent(), nox, nera, off];
    const registry = { enabled: () => all.filter((a) => a.config.enabled), get: (id: string) => all.find((a) => a.config.id === id) };
    let mentions = true;
    const tool = createAskAgentTool({ ...peersFrom(registry, () => mentions), run: async () => handoff() });

    const result = await tool.execute({ agent: "noxx", task: "fix the build" }, ctx());
    expect(result.content).toBe('There is no agent called "noxx". Available:\n- nox: Nox. Fixes the build\n- nera: Nera');

    mentions = false;
    expect((await tool.execute({ agent: "nox", task: "fix the build" }, ctx())).content).toBe('There is no agent called "nox". There are none.');
  });

  test("its description sends the model to OTHER AGENTS' lines to choose", () => {
    const tool = createAskAgentTool({ peers, run: async () => handoff() });
    const agent = (tool.definition.parameters as { properties: { agent: { description: string } } }).properties.agent;
    expect(agent.description).toBe(
      "The agent's id, exactly as OTHER AGENTS lists it beside its name and what it is for. Ask the one whose work it is.",
    );
  });

  test("a capitalised name still resolves", async () => {
    // The prompt lists ids; a model writing a sentence writes "Nox". Refusing that would be refusing
    // the spelling the model was always going to choose.
    const seen: string[] = [];
    const tool = createAskAgentTool({
      peers,
      run: async (request) => {
        seen.push(request.to);
        return handoff({ summary: "done" });
      },
    });

    const result = await tool.execute({ agent: "@Nox", task: "check the disk" }, ctx());

    expect(result.isError).toBe(false);
    // Resolved to the real id, not passed through as written.
    expect(seen).toEqual(["nox"]);
  });

  test("asking itself is refused, and said as its own mistake", async () => {
    let ran = false;
    const tool = createAskAgentTool({
      peers,
      run: async () => {
        ran = true;
        return handoff();
      },
    });

    const result = await tool.execute({ agent: "nouva", task: "do the thing" }, ctx());

    expect(result.isError).toBe(true);
    expect(ran).toBe(false);
  });

  test("a peer that fails is reported as a failure, by name", async () => {
    const tool = createAskAgentTool({
      peers,
      run: async () => handoff({ status: "failed", summary: "", reason: "nox is paused" }),
    });

    const result = await tool.execute({ agent: "nox", task: "fix the build" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("nox is paused");
  });

  test("a peer that says nothing is not reported as an answer", async () => {
    // The caller is about to tell a person what somebody else said. Silence has to arrive as silence,
    // or it gets narrated into an outcome that never happened.
    const tool = createAskAgentTool({
      peers,
      run: async () => handoff({ status: "incomplete", summary: "", reason: "it finished without saying anything" }),
    });

    const result = await tool.execute({ agent: "nox", task: "fix the build" }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("incomplete");
    expect(result.content).toContain("without saying anything");
  });
});

describe("ask_agent with one agent, as it always was", () => {
  test("the same arguments give the same result, word for word: models know it and stored transcripts hold it", async () => {
    const tool = createAskAgentTool({ peers, run: async () => handoff({ files: ["/w/build.ts"] }) });
    const result = await tool.execute({ agent: "nox", task: "fix the build" }, ctx());
    expect(result.content).toBe("[nox · success]\nbuild fixed, PR is up\n\nFiles it changed: /w/build.ts\n\n3 tool calls · 2 steps · 17s");
    expect(result.metadata).toEqual({ agent: "nox", status: "success", toolCalls: 3, files: ["/w/build.ts"] });
    // And each refusal as it was said.
    const said = async (args: Record<string, unknown>) => (await tool.execute(args, ctx())).content;
    expect(await said({ task: "fix the build" })).toBe("Name the agent to ask. Available: nox, nera.");
    expect(await said({ agent: "nouva", task: "fix the build" })).toBe("That is you. Do the work yourself, or ask a different agent.");
    expect(await said({ agent: "noxx", task: "fix the build" })).toBe('There is no agent called "noxx". Available: nox, nera.');
    expect(await said({ agent: "nox" })).toBe("Say what you want nox to do.");
    expect(await said({ agent: "nox", task: "x".repeat(4001) })).toBe("That task is 4001 characters; the limit is 4000. Send the essentials and let them ask.");
    expect(await said({ agent: "nox", task: "fix the build", tier: "huge" })).toContain("`tier` is one of");
  });

  test("`asks` written as nothing beside `agent` is the single call still, and `agent` written as nothing beside `asks` is several", async () => {
    // Some models write every parameter a schema has, the unused ones as null, "" or an empty list.
    const tool = createAskAgentTool({ peers, run: async (request) => handoff({ agentId: request.to }) });
    const single = (await tool.execute({ agent: "nox", task: "fix the build" }, ctx())).content;
    for (const asks of [null, []]) expect((await tool.execute({ agent: "nox", task: "fix the build", asks }, ctx())).content).toBe(single);
    const several = await tool.execute({ asks: [{ agent: "nox", task: "fix the build" }], agent: null, task: "" }, ctx());
    expect(several.content).toStartWith("── nox: fix the build\n[nox · success]");
    // Nothing of either shape: asked for the agent, as it always was.
    expect((await tool.execute({ asks: null }, ctx())).content).toBe("Name the agent to ask. Available: nox, nera.");
  });

  test("its schema still takes `agent` and `task`, and now `asks` beside them: neither is required, since one of the two is sent", () => {
    const { properties, required } = createAskAgentTool({ peers, run: async () => handoff() }).definition.parameters as { properties: Record<string, { description?: string }>; required?: string[] };
    expect(Object.keys(properties)).toEqual(["agent", "task", "asks", "tier"]);
    expect(required).toBeUndefined();
    expect(properties.asks!.description).toBe(
      "Several agents at once, in place of `agent` and `task`: up to 4, each with its own task. They work at the same time, and every answer comes back in this result under its agent.",
    );
  });
});

describe("ask_agent with several agents", () => {
  const BUILD = { agent: "nox", task: "fix the build" };
  const DOCS = { agent: "nera", task: "update the docs\nand the changelog" };

  test("every ask is started before any answers, and each answer comes back under its agent and its ask", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const tool = createAskAgentTool({
      peers,
      run: async (request) => {
        started.push(request.to);
        await held;
        return handoff({ agentId: request.to, summary: `${request.to} did it` });
      },
    });

    const pending = tool.execute({ asks: [BUILD, DOCS], tier: "small" }, ctx());
    // Both at work before either has answered: at the same time, not one after the other.
    expect(started).toEqual(["nox", "nera"]);
    release();
    const result = await pending;

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      "── nox: fix the build\n[nox · success]\nnox did it\n\n3 tool calls · 2 steps · 17s\n\n" +
        // The ask's first line names it: two asks of one agent are told apart by it.
        "── nera: update the docs\n[nera · success]\nnera did it\n\n3 tool calls · 2 steps · 17s",
    );
    expect(result.metadata).toEqual({ asks: 2, agents: ["nox", "nera"], failed: 0, statuses: ["success", "success"], toolCalls: 6 });
  });

  test("each ask carries the tier and its own task, as a single ask does", async () => {
    const seen: PeerTurnRequest[] = [];
    const tool = createAskAgentTool({ peers, run: async (request) => (seen.push(request), handoff({ agentId: request.to })) });
    await tool.execute({ asks: [BUILD, { agent: "@Nera", task: "  update the docs  " }], tier: "high" }, ctx());
    expect(seen.map((request) => [request.to, request.from, request.task, request.tier])).toEqual([
      ["nox", "nouva", "fix the build", "high"],
      ["nera", "nouva", "update the docs", "high"],
    ]);
  });

  test("one that throws, one that fails and one that is refused do not lose the answer that came", async () => {
    const tool = createAskAgentTool({
      peers: () => ["nox", "nera", "nero"],
      run: async (request) => {
        if (request.to === "nera") throw new Error("the provider hung up");
        if (request.to === "nero") return handoff({ agentId: "nero", status: "failed", summary: "", reason: "nero is disabled" });
        return handoff();
      },
    });

    const result = await tool.execute({ asks: [BUILD, DOCS, { agent: "nero", task: "count the incidents" }, { agent: "ghost", task: "anything" }] }, ctx());

    // Not an error: one answered, and that answer is whole.
    expect(result.isError).toBe(false);
    expect(result.content).toContain("── nox: fix the build\n[nox · success]\nbuild fixed, PR is up");
    expect(result.content).toContain("── nera: update the docs\n[nera · failed]\n(no report)\n\nthe provider hung up");
    expect(result.content).toContain("── nero: count the incidents\n[nero · failed]\n(no report)\n\nnero is disabled");
    expect(result.content).toContain('── ghost: anything\nNot asked: There is no agent called "ghost". Available: nox, nera, nero.');
    expect(result.metadata).toMatchObject({ asks: 4, failed: 3, statuses: ["success", "failed", "failed", "refused"] });
  });

  test("an error only when nobody answered", async () => {
    const tool = createAskAgentTool({ peers, run: async (request) => handoff({ agentId: request.to, status: "failed", summary: "", reason: "down" }) });
    expect((await tool.execute({ asks: [BUILD, DOCS] }, ctx())).isError).toBe(true);
    expect((await tool.execute({ asks: [BUILD, { agent: "nouva", task: "do it" }] }, ctx())).isError).toBe(true);
  });

  test("a list that is not one, both shapes at once, or more than four, is refused before anybody is asked", async () => {
    let ran = 0;
    const tool = createAskAgentTool({ peers, run: async () => ((ran += 1), handoff()) });
    const said = async (args: Record<string, unknown>) => {
      const result = await tool.execute(args, ctx());
      expect(result.isError).toBe(true);
      return result.content;
    };
    expect(await said({ asks: [] })).toBe("`asks` is a list of up to 4 asks, each an `agent` and its `task`.");
    expect(await said({ asks: "nox" })).toBe("`asks` is a list of up to 4 asks, each an `agent` and its `task`.");
    expect(await said({ asks: [BUILD], agent: "nera", task: "update the docs" })).toBe("Send `asks` for several agents, or `agent` and `task` for one: not both.");
    expect(await said({ asks: [BUILD, DOCS, BUILD, DOCS, BUILD] })).toBe("That is 5 asks; one call asks at most 4 agents. Send the rest in a second call.");
    expect(await said({ asks: [BUILD], tier: "huge" })).toContain("`tier` is one of");
    expect(ran).toBe(0);
    // An entry that is no ask at all is said in its place, and the one beside it still runs.
    const mixed = await tool.execute({ asks: ["nox", BUILD] }, ctx());
    expect(mixed.content).toStartWith("── (no agent named): \nNot asked: Name the agent to ask. Available: nox, nera.");
    expect(mixed.content).toContain("── nox: fix the build\n[nox · success]");
    expect(ran).toBe(1);
  });
});

/**
 * Whether the room hears about a handover.
 *
 * Until 2026-09-17 it never did. Every other thing that happens to a room was recorded — somebody
 * joined, the topic changed, a message was dropped, a chain hit its hop budget — and the one that
 * mattered most to the agents in it was not: that two of their peers were already working on
 * something. A third agent would answer as though nothing were in progress, or start the same work
 * again.
 */
describe("telling the room about a handover", () => {
  test("a room with other agents in it hears", () => {
    expect(announceDelegation("group", 3)).toBe(true);
    expect(announceDelegation("channel", 2)).toBe(true);
  });

  test("a one-to-one chat does not", () => {
    // The only agent who would read the line is the one that caused it, and a prompt telling an
    // agent what it just did is pure cost.
    expect(announceDelegation("dm", 2)).toBe(false);
    expect(announceDelegation("dm", 9)).toBe(false);
  });

  test("nor does a room holding one agent, or none", () => {
    /**
     * The condition that actually decides.
     *
     * `chatType` only says the platform allows more than two people — a Telegram group with one bot
     * in it is a `group`, and has exactly the same audience as a DM. Keying on the type alone would
     * put a line in that agent's own prompt on every handover it made.
     */
    expect(announceDelegation("group", 1)).toBe(false);
    expect(announceDelegation("group", 0)).toBe(false);
  });
});
