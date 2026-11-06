/**
 * Two habits the harness asks for in a chat: say one sentence before long work, and check before saying "done".
 *
 * Both from live turns. A WhatsApp group waited eight minutes through a fifteen-step turn with no message at all — the
 * daemon now sends the words the model writes beside its first tool call (`pipeline/preamble.ts`), so the prompt has
 * to ask for them. And an agent said "updated" when copying an edited workbook back to a Windows laptop had failed on
 * a quote in the path.
 */

import { describe, expect, test } from "bun:test";
import { renderLimits } from "@/modules/llm/prompt/harness-limits.ts";
import { renderVerify } from "@/modules/llm/prompt/harness-verify.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";

function view(toolNames: string[], harness: Record<string, unknown> = {}): HarnessView {
  return { ctx: { harness }, toolNames, gated: [], free: toolNames } as unknown as HarnessView;
}

const limits = (names: string[], harness?: Record<string, unknown>) => renderLimits(view(names, harness)).join("\n");
const verify = (names: string[]) => renderVerify(view(names)).join("\n");

describe("the opening line before long work", () => {
  test("is asked for, in the person's language, beside the first tool call", () => {
    const out = limits(["exec", "read"]);
    expect(out).toContain("When a request will take several steps, start your first reply with one short sentence saying what you are about to do");
    expect(out).toContain("in the person's language, in the same reply as your first tool call");
    // Sent at once, so it must not come back in the answer.
    expect(out).toContain("Do not repeat it in your final answer");
    expect(out).toContain("A plain question you answer at once needs no such line");
    expect(out).toContain("an occasional one-line status");
  });

  test("is not asked of a helper, which nobody is waiting on", () => {
    expect(limits(["exec"], { helper: true })).not.toContain("start your first reply with one short sentence");
  });

  test("nor of an agent with no tools, whose every reply is an answer", () => {
    expect(limits([])).not.toContain("start your first reply with one short sentence");
  });
});

describe("done means checked", () => {
  test("a change is read back before it is called done", () => {
    const out = verify(["exec", "read"]);
    expect(out).toContain("Before you say a change is done (a file written or copied, a cell set, a service restarted, a message sent elsewhere), read it back or check its effect");
    expect(out).toContain("If you could not check, say so.");
  });

  test("and is not said to an agent that can look at nothing", () => {
    expect(verify(["web_search"])).not.toContain("Before you say a change is done");
  });
});
