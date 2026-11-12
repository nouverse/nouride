/**
 * In-process gateway for callers that are not chat platforms — the HTTP test endpoint today,
 * a CLI later.
 *
 * A real `Gateway` rather than a shortcut into the executor, so an injected message travels
 * the identical path: allowlist, routing, hooks, queue, prompt assembly, tool loop, session
 * persistence. A test harness that bypassed those would verify a code path nobody runs.
 *
 * It lives in the engine, not `@nouride/gateways`, because there is no platform SDK involved
 * and nothing outside the daemon would use it.
 */

import { readFileBytes } from "@nouride/runtime";
import {
  createLogger,
  newId,
  type Attachment,
  type ChatType,
  type Gateway,
  type GatewayEvent,
  type GatewayName,
  type GatewayStatus,
  type MessageEnvelope,
  type OpenPage,
  type OutboundMessage,
} from "@nouride/shared";
import { LOCAL_GATEWAY_ID } from "@nouride/shared";

export { LOCAL_GATEWAY_ID };

const log = createLogger("gateway.local");

/**
 * Who writes when the caller names nobody: `nouride chat`, a script, a test with the control token. It was `dev`,
 * "Developer", until 0.7.18, and memory filed it as a person, `web:dev`; 0.7.18 moved what was kept under that id, and
 * 0.8.0 refuses a `[[people]]` id that still names it (`refusePersonId` in `people/match.ts`).
 */
export const TERMINAL_SENDER = "terminal";

export interface LocalTurnRequest {
  /** Optional when attachments are present — the same rule the platform adapters use. */
  text?: string;
  chatId?: string;
  senderId?: string;
  senderName?: string;
  /** The caller authenticated this sender — see `MessageEnvelope.senderVerified`. */
  senderVerified?: boolean;
  chatType?: ChatType;
  /** Address a specific agent, as a chat user would by name. */
  agent?: string;
  /** Local file paths, so `nouride chat` can attach a file. `url` is the path. */
  attachments?: Attachment[];
  /** The dashboard page it was written from: see `MessageEnvelope.page`. */
  page?: OpenPage;
}

export interface LocalTurnResult {
  replies: string[];
  /** False when the daemon deliberately said nothing — no agent matched, or it is paused. */
  answered: boolean;
}

/**
 * Waits for the replies produced by one injected message.
 *
 * Correlated by chat id, and each call gets a fresh one by default: two concurrent HTTP callers
 * sharing a chat would otherwise collect each other's replies, and — worse — share a
 * conversation.
 */
export class LocalGateway implements Gateway {
  readonly id = LOCAL_GATEWAY_ID;
  readonly platform: GatewayName = "web";
  readonly status: GatewayStatus = "connected";
  /**
   * The CLI polls `/approvals` and prompts inline, so the engine's chat-level notice would be a second
   * copy of a question already on screen — arriving after it was answered, because replies reach the CLI
   * only when the turn ends.
   */
  readonly promptsApprovals = true;
  /**
   * Nothing here has a message id, and that is not a failure.
   *
   * A reply is collected by the waiting request or read from the turn record; there is no message on a
   * platform for anybody to reply to. `send` has always returned `[]` for that reason — see the note on
   * `Gateway.addressableMessages` for what reading it as "refused" cost.
   */
  readonly addressableMessages = false;
  /**
   * Nothing sent here comes back through `onMessage`.
   *
   * `send` hands the reply to a waiting request or leaves it in the turn record; there is no platform
   * to redistribute it. On Discord an agent's reply reaching every other bot is what records the room's
   * history and what carries a handover — here neither happens by itself, so the engine has to be told.
   */
  readonly echoesOwnMessages = false;

  private messageHandlers: ((env: MessageEnvelope) => void)[] = [];
  /**
   * The callers waiting on each chat — several, now that a message sent while a turn works is read by it
   * (steering): with one slot, the second caller took the first one's replies, and the first was told no
   * agent answered.
   */
  private pending = new Map<string, string[][]>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setTyping(): Promise<void> {}

  /**
   * For the local gateway an attachment `url` is a path on this host, so "fetching" is a read.
   *
   * Reachable only through the token-guarded control API, i.e. by the operator, who can already read
   * their own files — so this adds no reach. It exists so the local path exercises the same code as
   * Telegram and Discord instead of being a special case that never gets tested.
   */
  async fetchAttachment(attachment: Attachment): Promise<Uint8Array | null> {
    if (!attachment.url) return null;
    try {
      return await readFileBytes(attachment.url);
    } catch {
      return null;
    }
  }

  async send(msg: OutboundMessage): Promise<string[]> {
    const waiting = this.pending.get(msg.chatId) ?? [];
    for (const bucket of waiting) bucket.push(msg.text);
    if (waiting.length === 0) log.debug("reply with no waiting caller", { chat_id: msg.chatId });
    // No ids: a CLI reply is collected by the waiting request, not addressable afterwards. Nothing
    // can reply to it, so there is nothing to remember.
    return [];
  }

  onMessage(handler: (env: MessageEnvelope) => void): void {
    this.messageHandlers.push(handler);
  }

  onEvent(_handler: (event: GatewayEvent) => void): void {}

  /**
   * Inject a message and collect whatever the daemon says back.
   *
   * `waitForIdle` is the pipeline's `idle()`: the reply is produced asynchronously, so the
   * caller has to be told when the queue has finished rather than guessing with a timeout.
   */
  async ask(request: LocalTurnRequest, waitForIdle: () => Promise<void>): Promise<LocalTurnResult> {
    const envelope = this.envelopeFor(request);
    const bucket: string[] = [];
    this.pending.set(envelope.chatId, [...(this.pending.get(envelope.chatId) ?? []), bucket]);

    try {
      for (const handler of this.messageHandlers) handler(envelope);
      await waitForIdle();
      return { replies: [...bucket], answered: bucket.length > 0 };
    } finally {
      const rest = (this.pending.get(envelope.chatId) ?? []).filter((waiting) => waiting !== bucket);
      if (rest.length > 0) this.pending.set(envelope.chatId, rest);
      else this.pending.delete(envelope.chatId);
    }
  }

  /**
   * Inject a message and do not wait.
   *
   * What the dashboard uses. `ask` is the right shape for a CLI — one command, one answer, the process
   * exits — and the wrong shape for a browser: the reply arrived only as the body of an HTTP request
   * that a refresh cancelled, so a turn that was still running belonged to nobody, and the page
   * re-sent the message from a URL parameter to get back into a conversation it had never left.
   *
   * The answer is not returned because it is not the transport's job to carry it any more. The turn
   * writes itself down (`modules/turns/turns.store.ts`) and the client reads that — which is also what makes
   * a turn survive the tab being closed.
   */
  dispatch(request: LocalTurnRequest): { messageId: string; chatId: string } {
    const envelope = this.envelopeFor(request);
    for (const handler of this.messageHandlers) handler(envelope);
    return { messageId: envelope.id, chatId: envelope.chatId };
  }

  /** One place both entry points build the message, so they cannot drift apart. */
  private envelopeFor(request: LocalTurnRequest): MessageEnvelope {
    const chatId = request.chatId ?? `dev-${newId("chat")}`;
    const body = request.text ?? "";
    // A slash command goes bare. The prefix is for the model, and a command never reaches one — while
    // `nouva: /stop` misses the queue's urgent lane and waits behind the very turn it is meant to stop.
    // Rehearsed on a copy of the box: `/approve` from the dashboard sat behind the turn waiting on it
    // until the approval expired. `mentions` below routes it either way.
    const text = request.agent && !body.trimStart().startsWith("/") ? `${request.agent}: ${body}` : body;

    return {
      id: newId("msg"),
      timestamp: Date.now(),
      gateway: "web",
      gatewayId: this.id,
      chatId,
      chatType: request.chatType ?? "dm",
      /**
       * Addressing, as a field rather than as a string in the message.
       *
       * The prefix above is kept — it is what the agent sees and what `stripAddressPrefix` removes —
       * but it is no longer what *routes*. A resolved mention is the router's first and strongest
       * signal, and it cannot be defeated by the message's own contents.
       *
       * It was defeated, live: `nouride chat nouva` with a message containing `@nox` reached Nox,
       * who read it as somebody impersonating Nouva and answered with an injection warning. The
       * router's order is fixed too, but this is the half that makes `--agent` mean something a
       * sender cannot override by typing.
       */
      ...(request.agent ? { mentions: [request.agent] } : {}),
      senderId: request.senderId ?? TERMINAL_SENDER,
      senderName: request.senderName ?? "Terminal",
      ...(request.senderVerified ? { senderVerified: true } : {}),
      text,
      ...(request.attachments && request.attachments.length > 0
        ? { attachments: request.attachments }
        : {}),
      ...(request.page ? { page: request.page } : {}),
      raw: { via: "dev endpoint" },
    };
  }
}
