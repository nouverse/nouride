/**
 * A real MCP server for the tests, small enough to read in one go.
 *
 * One core, two ways to reach it: over stdio as a child process (`stdio-server.ts`), and over Streamable HTTP on a
 * socket (`http-server.ts`) — so what a test asserts is what crossed a real pipe or a real connection, not what a fake
 * transport was told. It does what a test scripts: answers `initialize` with a chosen version and capabilities, lists
 * its tools a page at a time, changes them and says so, and answers a handful of tools whose results take the shapes
 * MCP 2025-06-18 gives them.
 */

export interface ScriptedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ServerScript {
  /** What `initialize` answers: a version, `"echo"` for the one the client asked for (the default), or null for none. */
  answers?: string | null;
  /** The capabilities it declares — `{ tools: {} }` unless the test says otherwise. */
  capabilities?: Record<string, unknown>;
  /** The tools it lists at first; `echo` alone unless the test says otherwise. */
  tools?: ScriptedTool[];
  /** Tools per page of `tools/list`: all of them on one page when absent. */
  pageSize?: number;
}

/** What the server was sent, in order — read off it by the HTTP tests, and by the stdio ones through the `stats` tool. */
export interface Seen {
  methods: string[];
  /** The params `initialize` came with. */
  initialize?: Record<string, unknown>;
  /** Every `notifications/cancelled`'s params. */
  cancelled: unknown[];
  /** Every answer the client gave to a request of the server's. */
  answers: unknown[];
}

export const ECHO: ScriptedTool = {
  name: "echo",
  description: "Says back what it was given.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/**
 * The core: `handle` takes one message and answers it, or answers nothing for a notification or a reply; `emit` is how
 * the server says something unasked — a notification, or a request of its own.
 */
export function scriptedServer(script: ServerScript, emit: (message: object) => void) {
  let tools = [...(script.tools ?? [ECHO])];
  const seen: Seen = { methods: [], cancelled: [], answers: [] };
  let asked = 0;

  const result = (id: string | number, value: unknown) => ({ jsonrpc: "2.0", id, result: value });

  function call(name: string, args: Record<string, unknown>): object {
    switch (name) {
      case "echo":
        return { content: [{ type: "text", text: String(args.text) }] };
      case "structured":
        // The same weather twice over, as 2025-06-18 asks — or only as data, from a server that skips the text.
        return args.text === false
          ? { content: [], structuredContent: { temperature: 22.5, conditions: "Partly cloudy" } }
          : { content: [{ type: "text", text: "22.5°C, partly cloudy" }], structuredContent: { temperature: 22.5, conditions: "Partly cloudy" } };
      case "link":
        return {
          content: [
            { type: "text", text: "The entry point:" },
            { type: "resource_link", uri: "file:///project/src/main.rs", name: "main.rs", mimeType: "text/x-rust", description: "Primary\napplication entry point" },
          ],
        };
      case "change_tools": {
        const add = (args.add as string[] | undefined) ?? [];
        const remove = new Set((args.remove as string[] | undefined) ?? []);
        tools = [...tools.filter((tool) => !remove.has(tool.name)), ...add.map((added) => ({ name: added, description: `Added: ${added}`, inputSchema: { type: "object" } }))];
        for (let n = 0; n < Number(args.notify ?? 1); n += 1) emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        return { content: [{ type: "text", text: `now ${tools.map((tool) => tool.name).join(", ")}` }] };
      }
      case "ask_client":
        // A request of the server's own — `ping`, or one this client never declared it could answer.
        emit({ jsonrpc: "2.0", id: `server-${(asked += 1)}`, method: String(args.method ?? "ping"), params: {} });
        return { content: [{ type: "text", text: "asked" }] };
      case "stats":
        return { content: [{ type: "text", text: JSON.stringify(seen) }] };
      default:
        return { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
    }
  }

  function handle(message: Message): object | null {
    if (message.method === undefined) {
      seen.answers.push(message);
      return null;
    }
    seen.methods.push(message.method);
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled") seen.cancelled.push(message.params);
      return null;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize": {
        seen.initialize = params;
        const answers = script.answers === undefined ? params.protocolVersion : script.answers;
        return result(message.id, {
          ...(answers === null ? {} : { protocolVersion: answers }),
          capabilities: script.capabilities ?? { tools: {} },
          serverInfo: { name: "scripted", version: "1.0.0" },
        });
      }
      case "tools/list": {
        const size = script.pageSize ?? tools.length;
        const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const next = start + size < tools.length ? String(start + size) : undefined;
        return result(message.id, { tools: tools.slice(start, start + size), ...(next ? { nextCursor: next } : {}) });
      }
      case "tools/call":
        return result(message.id, call(String(params.name), (params.arguments as Record<string, unknown> | undefined) ?? {}));
      case "ping":
        return result(message.id, {});
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } };
    }
  }

  return { handle, seen, tools: () => tools };
}
