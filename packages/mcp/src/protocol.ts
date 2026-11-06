/**
 * The wire format, and nothing else.
 *
 * JSON-RPC 2.0 framing plus the handful of MCP shapes this host actually uses. No I/O, no transport,
 * no timers — so the parts most likely to be wrong (id matching, error mapping, how a tool result
 * turns into text) are testable without spawning anything.
 */

/**
 * The version this host asks for: the newest it speaks, MCP 2025-06-18.
 *
 * It asked for 2024-11-05 until 0.7.13 and took whatever a server answered (G4). A server now answers with one of
 * `MCP_PROTOCOL_VERSIONS` or is refused — the spec has a client that cannot speak the server's version disconnect.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Every version this host speaks, newest first, and what each one asks of it.
 *
 * Nothing this host uses differs between them — `tools/list` with its cursor, `tools/call`, `tools/list_changed`,
 * `ping` and `notifications/cancelled` are in all three — so a server on an older one is spoken to the same way:
 *
 * - **2025-06-18** — `MCP-Protocol-Version` on every HTTP request after `initialize`; no JSON-RPC batches (none is
 *   ever sent from here); `structuredContent` and `resource_link` in a tool's result.
 * - **2025-03-26** — Streamable HTTP; a server may batch, and a batch is unwrapped. The header is sent too: the version
 *   that defines it says a server without it should assume this one, and the reference SDK sends it to every version.
 * - **2024-11-05** — the legacy HTTP+SSE transport (`sse`) is its shape.
 */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

/**
 * What a server answers a client that asked for `requested`: that version when it is one spoken here, and otherwise the
 * newest — the negotiation the spec gives a server (lifecycle § Version Negotiation).
 */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
}

/** A request's id. Ours are numbers; a server's may be either. */
export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export function request(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

export function notification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
}

/** The answer to a request the *server* sent. */
export function reply(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** A refusal of a request the server sent. */
export function refusal(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** JSON-RPC's "the method does not exist / is not available". */
export const METHOD_NOT_FOUND = -32601;

/** One message from the peer, by what it is. */
export type IncomingMessage =
  | { kind: "response"; response: JsonRpcResponse }
  | { kind: "notification"; method: string }
  | { kind: "request"; id: JsonRpcId; method: string };

/**
 * Parse one line into a message, or null.
 *
 * Null is anything that is not a JSON-RPC message this host could act on — text that is not JSON, an answer to an id
 * that is not ours — and the client does the same with all of it: ignores it and keeps reading. A server that logs to
 * stdout instead of stderr is common enough that treating a stray line as a fatal protocol error would make this host
 * useless against real servers.
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
  if (typeof message.method === "string") {
    if (message.id === undefined) return { kind: "notification", method: message.method };
    if (typeof message.id === "string" || typeof message.id === "number") return { kind: "request", id: message.id, method: message.method };
    return null;
  }
  if (typeof message.id !== "number") return null;
  if (!("result" in message) && !("error" in message)) return null;
  return { kind: "response", response: message as unknown as JsonRpcResponse };
}

export interface McpServerInfo {
  name: string;
  version?: string;
  /** What the server answered `initialize` with; empty when it said nothing. The client refuses one it does not speak. */
  protocolVersion: string;
  /** It declared `capabilities.tools.listChanged`: it will say when its tools change. */
  toolsListChanged: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. Passed to the model as-is. */
  inputSchema?: Record<string, unknown>;
  /**
   * JSON Schema for the result's `structuredContent` (MCP 2025-06-18). A server that declares one MUST return structured
   * content that conforms; the engine holds each result to it before the model reads it.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * What the server says about the tool's behaviour (MCP 2025-03-26 `ToolAnnotations`).
   *
   * Hints, and the spec says so: a server can claim anything. Only `readOnlyHint` is read, and only to
   * look less, never to allow more: such a call may run beside others (`parallelSafe`), is not taken as
   * sending anything off the machine (`sendsOut`, the second look), and is among a side question's tools
   * (`/btw`, 0.8.17), which are only ones that run without asking. A wrong "yes" costs a race against the
   * server's own state, or a second look not taken, never a permission. What a tool is *allowed* to do is
   * still the approval gate's call.
   */
  annotations?: { readOnlyHint?: boolean };
}

/** One block of a tool's answer. Text, images and resource links are rendered; the rest are named so nothing is silent. */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content?: McpContentBlock[];
  /** MCP 2025-06-18: the result as one JSON value, beside `content` or — from a server that skips the text — instead. */
  structuredContent?: unknown;
  isError?: boolean;
}

export function parseServerInfo(result: unknown): McpServerInfo {
  const info = (result ?? {}) as Record<string, unknown>;
  const server = (info.serverInfo ?? {}) as Record<string, unknown>;
  const tools = ((info.capabilities ?? {}) as { tools?: unknown }).tools;
  return {
    name: typeof server.name === "string" ? server.name : "unknown",
    ...(typeof server.version === "string" ? { version: server.version } : {}),
    protocolVersion: typeof info.protocolVersion === "string" ? info.protocolVersion : "",
    toolsListChanged: typeof tools === "object" && tools !== null && (tools as { listChanged?: unknown }).listChanged === true,
  };
}

export function parseTools(result: unknown): McpTool[] {
  const listed = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(listed)) return [];

  return listed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name) return [];
    return [
      {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
        ...(typeof tool.outputSchema === "object" && tool.outputSchema !== null && !Array.isArray(tool.outputSchema)
          ? { outputSchema: tool.outputSchema as Record<string, unknown> }
          : {}),
        ...readOnlyHint(tool.annotations),
      },
    ];
  });
}

/** Where the next page of a paginated listing starts, or undefined on the last page (spec § Pagination). */
export function nextCursor(result: unknown): string | undefined {
  const cursor = (result as { nextCursor?: unknown } | null)?.nextCursor;
  return typeof cursor === "string" && cursor !== "" ? cursor : undefined;
}

/** `annotations.readOnlyHint`, when it is actually a boolean. Anything else is no hint at all. */
function readOnlyHint(annotations: unknown): Pick<McpTool, "annotations"> {
  if (typeof annotations !== "object" || annotations === null) return {};
  const hint = (annotations as { readOnlyHint?: unknown }).readOnlyHint;
  return typeof hint === "boolean" ? { annotations: { readOnlyHint: hint } } : {};
}

/**
 * Flatten a tool result into the text an LLM can read.
 *
 * Non-text blocks are named rather than dropped. A server that answers with an image and nothing else
 * would otherwise look like a server that answered with nothing, and the model would report success
 * having received an empty string. An image is numbered, because it travels on beside the text
 * (`imagesOf`) and whoever shows it says which one it is.
 *
 * `structuredContent` (2025-06-18) is the same answer as data. A server is asked to put it in a text block too, so the
 * text is what the model reads when there is any; a result with no text gets the structured value written out instead,
 * since otherwise it would read as empty. A `resource_link` is a line naming the link — its address first — so the
 * model can quote it, fetch it or hand it on.
 */
export function flattenContent(result: McpToolCallResult): string {
  const blocks = blocksOf(result);
  let images = 0;
  const lines = blocks.map((block) => {
    if (typeof block.text === "string") return block.text;
    if (isImage(block)) return `[image ${(images += 1)}]`;
    if (block.type === "resource_link") return linkLine(block) ?? "[resource_link content, not renderable as text]";
    return `[${block.type} content, not renderable as text]`;
  });
  const structured = result.structuredContent;
  const told = blocks.some((block) => typeof block.text === "string" && block.text.trim() !== "");
  const fromData = told || structured === undefined || structured === null ? [] : [JSON.stringify(structured)];
  return [...fromData, ...lines].join("\n").trim();
}

/** An image a tool returned: base64 bytes and what they are. */
export interface McpImage {
  data: string;
  mimeType: string;
}

/** The images in a tool result, in order — `[image n]` in `flattenContent` is the n-th of these. */
export function imagesOf(result: McpToolCallResult): McpImage[] {
  return blocksOf(result).filter(isImage).map((block) => ({ data: block.data as string, mimeType: block.mimeType as string }));
}

/** The result's content blocks — only the ones that are objects with a type, from a server that may send anything. */
function blocksOf(result: McpToolCallResult): McpContentBlock[] {
  const content: unknown = result.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is McpContentBlock => typeof block === "object" && block !== null && typeof (block as { type?: unknown }).type === "string");
}

function isImage(block: McpContentBlock): boolean {
  return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

/**
 * `[resource link: main.rs] file:///project/src/main.rs (text/x-rust, 812 bytes): Primary application entry point` —
 * or null for one with no address, which is no link at all. Every field is the server's, so each is kept to one line.
 */
function linkLine(block: McpContentBlock): string | null {
  if (typeof block.uri !== "string" || !block.uri.trim()) return null;
  const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const label = text(block.title) || text(block.name);
  const about = [text(block.mimeType), typeof block.size === "number" ? `${block.size} bytes` : ""].filter(Boolean).join(", ");
  const description = text(block.description);
  return `[resource link${label ? `: ${label}` : ""}] ${text(block.uri)}${about ? ` (${about})` : ""}${description ? `: ${description}` : ""}`;
}
