/**
 * What an agent in a room is *told* about a file, and what it is given to open one with.
 *
 * The bug this closes was reported from a live dashboard room, and the agent's own account of it was
 * correct: asked whether it could look at a photo another agent had sent, Nouva answered that it
 * only receives a text transcript of the conversation. It did. A file was fetched and read by the
 * one agent a message addressed, during that turn, as a description written before anyone had asked a
 * question about it — and everything else about the file was gone.
 *
 * So the properties worth pinning are about the *prompt* and the *toolset*, not about the store:
 *
 *   - a file that arrived while this agent was not being addressed is named in its next prompt
 *   - it is named and not read, because reading is a model call and most files are never asked about
 *   - it is announced once, like the room's chatter and its events, rather than on every turn after
 *   - the call to open it is in the schema of a pack that enumerates its tools and never listed it
 *
 * That last one is the `ask_agent` lesson repeated: a prompt that tells an agent it can open the
 * photo, and a schema without the call, spends the model's reasoning looking for a tool that is not
 * there.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Tool, ToolContext } from "@nouride/shared";
import { ChatAttachmentIndex } from "@/modules/attachments/chat-attachments.store.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { createAttachmentReadTool } from "@/modules/tools/builtins/attachment.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { sleep } from "../wait.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

async function room(options: { turns: { text?: string }[] }) {
  const local = new LocalGateway();
  let attachmentIndex!: ChatAttachmentIndex;
  bench = await pipelineBench({
    turns: options.turns,
    // Enumerated, deliberately — every real pack here does, and that is what made `ask_agent`
    // reachable from the prompt and absent from the schema.
    agents: ["nouva", "nox"],
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["read", "glob"]\n',
    config: { agents: { mentions_enabled: true, mention_max_hops: 2, groups_require_mention: true } },
    gateways: [local],
    deps: ({ db }) => ({ attachmentIndex: (attachmentIndex = new ChatAttachmentIndex(db)) }),
  });
  const { pipeline, requests } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();

  return {
    attachmentIndex,
    local,
    pipeline,
    requests,
    /** A file put into the room by somebody else, the way `send_file` and the intake both do. */
    fileArrives(over: Record<string, unknown> = {}): string {
      return (
        attachmentIndex.register({
          key: `msg-${Math.random()}`,
          gateway: "web",
          chatId: "room-1",
          gatewayId: "web:dashboard",
          name: "dog.jpg",
          mimeType: "image/jpeg",
          kind: "image",
          size: 240_000,
          fromAgent: "nox",
          at: Date.now(),
          ...over,
        }) ?? ""
      );
    },
    async say(text: string) {
      local.dispatch({ text, chatId: "room-1", chatType: "group" });
      await pipeline.idle();
    },
    lastPrompt(): string {
      return JSON.stringify(requests.at(-1));
    },
  };
}

describe("a file in the conversation is never mentioned unprompted", () => {
  /**
   * The contract, after it was got wrong twice.
   *
   * The first version described files in the prompt — a list of what had arrived, with refs, and a
   * sentence inviting the agent to open a relevant one. That is not "read it when I tell you to", and
   * it did exactly what the wording invited: reported from a phone, the agent's first act after a
   * `/reset` was `attachment_read` on a screenshot from a previous conversation. The second version
   * bounded the window to fifteen minutes, which made the bug rarer rather than wrong.
   *
   * So the prompt says nothing about files at all. The agent has `attachment_read`, its description
   * says calling it with no arguments lists what is in the conversation, and that is the whole
   * mechanism: somebody asks, the agent looks. Nothing is announced, nothing is read unasked, and
   * the block costs no tokens on any turn.
   */
  test("a file another agent just sent is not named in the prompt", async () => {
    const h = await room({ turns: [{ text: "sure" }] });
    const ref = h.fileArrives({ name: "DOG-PHOTO.png" });

    await h.say("@nouva halo");

    expect(h.lastPrompt()).not.toContain("DOG-PHOTO.png");
    expect(h.lastPrompt()).not.toContain(ref);
  });

  test("nor after an exchange, when a window would have covered it", async () => {
    // The case the old block was built for: a file that arrived between two messages. Still silent.
    const h = await room({ turns: [{ text: "one" }, { text: "two" }] });

    await h.say("@nouva pertama");
    await sleep(5);
    const ref = h.fileArrives({ name: "BETWEEN.png" });
    await sleep(5);
    await h.say("@nouva kedua");

    expect(h.lastPrompt()).not.toContain("BETWEEN.png");
    expect(h.lastPrompt()).not.toContain(ref);
  });

  test("nor an old one after a reset — the report that started this", async () => {
    const h = await room({ turns: [{ text: "sure" }] });
    h.fileArrives({ name: "OLD-SCREENSHOT.png", at: Date.now() - 3 * 86_400_000 });

    await h.say("@nouva apa kabar");

    expect(h.lastPrompt()).not.toContain("OLD-SCREENSHOT.png");
  });

  test("the file that came *with* the message is still described, and that is different", async () => {
    /**
     * Sending a screenshot with a question is the instruction. That path is the attachment intake,
     * it predates all of this, and it is the one place a file is read without a separate ask —
     * because answering "what does this error say?" should not cost a tool iteration to discover the
     * screenshot exists.
     *
     * Asserted here so the two cannot be confused by a later change: what went is the *announcement*
     * of files nobody mentioned, not the reading of a file somebody attached.
     */
    const h = await room({ turns: [{ text: "sure" }] });

    await h.say("@nouva halo");

    // No attachment on this message, so no notice either — the notice is per message, never a list.
    expect(h.lastPrompt()).not.toContain("came with this message");
  });
});

describe("the call that opens one", () => {
  const security = { toolTimeoutMs: 1000, toolMaxOutputBytes: 1024 } as never;

  const reader = () =>
    createAttachmentReadTool({
      find: () => null,
      list: () => [],
      open: async () => ({ error: "not in this test" }),
      describe: async () => ({ error: "not in this test" }),
      imageMode: () => "native" as const,
      listen: async () => ({ ok: false, reason: "not_advertised" }) as const,
      watch: async () => ({ media: [], lines: [] }),
    });

  test("is in the schema of a pack that enumerates its tools and never listed it", () => {
    /**
     * The `ask_agent` lesson, and the reason this tool follows the daemon rather than the pack.
     *
     * Every real pack here writes out `[tools] enabled`, so a tool that arrives only through
     * `DEFAULT_TOOLS` reaches none of them — and the failure is not an error. The prompt tells the
     * agent it can open the photo, the schema does not carry the call, and the model spends its
     * reasoning looking for something that is not there before settling for a worse answer.
     *
     * It withholds nothing to add it: a file that comes *with* a message is fetched, stored and
     * described to the agent with no tool entry consulted anywhere. This changes when a file is
     * read, not whether.
     */
    const agent = fakeAgent({
      config: { tools: { enabled: ["read", "glob"], approvalRequired: [], blocked: [] } } as never,
    });
    const registry = new Map<string, Tool>([["attachment_read", reader()]]);

    const toolset = resolveToolset(agent, registry, security);

    expect(toolset.definitions.map((definition) => definition.name)).toContain("attachment_read");
  });

  test("is withdrawn when the daemon cannot serve it", () => {
    // A daemon with no attachment index does not build the tool, and then it must not appear — a
    // tool in the schema is a promise the model will try to keep.
    const agent = fakeAgent({
      config: { tools: { enabled: ["attachment_read"], approvalRequired: [], blocked: [] } } as never,
    });

    const toolset = resolveToolset(agent, new Map(), security);

    expect(toolset.definitions.map((definition) => definition.name)).not.toContain("attachment_read");
  });

  test("runs without an approval, like the description it replaces", () => {
    const agent = fakeAgent({
      config: { tools: { enabled: [], approvalRequired: [], blocked: [] } } as never,
    });
    const registry = new Map<string, Tool>([["attachment_read", reader()]]);

    const toolset = resolveToolset(agent, registry, security);

    expect(toolset.gate("attachment_read", {}, { agentId: "nouva" } as ToolContext).action).toBe("run");
  });
});
