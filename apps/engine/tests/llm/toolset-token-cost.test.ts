/**
 * The same sentence must not be paid for twice in one request.
 *
 * Two tools had their guidance written out in full in *both* the tool description and the harness
 * line that names them, in wording close enough to be obviously one thought copied. That is not free.
 * The harness has its own cacheable block now (`Stability = "capability"`), and Anthropic renders
 * `tools` before `system`, so on that path both copies fall inside a cached prefix and are billed at a
 * tenth after the first request. That is cheaper, not free: the OpenAI path this install uses has only
 * implicit prefix matching, and the *window* is spent at full size on both paths regardless of price.
 * Both copies are re-sent on every request of every tool iteration.
 *
 * Which copy survives is not arbitrary. The harness line is what the model reads *before* it has
 * chosen a tool, and this repo has its own evidence for that mattering: `delegate` sat in six live
 * agents' configs and was called zero times in 2,225 executions until a harness line was written for
 * it. So the harness keeps the guidance, and the description keeps only what the harness does not
 * say — the parameters, and the refusals particular to this tool.
 *
 * Every tool below has a harness line gated on *itself alone*, so the two are always present together
 * and there is no toolset where trimming the description loses the advice. `session` and `web_search`
 * are deliberately absent from this test: their harness lines also require `exec`, so an agent with
 * one and not the other would be left with neither copy.
 */

import { describe, expect, test } from "bun:test";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";
import { createDelegateTool } from "@/modules/tools/builtins/delegate.ts";
import { createSendFileTool } from "@/modules/tools/builtins/attach.ts";

const TOOLS = {
  delegate: createDelegateTool({ run: async () => ({}) } as never),
  send_file: createSendFileTool({} as never),
};

/** The harness block an agent gets when it has exactly this one tool. */
function harnessFor(name: string): string {
  return renderTools({
    // A limit for background helpers, so `delegate`'s whole harness is there to compare with.
    ctx: { harness: { maxToolIterations: 8, approvalAvailable: true, backgroundHelpers: 2 } },
    toolNames: [name],
    gated: [],
    free: [name],
  } as never).join("\n");
}

/**
 * Phrases that were in both places. Each must now survive in the harness and be gone from the
 * description — asserted in both directions, because deleting it from *both* would also make a
 * "appears once" check pass while quietly dropping the guidance.
 */
const DEDUPED: [keyof typeof TOOLS, string[]][] = [
  ["delegate", ["Several independent questions you need before you can answer", "**A helper in the background**", "costs less than a helper that starts confused"]],
  ["send_file", ["a log, a report, a diff, an image, an archive"]],
];

describe("guidance lives in the harness, not in both places", () => {
  for (const [name, phrases] of DEDUPED) {
    test(`${name} does not restate its harness line`, () => {
      const harness = harnessFor(name);
      const description = TOOLS[name].definition.description;

      for (const phrase of phrases) {
        expect(harness).toContain(phrase);
        expect(description).not.toContain(phrase);
      }
    });
  }

  test("what each description still has to carry itself", () => {
    // The half the harness never says. Trimming further would cost the model something real.
    expect(TOOLS.send_file.definition.description).toContain("Never invent a URL from memory");
    expect(TOOLS.delegate.definition.description).toContain("no memory of this conversation");
  });
});

/**
 * Tool or CLI, as a test rather than only as prose.
 *
 * The rule: a capability is a tool when an argument is a document, or
 * when it means "the one in front of me" — otherwise it is a CLI verb the agent reaches through
 * `nouride`. It was re-argued from scratch four times before it was written down, so it gets an
 * assertion too.
 */

describe("the tools that take a list are named by what the agent holds", () => {
  const block = (toolNames: string[]) =>
    renderTools({
      ctx: { harness: { maxToolIterations: 8, approvalAvailable: true } },
      toolNames,
      gated: [],
      free: toolNames,
    } as never).join("\n");

  test("every list-shaped tool the agent has is in the line, and none it lacks", () => {
    const all = block(["read", "grep", "web_fetch"]);
    expect(all).toContain("Three of these take a list");
    expect(all).toContain("`web_fetch` accepts `urls`");

    const fetchOnly = block(["web_fetch"]);
    expect(fetchOnly).toContain("One of these takes a list");
    expect(fetchOnly).not.toContain("`read` accepts");
  });

  test("an agent with none of them gets no line", () => {
    expect(block(["exec"])).not.toContain("take a list");
  });
});

describe("web research is batched", () => {
  const block = (toolNames: string[]) =>
    renderTools({
      ctx: { harness: { maxToolIterations: 8, approvalAvailable: true } },
      toolNames,
      gated: [],
      free: toolNames,
    } as never).join("\n");

  test("an agent that can fetch is told to read several pages in one call, never one per reply", () => {
    const text = block(["web_fetch", "web_search"]);
    expect(text).toContain("Web research goes in batches, never one page per reply");
    expect(text).toContain("ONE `web_fetch` with `urls`");
    expect(text).toContain("ONE `web_search` with `queries`");
  });

  test("the search half is only said to an agent that can search", () => {
    const text = block(["web_fetch"]);
    expect(text).toContain("Web research goes in batches");
    expect(text).not.toContain("`queries`");
  });

  test("an agent that cannot fetch hears nothing about it", () => {
    expect(block(["read"])).not.toContain("Web research");
  });
});

describe("several changes to one file", () => {
  const block = (toolNames: string[]) =>
    renderTools({
      ctx: { harness: { maxToolIterations: 8, approvalAvailable: true } },
      toolNames,
      gated: [],
      free: toolNames,
    } as never).join("\n");

  test("an agent with multi_edit is told to use it for more than one change", () => {
    expect(block(["edit", "multi_edit"])).toContain("More than one change to a file goes in ONE `multi_edit`");
  });

  test("an agent without it is not told about it", () => {
    expect(block(["edit"])).not.toContain("multi_edit");
  });

  test("edit's own description sends a second change there too — it is read when the tool is chosen", async () => {
    const { editTool } = await import("@/modules/tools/builtins/files.ts");
    expect(editTool.definition.description).toContain("use `multi_edit` instead");
  });
});
