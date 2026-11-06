/**
 * Nouride as an ACP **agent**: what an editor (Zed, and the editors that copied it) starts and talks to.
 *
 * The editor starts the command as a subprocess and speaks on its stdin/stdout; this answers `initialize`, opens and
 * reopens sessions, runs a prompt and streams what happens back as `session/update`s, and asks the editor for a
 * permission. What a session *is* — a conversation on the daemon, its agent, its approvals — is the handlers', so this
 * stays the protocol and nothing of the daemon.
 *
 * Phase 1 lends nothing back: the editor's files and terminal are not used (`fs`/`terminal` are never called), and the
 * agent works where it always works, on the box, as its own user.
 */

import { AcpError, AcpPeer, type LineTransport } from "./peer.ts";
import {
  ACP_PROTOCOL_VERSION,
  AUTH_REQUIRED,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  type AgentCapabilities,
  type AuthMethod,
  type ContentBlock,
  type McpServer,
  type NewSessionResult,
  type PermissionOption,
  type PermissionOutcome,
  type SessionOptions,
  type SessionUpdate,
  type StopReason,
  type ToolCall,
  type PromptUsage,
} from "./protocol.ts";

/** What a handler uses to talk to the editor while it answers a session's call. */
export interface SessionChannel {
  readonly sessionId: string;
  update(update: SessionUpdate): void;
  requestPermission(toolCall: ToolCall, options: PermissionOption[]): Promise<PermissionOutcome>;
}

export interface AcpAgentHandlers {
  newSession(params: { cwd: string; mcpServers: McpServer[] }): Promise<NewSessionResult>;
  /** Reopen a session, replaying its history through `channel.update` before answering. Absent: not offered. */
  loadSession?(params: { sessionId: string; cwd: string; mcpServers: McpServer[] }, channel: SessionChannel): Promise<void>;
  /** Why it stopped — with what the turn spent, for an agent that reports it (`PromptResponse.usage`, unstable). */
  prompt(params: { sessionId: string; prompt: ContentBlock[] }, channel: SessionChannel): Promise<StopReason | { stopReason: StopReason; usage: PromptUsage }>;
  cancel(sessionId: string): void;
  /** Let a session go, as the client asks once it is done with it. Absent: not offered. */
  closeSession?(sessionId: string): Promise<void>;
  authenticate?(methodId: string): Promise<void>;
  /** A mode the session offered, chosen by the editor. Absent: refused. */
  setMode?(sessionId: string, modeId: string): Promise<void>;
  /** One of the session's own options set to one of its values, answered with its options after. Absent: refused. */
  setConfigOption?(sessionId: string, configId: string, value: string): Promise<SessionOptions | void>;
}

export interface AcpServerOptions {
  transport: LineTransport;
  handlers: AcpAgentHandlers;
  agentInfo: { name: string; title?: string; version: string };
  /** Beyond `loadSession`, which follows the handlers. */
  promptCapabilities?: AgentCapabilities["promptCapabilities"];
  /** The MCP servers a session may be given. Absent: none — Nouride served to an editor takes none (ACP_PROTOCOL §8). */
  mcpCapabilities?: AgentCapabilities["mcpCapabilities"];
  authMethods?: AuthMethod[];
  stray?: (line: string) => void;
}

/** A refusal that says the session needs a sign-in first, the code an editor shows its sign-in for. */
export function authRequired(message: string): AcpError {
  return new AcpError(AUTH_REQUIRED, message);
}

export class AcpServer {
  private readonly peer: AcpPeer;

  constructor(private readonly options: AcpServerOptions) {
    this.peer = new AcpPeer(options.transport, {
      request: (method, params) => this.answer(method, params),
      notification: (method, params) => this.notified(method, params),
      ...(options.stray ? { stray: options.stray } : {}),
    });
  }

  receive(line: string): void {
    this.peer.receive(line);
  }

  closed(reason: string): void {
    this.peer.closed(reason);
  }

  private channel(sessionId: string): SessionChannel {
    return {
      sessionId,
      update: (update) => this.peer.notify("session/update", { sessionId, update }),
      requestPermission: async (toolCall, options) => {
        const answer = await this.peer.call<{ outcome: PermissionOutcome }>("session/request_permission", { sessionId, toolCall, options });
        return answer?.outcome ?? { outcome: "cancelled" };
      },
    };
  }

  private notified(method: string, params: unknown): void {
    if (method !== "session/cancel") return;
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId === "string") this.options.handlers.cancel(sessionId);
  }

  private async answer(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const { handlers } = this.options;
    switch (method) {
      case "initialize":
        // The version is ours to answer: one speaking another is the editor's to refuse.
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: handlers.loadSession !== undefined,
            ...(handlers.closeSession ? { sessionCapabilities: { close: {} } } : {}),
            promptCapabilities: { image: false, audio: false, embeddedContext: true, ...this.options.promptCapabilities },
            mcpCapabilities: { http: false, sse: false, ...this.options.mcpCapabilities },
          },
          agentInfo: this.options.agentInfo,
          authMethods: this.options.authMethods ?? [],
        };
      case "authenticate":
        if (!handlers.authenticate) return {};
        await handlers.authenticate(stringParam(p, "methodId"));
        return {};
      case "session/new":
        return handlers.newSession({ cwd: stringParam(p, "cwd"), mcpServers: arrayParam<McpServer>(p, "mcpServers") });
      case "session/load": {
        if (!handlers.loadSession) throw new AcpError(METHOD_NOT_FOUND, "session/load: this agent does not reopen sessions");
        const sessionId = stringParam(p, "sessionId");
        await handlers.loadSession({ sessionId, cwd: stringParam(p, "cwd"), mcpServers: arrayParam<McpServer>(p, "mcpServers") }, this.channel(sessionId));
        return {};
      }
      case "session/close":
        if (!handlers.closeSession) throw new AcpError(METHOD_NOT_FOUND, `${method} is not supported`);
        await handlers.closeSession(stringParam(p, "sessionId"));
        return {};
      case "session/prompt": {
        const sessionId = stringParam(p, "sessionId");
        const answer = await handlers.prompt({ sessionId, prompt: arrayParam<ContentBlock>(p, "prompt") }, this.channel(sessionId));
        return typeof answer === "string" ? { stopReason: answer } : answer;
      }
      case "session/set_mode":
        if (!handlers.setMode) throw new AcpError(METHOD_NOT_FOUND, `${method} is not supported`);
        await handlers.setMode(stringParam(p, "sessionId"), stringParam(p, "modeId"));
        return {};
      case "session/set_config_option":
        if (!handlers.setConfigOption) throw new AcpError(METHOD_NOT_FOUND, `${method} is not supported`);
        return (await handlers.setConfigOption(stringParam(p, "sessionId"), stringParam(p, "configId"), stringParam(p, "value"))) ?? {};
      default:
        throw new AcpError(METHOD_NOT_FOUND, `${method} is not supported`);
    }
  }
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value) throw new AcpError(INVALID_PARAMS, `${name} is required`);
  return value;
}

function arrayParam<T>(params: Record<string, unknown>, name: string): T[] {
  const value = params[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AcpError(INVALID_PARAMS, `${name} must be a list`);
  return value as T[];
}
