/**
 * What the built-in tools are handed of the pipeline — the part `boot/tools.ts` and the missions reach: each a closure
 * scoped inside to the turn that calls it, never the gateway map, the attachment store or the turn context itself, so
 * a tool cannot widen what it reaches. `send_file`, `send_message`, a line into the chat, `attachment_read`,
 * `session_status`, `delegate` and `ask_agent`.
 */

import { readFileBytes } from "@nouride/runtime";
import type { Attachment, ToolContext } from "@nouride/shared";
import type { ModelOverrides } from "@/modules/hooks/registry.ts";
import type { SessionStatus } from "@/modules/tools/registry.ts";
import type { BackgroundStart, SubagentRequest, SubagentResult } from "@/modules/tools/builtins/delegate.ts";
import type { AskStart, PeerTurnRequest, PeerTurnResult } from "@/modules/tools/builtins/ask-agent.ts";
import type { MovableRun } from "@/modules/tools/builtins/wait-then-move.ts";
import type { AttachmentReadOptions, OpenedAttachment } from "@/modules/tools/builtins/attachment.ts";
import type { SendMessageOptions } from "@/modules/tools/builtins/send-message.ts";
import type { ChatAttachment } from "@/modules/attachments/chat-attachments.store.ts";
import { isStored } from "@/modules/attachments/store.ts";
import type { PipelineDeps } from "./deps.ts";
import type { AttachmentIntake } from "./attachments.ts";
import type { ChatTypes } from "./chat-types.ts";
import type { TurnContext, SendAttachmentResult } from "./turn-context.ts";
import { attachmentReadOptions } from "./attachment-reader.ts";
import type { RoomSources } from "./known-rooms.ts";
import { postMessage, sendTargets, tellChat } from "./send-message.ts";
import { runSubagent } from "./subagent.ts";
import { startBackgroundHelper, startWaitedHelper } from "./background-helper.ts";
import { runPeerTurn } from "./peer-turn.ts";
import { startAsk } from "./background-ask.ts";

export class ToolPorts {
  constructor(
    private readonly o: {
      deps: RoomSources & Pick<PipelineDeps, "attachments" | "attachmentIndex" | "registry" | "providers" | "usage">;
      turnContext: TurnContext;
      intake: AttachmentIntake;
      chatTypes: Pick<ChatTypes, "of">;
      modelOverrides: Pick<ModelOverrides, "get">;
    },
  ) {}

  /**
   * Put a file on the wire, for `send_file`.
   *
   * A closure rather than the gateway map, for the same reason `startJob` and the cron executors are
   * closures: a tool holding the gateway map could send anywhere, to any conversation.
   */
  async sendAttachment(ctx: ToolContext, attachment: Attachment): Promise<SendAttachmentResult> {
    return await this.o.turnContext.sendAttachment(ctx, attachment);
  }

  /**
   * `send_message`'s two closures, each scoped inside to the agent the call is from: the chats it can reach, and the
   * send — never the gateway map, for the reason `sendAttachment` is a closure.
   */
  messageSender(): SendMessageOptions {
    return {
      targets: (ctx) => sendTargets(this.o.deps, ctx.agentId, this.o.chatTypes),
      post: (ctx, chat, text) => postMessage(this.o.turnContext, ctx, chat, text),
    };
  }

  /** A line from the daemon into the chat a tool call came from (`send-message.ts`). */
  chatNotice(): (ctx: ToolContext, text: string) => Promise<boolean> {
    return (ctx, text) => tellChat(this.o.turnContext, ctx, text);
  }

  /**
   * Exposed so the tool registry can build `attachment_read` without reaching into the pipeline.
   *
   * Four closures rather than the index and the store, per the rule `boot/tools.ts` is built on: a
   * tool holding the index could list any conversation's files, and one holding the attachment store
   * could open any of them. Each of these is scoped to the conversation the calling turn is in,
   * inside the closure, where the tool cannot widen it.
   *
   * `undefined` when this daemon has no attachment index — then the tool is not offered at all,
   * rather than offered and answering "nothing is configured", which teaches a model to stop asking.
   */
  attachmentReader(): AttachmentReadOptions | undefined {
    const index = this.o.deps.attachmentIndex;
    if (!index) return undefined;

    return attachmentReadOptions({
      deps: this.o.deps,
      index,
      intake: this.o.intake,
      open: (ctx, file) => this.openAttachment(ctx, file),
      status: (ctx) => this.sessionStatus(ctx),
    });
  }

  /**
   * The bytes of one indexed file: the durable copy, or a fetch that becomes one.
   *
   * The path in the index is a hint and is verified, never trusted — a row can outlive the file it
   * points at, because the attachment retention window and the index's are different numbers. So a
   * missing file is not a failure here; it is a reason to go back to the platform.
   *
   * The fetch is attempted on the connection that *saw* the file first, because a handle is not
   * always portable: a Telegram `file_id` is scoped to the bot it was issued to, and another bot on
   * the same chat cannot resolve it. The caller's own connection is the fallback, which is what makes
   * this work on Discord, where the handle is a URL anybody may fetch.
   */
  private async openAttachment(ctx: ToolContext, file: ChatAttachment): Promise<OpenedAttachment> {
    if (file.localPath) {
      const bytes = await readFileBytes(file.localPath).catch(() => null);
      if (bytes) return { bytes, path: file.localPath };
    }

    const store = this.o.deps.attachments;
    if (!store || !file.handle) {
      return { error: "there is no local copy and no way to fetch it again" };
    }

    const gateway =
      this.o.deps.gateways.get(file.gatewayId) ?? this.o.deps.gateways.get(ctx.gatewayId);
    const fetcher = gateway?.fetchAttachment?.bind(gateway);
    if (!fetcher) return { error: "the connection it arrived on cannot retrieve files" };

    /**
     * Stored under the *reading* agent, in this conversation's directory.
     *
     * Not a shared pool: the copy belongs to the agent that asked for it, in the same per-agent,
     * per-chat directory everything else it receives lands in — so its own file tools can reach it
     * and the ordinary retention sweep clears it. The index is what makes the file *findable* across
     * the room; where the bytes sit is still one agent's business.
     */
    const outcome = await store.store(
      { agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId },
      file.handle,
      fetcher,
      0,
    );
    if (!isStored(outcome)) return { error: outcome.unavailable };

    const bytes = await readFileBytes(outcome.localPath).catch(() => null);
    if (!bytes) return { error: "it was downloaded but could not be read back" };

    // So the next reader — this agent or another in the room — finds it on disk.
    this.o.deps.attachmentIndex?.markStored(file.ref, outcome.localPath);
    return { bytes, path: outcome.localPath };
  }

  /** Exposed so the tool registry can build `delegate` without reaching into the pipeline. */
  subagentRunner(): (request: SubagentRequest) => Promise<SubagentResult> {
    return (request) => runSubagent(this.o.turnContext, request);
  }

  /** `delegate`'s background half: a helper started as a job, whose end wakes its agent (`background-helper.ts`). */
  backgroundHelpers(): (request: SubagentRequest) => BackgroundStart {
    return (request) => startBackgroundHelper(this.o.turnContext, request);
  }

  /** A helper in the foreground that moves to the background when it runs long — `background-helper.ts`. */
  waitedHelpers(): (request: SubagentRequest) => MovableRun {
    return (request) => startWaitedHelper(this.o.turnContext, request);
  }

  /**
   * Exposed so the tool registry can build `ask_agent` without reaching into the pipeline.
   *
   * The counterpart of `subagentRunner`, and the difference is who runs: a subagent is the caller
   * with its persona stripped, this is another agent entirely. See `peer-turn.ts`.
   */
  peerTurnRunner(): (request: PeerTurnRequest) => Promise<PeerTurnResult> {
    return (request) => runPeerTurn(this.o.turnContext, request);
  }

  /** `ask_agent`'s other half (0.7.19): an ask waited on that moves to the background when it runs long — `background-ask.ts`. */
  askRunner(): (request: PeerTurnRequest, background: boolean) => AskStart {
    return (request, background) => startAsk(this.o.turnContext, request, background);
  }

  /** Live facts for the `session_status` tool. */
  sessionStatus(ctx: { agentId: string; chatId: string; gatewayId: string }): SessionStatus {
    const agent = this.o.deps.registry.get(ctx.agentId);
    const session = this.o.deps.sessions.load({
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      gatewayId: ctx.gatewayId,
    });

    return {
      agent: agent?.config.displayName ?? ctx.agentId,
      model: this.o.modelOverrides.get(session.id) ?? agent?.config.llm.model ?? "unknown",
      provider: agent?.config.llm.provider ?? "unknown",
      gateway: ctx.gatewayId,
      chatId: ctx.chatId,
      turns: session.messages.filter((m) => m.role === "user").length,
      contextTokens: session.contextTokenCount,
      toolNames: agent?.config.tools.enabled ?? [],
      startedAt: session.startedAt,
    };
  }
}
