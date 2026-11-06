/**
 * The wire format, and nothing else.
 *
 * JSON-RPC 2.0 framing — one message a line on stdin/stdout — plus the Agent Client Protocol shapes this package uses,
 * in both directions: a coding CLI spoken to as its client, and Nouride's agents served to an editor. No I/O, no
 * timers, so the parts most likely to be wrong — id matching, a message read by what it is, an update read by its kind —
 * are tested without a process.
 *
 * Names and fields follow the protocol's schema (agentclientprotocol.com, protocol version 1). Only what is used is
 * typed; a field the peer sends that is not named here is carried through untouched, never refused.
 */

/** The version spoken: ACP's integer version 1, the one every agent and editor of 2026 answers. */
export const ACP_PROTOCOL_VERSION = 1;

/** A request's id. Ours are numbers; a peer's may be either. */
export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC's own codes, and the one ACP adds for a session that wants a sign-in first. */
export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
export const AUTH_REQUIRED = -32000;

export function request(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

export function notification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
}

export function reply(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null });
}

export function refusal(id: JsonRpcId, error: JsonRpcError): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error });
}

/** One message from the peer, by what it is. */
export type IncomingMessage =
  | { kind: "response"; id: JsonRpcId; result?: unknown; error?: JsonRpcError }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown };

/**
 * One line as a message, or null for anything that is not one: text that is not JSON, a batch, an object that is
 * neither a call nor an answer. A CLI that prints a banner on stdout before it speaks is common, and a stray line read
 * as a fatal error would make the protocol unusable against real agents — it is skipped, and the caller may log it.
 */
export function parseMessage(line: string): IncomingMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;
  const id = message.id;
  const isId = typeof id === "string" || typeof id === "number";
  if (typeof message.method === "string") {
    if (id === undefined || id === null) return { kind: "notification", method: message.method, params: message.params };
    return isId ? { kind: "request", id, method: message.method, params: message.params } : null;
  }
  if (!isId || !("result" in message || "error" in message)) return null;
  const error = message.error as JsonRpcError | undefined;
  return { kind: "response", id, ...("result" in message ? { result: message.result } : {}), ...(error ? { error } : {}) };
}

// ── Content ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; title?: string; description?: string; size?: number }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string } };

/** A block as text, for a transcript: a link and a resource by their name, an image or sound said to be one. */
export function blockText(block: ContentBlock | undefined): string {
  if (!block) return "";
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[${block.title ?? block.name}](${block.uri})`;
    case "resource":
      return "text" in block.resource ? block.resource.text : `[${block.resource.uri}]`;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
  }
}

// ── Initialize and sign-in ──────────────────────────────────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: { terminal?: boolean };
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  /** `agent` (the default): the agent signs in itself. `terminal`: run the agent with these args in a terminal. */
  type?: "agent" | "terminal";
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  /** What it does with a session beyond prompting it — `close`: `session/close` lets one go (its process, its memory). */
  sessionCapabilities?: { close?: object };
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: AuthMethod[];
  /** Extensions the agent offers beyond the protocol — `steering` among them (`steeringOffered`). */
  _meta?: Record<string, unknown>;
}

/**
 * Whether the agent takes a message into a prompt that is still running: `_session/steering`, an extension both
 * claude-agent-acp (0.95) and codex-acp (2.3) offer, said as `_meta.steering.supported` in their handshake.
 */
export function steeringOffered(info: Pick<InitializeResult, "_meta"> | null | undefined): boolean {
  const steering = info?._meta?.steering;
  return typeof steering === "object" && steering !== null && (steering as { supported?: unknown }).supported === true;
}

/**
 * What a steer came to: taken into the running prompt; no prompt running, so the words are the caller's to send as one
 * (`promptRequired`, asked for with `idleBehavior`); a turn the agent started for them by itself (codex-acp, which asks
 * nothing of `_meta`); or not taken.
 */
export type SteerOutcome = "injected" | "promptRequired" | "startedNewTurn" | "failed";

/** A steer's answer, read as one of the four — anything else is `failed`. */
export function steerOutcomeOf(value: unknown): SteerOutcome {
  const outcome = (value as { outcome?: unknown } | null | undefined)?.outcome;
  return outcome === "injected" || outcome === "promptRequired" || outcome === "startedNewTurn" ? outcome : "failed";
}

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EnvVariable {
  name: string;
  value: string;
}

/** An MCP server handed to the agent for a session: a process it starts, or an address it reaches. */
export type McpServer =
  | { name: string; command: string; args: string[]; env: EnvVariable[] }
  | { type: "http"; name: string; url: string; headers: EnvVariable[] }
  | { type: "sse"; name: string; url: string; headers: EnvVariable[] };

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

/** One of a session's settings: its mode, its model, its effort — each a choice among values it offers. */
export interface SessionConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: { value: string; name?: string; description?: string }[];
}

/** A session's options, as it opened, reopened, or had one of them set. */
export interface SessionOptions {
  configOptions?: SessionConfigOption[] | null;
}

export interface NewSessionResult extends SessionOptions {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: SessionMode[] } | null;
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/**
 * The tokens a prompt turn spent, as the agent reports them — `PromptResponse.usage`, marked UNSTABLE in the ACP schema
 * (`schema.unstable.json`, 2026): optional, and an agent that does not report it is not counted as zero.
 */
export interface PromptUsage {
  totalTokens: number;
  /** The input not read from or written to a cache: the schema's total is the sum of every kind, cached ones apart. */
  inputTokens: number;
  outputTokens: number;
  /** Input read from the model's cache, and written to it — null where the agent did not say. */
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
}

/** Why a prompt stopped, and what it spent where the agent said; null where it did not. */
export interface PromptAnswer {
  stopReason: StopReason;
  usage: PromptUsage | null;
}

/** `usage` as the agent sent it, read only where its counts are numbers. */
export function promptUsageOf(value: unknown): PromptUsage | null {
  if (!value || typeof value !== "object") return null;
  const { totalTokens, inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens } = value as Record<string, unknown>;
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
  const input = count(inputTokens);
  const output = count(outputTokens);
  const total = count(totalTokens);
  if (input === null && output === null && total === null) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: total ?? (input ?? 0) + (output ?? 0),
    cachedReadTokens: count(cachedReadTokens),
    cachedWriteTokens: count(cachedWriteTokens),
  };
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface ToolCall {
  toolCallId: string;
  /** The agent's own name for the tool, where it gives one (`Bash`, `Edit`); `kind` is the protocol's coarser word. */
  name?: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

/** What a session says while a prompt runs, by `sessionUpdate`. Kinds this package does not read pass as `other`. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCall & { title: string })
  | ({ sessionUpdate: "tool_call_update" } & ToolCall)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: unknown };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
}

export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
