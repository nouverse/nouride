/**
 * Nouride as an ACP **client**: one coding CLI's connection, driven from here.
 *
 * The handshake and its version, a session opened or loaded, a prompt whose updates stream to whoever started it, a
 * cancel, and the one call the agent makes back — a permission, answered by whatever the caller decides (Nouride's
 * approval gate). Nothing here starts a process: the caller feeds `receive` from the CLI's stdout and calls `closed`
 * when it exits.
 *
 * Nouride lends the agent neither its files nor a terminal (`fs` and `terminal` advertised false): a CLI works in its
 * own folder, as its agent's own user, with its own tools — routing them through the daemon would be a second sandbox
 * with the daemon's permissions. A call for either is refused, which a compliant agent never makes.
 */

import { AcpError, AcpPeer, type LineTransport } from "./peer.ts";
import {
  ACP_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  type ContentBlock,
  type InitializeResult,
  type McpServer,
  type NewSessionResult,
  type PermissionOutcome,
  type RequestPermissionParams,
  type SessionNotification,
  type SessionOptions,
  type SessionUpdate,
  type StopReason,
  type PromptAnswer,
  type SteerOutcome,
  promptUsageOf,
  steerOutcomeOf,
} from "./protocol.ts";

export interface AcpClientOptions {
  transport: LineTransport;
  /** The answer to the agent's permission request. Reject or `cancelled` to refuse it. */
  permission: (request: RequestPermissionParams) => Promise<PermissionOutcome>;
  /** A line on stdout that was not a message. */
  stray?: (line: string) => void;
  /** An update whoever was prompting threw on: dropped, and the connection reads on. */
  failed?: (method: string, error: unknown) => void;
  /** Updates for a session nobody is prompting — what `session/load` replays, or late ones after a prompt ended. */
  unclaimed?: (sessionId: string, update: SessionUpdate) => void;
  clientInfo?: { name: string; version: string };
}

/** How long the handshake and opening a session may take: one CLI's ACP server (Antigravity's) took about 16 s cold on Windows. */
const OPEN_TIMEOUT_MS = 90_000;

export class AcpClient {
  private readonly peer: AcpPeer;
  private readonly listeners = new Map<string, (update: SessionUpdate) => void>();
  private agent: InitializeResult | null = null;

  constructor(private readonly options: AcpClientOptions) {
    this.peer = new AcpPeer(options.transport, {
      request: (method, params) => this.answer(method, params),
      notification: (method, params) => this.notified(method, params),
      ...(options.stray ? { stray: options.stray } : {}),
      ...(options.failed ? { failed: options.failed } : {}),
    });
  }

  /** What the agent said it is and can do, once `initialize` has answered. */
  get info(): InitializeResult | null {
    return this.agent;
  }

  get closedReason(): string | null {
    return this.peer.closedReason;
  }

  receive(line: string): void {
    this.peer.receive(line);
  }

  closed(reason: string): void {
    this.peer.closed(reason);
  }

  /** The handshake. Refuses an agent that answers with a version this package does not speak. */
  async initialize(timeoutMs = OPEN_TIMEOUT_MS): Promise<InitializeResult> {
    const result = await this.peer.call<InitializeResult>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // `auth.terminal`: a sign-in a person runs in a terminal is one this client can offer. Claude's adapter lists no
        // sign-in method to a client that does not say so.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
        _meta: { "terminal-auth": true },
        ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
      },
      { timeoutMs },
    );
    if (!result || typeof result.protocolVersion !== "number") throw new AcpError(METHOD_NOT_FOUND, "initialize: the agent did not say which protocol version it speaks");
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpError(METHOD_NOT_FOUND, `initialize: the agent speaks ACP version ${result.protocolVersion}, and this Nouride speaks ${ACP_PROTOCOL_VERSION}`);
    }
    this.agent = result;
    return result;
  }

  authenticate(methodId: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<unknown> {
    return this.peer.call("authenticate", { methodId }, { timeoutMs });
  }

  newSession(cwd: string, mcpServers: McpServer[] = [], timeoutMs = OPEN_TIMEOUT_MS): Promise<NewSessionResult> {
    return this.peer.call<NewSessionResult>("session/new", { cwd, mcpServers }, { timeoutMs });
  }

  /**
   * Reopen a session the agent kept. Only where it said `loadSession`; its replayed history goes to `unclaimed`. Answers
   * with the session's options as it reopened.
   */
  async loadSession(sessionId: string, cwd: string, mcpServers: McpServer[] = [], timeoutMs = OPEN_TIMEOUT_MS): Promise<SessionOptions> {
    if (!this.agent?.agentCapabilities?.loadSession) throw new AcpError(METHOD_NOT_FOUND, "session/load: this agent cannot reopen a session");
    return (await this.peer.call<SessionOptions | null>("session/load", { sessionId, cwd, mcpServers }, { timeoutMs })) ?? {};
  }

  /** Let a session go — its process and memory in the agent. Only where it said `sessionCapabilities.close`. */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.agent?.agentCapabilities?.sessionCapabilities?.close) throw new AcpError(METHOD_NOT_FOUND, "session/close: this agent does not close sessions");
    await this.peer.call("session/close", { sessionId }, { timeoutMs: OPEN_TIMEOUT_MS });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.peer.call("session/set_mode", { sessionId, modeId }, { timeoutMs: OPEN_TIMEOUT_MS });
  }

  /**
   * One of the session's own options — its model, its effort — to one of the values it offered. Answers with the
   * session's options as they stand after: another option's values can follow the one set, as an effort's do a model.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionOptions> {
    return (await this.peer.call<SessionOptions | null>("session/set_config_option", { sessionId, configId, value }, { timeoutMs: OPEN_TIMEOUT_MS })) ?? {};
  }

  /**
   * One prompt, its updates to `onUpdate` while it runs, and why it stopped. Unbounded in time: a prompt runs as long as
   * its work does, and stopping it is `cancel`, or the process ending. One prompt a session at a time — the protocol's.
   */
  async prompt(sessionId: string, prompt: ContentBlock[], onUpdate: (update: SessionUpdate) => void): Promise<StopReason> {
    return (await this.promptAnswer(sessionId, prompt, onUpdate)).stopReason;
  }

  /** `prompt`, with the tokens the agent says the turn spent — null where it says none (0.8.7). */
  async promptAnswer(sessionId: string, prompt: ContentBlock[], onUpdate: (update: SessionUpdate) => void): Promise<PromptAnswer> {
    if (this.listeners.has(sessionId)) throw new AcpError(METHOD_NOT_FOUND, `session/prompt: session ${sessionId} is already answering a prompt`);
    this.listeners.set(sessionId, onUpdate);
    try {
      const result = await this.peer.call<{ stopReason: StopReason; usage?: unknown }>("session/prompt", { sessionId, prompt });
      return { stopReason: result?.stopReason ?? "end_turn", usage: promptUsageOf(result?.usage) };
    } finally {
      this.listeners.delete(sessionId);
    }
  }

  /**
   * Words for the prompt running in a session (`_session/steering`, `steeringOffered`): the agent takes them in before its
   * next step, and the prompt answers once it has answered them too. `promptRequired`: no prompt is running, and nothing
   * was started — the words are the caller's to send as the next prompt. Never throws: a refusal reads as `failed`.
   */
  async steer(sessionId: string, prompt: ContentBlock[]): Promise<SteerOutcome> {
    try {
      const result = await this.peer.call("_session/steering", { sessionId, prompt, _meta: { steering: { idleBehavior: "promptRequired" } } }, { timeoutMs: OPEN_TIMEOUT_MS });
      return steerOutcomeOf(result);
    } catch {
      return "failed";
    }
  }

  /** Ask the agent to stop the prompt running in a session; the prompt then answers `cancelled`. */
  cancel(sessionId: string): void {
    this.peer.notify("session/cancel", { sessionId });
  }

  private notified(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const note = params as SessionNotification | undefined;
    if (!note || typeof note.sessionId !== "string" || !note.update) return;
    const listener = this.listeners.get(note.sessionId);
    if (listener) listener(note.update);
    else this.options.unclaimed?.(note.sessionId, note.update);
  }

  private async answer(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      try {
        return { outcome: await this.options.permission(params as RequestPermissionParams) };
      } catch {
        return { outcome: { outcome: "cancelled" } satisfies PermissionOutcome };
      }
    }
    throw new AcpError(METHOD_NOT_FOUND, `${method}: Nouride lends the agent neither its files nor a terminal, so work in the session's folder`);
  }
}
