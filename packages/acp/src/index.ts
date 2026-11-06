/**
 * `@nouride/acp` — the Agent Client Protocol (protocol version 1), both ways.
 *
 * - `protocol.ts` — the wire format: JSON-RPC framing and the ACP shapes used. Pure, no I/O.
 * - `peer.ts` — one connection, both directions: calls matched to answers by id, the peer's calls answered, timeouts,
 *   every waiting call failed when the peer is gone.
 * - `client.ts` — Nouride driving a coding CLI (an external agent): handshake, sessions, a prompt and its updates, a
 *   cancel, and the permission the agent asks for, answered by the caller.
 * - `server.ts` — Nouride's agents served to an editor that speaks ACP.
 * - `agents.ts` — the built-in coding CLIs, as data: how each is started, signed in and pointed at a profile.
 *
 * Nothing here starts a process or knows the daemon: a caller feeds lines in and says when the peer ended, which is
 * what keeps the protocol testable against an in-memory peer, and the package usable by another tool.
 */

export { BUILT_IN_CLIS, type CliPreset, type CliRow } from "./agents.ts";
export { AcpClient, type AcpClientOptions } from "./client.ts";
export { AcpServer, authRequired, type AcpAgentHandlers, type AcpServerOptions, type SessionChannel } from "./server.ts";
export { AcpError, type LineTransport } from "./peer.ts";
export {
  AUTH_REQUIRED,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  blockText,
  steeringOffered,
  type AuthMethod,
  type ContentBlock,
  type InitializeResult,
  type McpServer,
  type NewSessionResult,
  type PermissionOption,
  type PermissionOutcome,
  type PlanEntry,
  type RequestPermissionParams,
  type SessionConfigOption,
  type SessionMode,
  type SessionOptions,
  type SessionUpdate,
  type SteerOutcome,
  type StopReason,
  type PromptAnswer,
  type PromptUsage,
  type ToolCall,
  type ToolCallContent,
  type ToolKind,
} from "./protocol.ts";
