/**
 * Clients on the scripted server, over each real transport — a child process for stdio, a socket for HTTP.
 */

import { McpClient, type McpClientOptions } from "../../src/client.ts";
import { streamableHttpTransport } from "../../src/http.ts";
import { stdioTransport } from "../../src/stdio.ts";
import type { Seen, ServerScript } from "./server.ts";

const STDIO_SERVER = new URL("./stdio-server.ts", import.meta.url).pathname;

type Extra = Partial<Omit<McpClientOptions, "name" | "transport">>;

/** The scripted server started as a stdio server is: a child process, the script in its environment. */
export function stdioClient(script: ServerScript, extra: Extra = {}): McpClient {
  return new McpClient({
    name: "scripted",
    transport: stdioTransport({ command: process.execPath, args: [STDIO_SERVER], env: { MCP_SCRIPT: JSON.stringify(script) } }),
    timeoutMs: 5_000,
    ...extra,
  });
}

/** A client of the scripted HTTP server at `url`, reopening its stream after 5 ms rather than a second. */
export function httpClient(url: string, extra: Extra = {}): McpClient {
  return new McpClient({ name: "scripted", transport: streamableHttpTransport({ url, listenRetryMs: 5 }), timeoutMs: 5_000, ...extra });
}

/** What the scripted server has seen, asked through its own `stats` tool — so it is read after everything sent before it. */
export async function statsOf(client: McpClient): Promise<Seen> {
  return JSON.parse((await client.callTool("stats", {})).text) as Seen;
}
