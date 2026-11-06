/**
 * The prompt and the sandbox must describe the same directories.
 *
 * They did not, and the consequence was not a refused call — it was a *successful* one in the wrong
 * place. The harness block told the agent it was working in its persona pack, the tools resolved
 * relative paths against the derived workspace, and a model that followed its instructions built the
 * operator's project next to `IDENTITY.md` and `MEMORY.md` in a git-tracked directory. Observed on a
 * real run: `agents/nouva/portfolio/server.js` existed and `data/workspace/` was empty.
 *
 * Nothing here refuses anything. The property under test is that two descriptions of one fact agree.
 */

import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, type HarnessFacts, type PromptContext } from "@/modules/llm/prompt/index.ts";
import { fakeAgent } from "../helpers.ts";

const AGENT_DIR = "/app/agents/nouva";
const WORKSPACE = "/app/data/workspace/nouva";

function promptWith(workspace: HarnessFacts["workspace"]): string {
  const ctx: PromptContext = {
    agent: fakeAgent({ dir: AGENT_DIR, persona: { identity: "# IDENTITY\n- Name: Nouva" } }),
    tools: [],
    harness: {
      approvalRequired: [],
      approvalAvailable: true,
      maxToolIterations: 25,
      maxTurnDurationMs: 300_000,
      commands: [],
      truncates: true,
      ...(workspace ? { workspace } : {}),
    },
    gateway: "web",
    chatId: "c",
    chatType: "dm",
    sessionId: "s",
    model: "m",
    now: new Date("2026-08-12T00:00:00Z"),
    timezone: "UTC",
  };
  return buildSystemPrompt(ctx).text;
}

describe("the workspace the prompt describes", () => {
  test("names the derived workspace, not the persona pack", () => {
    const text = promptWith({ dir: WORKSPACE, roots: [WORKSPACE, AGENT_DIR] });

    expect(text).toContain(`You are working in ${WORKSPACE}`);
    // The pack stays reachable — MEMORY.md lives there — but as an "also", never as the place new
    // work belongs.
    expect(text).toContain(AGENT_DIR);
    expect(text).not.toContain(`You are working in ${AGENT_DIR}`);
  });

  test("the working directory is not repeated in the also-readable list", () => {
    // "You are working in X. You may also write under X" reads as two places and invites the model to
    // pick the absolute one — which is how the project ended up in the pack.
    const text = promptWith({ dir: WORKSPACE, roots: [WORKSPACE, AGENT_DIR] });
    const alsoLine = text.split("\n").find((l) => l.includes("You may also")) ?? "";

    expect(alsoLine).toContain(AGENT_DIR);
    expect(alsoLine).not.toContain(WORKSPACE);
  });

  test("an agent with no derived workspace falls back to its pack without claiming two", () => {
    const text = promptWith({ dir: AGENT_DIR, roots: [AGENT_DIR] });
    expect(text).toContain(`You are working in ${AGENT_DIR}`);
    expect(text).not.toContain("You may also");
  });
});

describe("shared and private, as the agent is told them", () => {
  const SHARED = "/app/.nouride/workspace/shared";
  const OWN = "/app/.nouride/workspace/private/nouva";

  const withBoth = () =>
    promptWith({ dir: SHARED, privateDir: OWN, roots: [SHARED, OWN, AGENT_DIR] });

  test("the shared directory is the working directory", () => {
    // Not merely reachable. Whichever one a relative path resolves to is where work lands, and work
    // that lands in a private directory cannot be handed to anyone.
    expect(withBoth()).toContain(`You are working in ${SHARED}`);
    expect(withBoth()).not.toContain(`You are working in ${OWN}`);
  });

  test("it says what the shared directory is for, not just that it exists", () => {
    // A model told "you may also write to X" picks whichever path reads best in the sentence it is
    // writing. Told that leaving a file there is how another agent picks work up, it has a reason.
    const text = withBoth();
    expect(text).toContain("shared with the other agents");
    expect(text).toMatch(/handed over|hand.*over/i);
  });

  test("the private directory is named as the agent's own", () => {
    const text = withBoth();
    expect(text).toContain(`${OWN} is yours alone`);
    expect(text).toContain("no other agent can read it");
  });

  test("neither is repeated in the also-readable list", () => {
    // The pack belongs there; the two workspace directories have already been described, and naming
    // them twice is what taught the model to reach for the absolute spelling.
    const alsoLine = withBoth().split("\n").find((l) => l.includes("You may also")) ?? "";

    expect(alsoLine).toContain(AGENT_DIR);
    expect(alsoLine).not.toContain(SHARED);
    expect(alsoLine).not.toContain(OWN);
  });

  test("a single-agent install is told nothing about sharing", () => {
    // With no private directory there is no distinction to draw, and describing one would have the
    // agent reasoning about handover in an install where there is nobody to hand to.
    const text = promptWith({ dir: SHARED, roots: [SHARED, AGENT_DIR] });

    expect(text).toContain(`You are working in ${SHARED}`);
    expect(text).not.toContain("shared with the other agents");
    expect(text).not.toContain("yours alone");
  });
});
