/**
 * The scripted server (`server.ts`) as a child process speaking newline-delimited JSON on stdin and stdout — what a
 * stdio MCP server is. Its script arrives as JSON in `MCP_SCRIPT`.
 *
 * Each line is handled as it arrives and never waited on, so a request of the server's own can be answered while the
 * call that made it is still being read.
 */

import { scriptedServer, type ServerScript } from "./server.ts";

const write = (message: object): void => void process.stdout.write(`${JSON.stringify(message)}\n`);
const server = scriptedServer(JSON.parse(process.env.MCP_SCRIPT ?? "{}") as ServerScript, write);

for await (const line of console) {
  if (!line.trim()) continue;
  const answer = server.handle(JSON.parse(line));
  if (answer) write(answer);
}
