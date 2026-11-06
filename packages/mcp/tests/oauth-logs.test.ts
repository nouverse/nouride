/**
 * No code, verifier or token reaches a log line — through a whole login and everything after it at debug, including
 * the failures whose text comes from somewhere else: a store that throws quoting the tokens it could not write, a
 * renewal that throws quoting the refresh token it sent, a server that refuses the refresh token outright.
 *
 * Bare values, deliberately. The logger already masks a value under a key named like a credential and an
 * `Authorization` value in text (`log-redact.ts`); a code under `code`, a verifier under `verifier` or a token said in
 * a sentence pass it, and only this package keeping them out of its lines stops them.
 */

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { addLogSink, configureLogger } from "@nouride/shared";
import { McpAuthRequiredError, McpClient, refreshTokens, streamableHttpTransport, type McpAuth } from "../src/index.ts";
import { loggedIn } from "./fixtures/logged-in.ts";
import { eventually } from "./wait.ts";

let capturing = false;
const lines: string[] = [];
addLogSink((entry) => void (capturing && lines.push(JSON.stringify(entry))));
beforeAll(() => configureLogger({ level: "debug" }));
afterAll(() => configureLogger({ level: "info" }));

const running: { stop(): Promise<unknown> }[] = [];
const clients: McpClient[] = [];
afterEach(async () => {
  capturing = false;
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((servers) => servers.stop()));
});

async function connected(l: Awaited<ReturnType<typeof loggedIn>>, auth: McpAuth): Promise<McpClient> {
  const client = new McpClient({ name: "remote", transport: streamableHttpTransport({ url: l.servers.mcpUrl, auth }), timeoutMs: 5_000 });
  clients.push(client);
  await client.connect();
  await eventually(() => l.servers.initialized(), 4_000, "the initialized notification to reach the server");
  return client;
}

test("a login, its renewals and its failures leave no code, verifier or token in any line written", async () => {
  const written: string[] = [];
  const out = spyOn(console, "log").mockImplementation((line: unknown) => void written.push(String(line)));
  const err = spyOn(console, "error").mockImplementation((line: unknown) => void written.push(String(line)));
  capturing = true;
  let clock = 1_000_000;
  const now = () => clock;
  try {
    const l = await loggedIn({ expiresIn: 3600 }, now);
    running.push(l.servers);
    let flaky = true;
    const remote = await connected(
      l,
      l.auth({
        // A store that fails, quoting what it could not write — as an exception from somebody else's code may.
        onTokens: (next) => Promise.reject(new Error(`the disk refused ${next.accessToken} and ${next.refreshToken}`)),
        // A renewal that fails once ahead of expiry, quoting the refresh token it sent, then works.
        refresh: async (current) => {
          if (flaky) {
            flaky = false;
            throw new Error(`the network dropped while sending ${current.refreshToken} for ${current.accessToken}`);
          }
          return await refreshTokens(l.discovery, l.client, current, { now });
        },
      }),
    );
    clock = l.tokens.expiresAt! - 10_000;
    await remote.callTool("echo", { text: "renewal failed once, then the old token was sent" });
    l.servers.revokeAll();
    await remote.callTool("echo", { text: "renewed on a 401" });

    // A second login whose refresh token the server refuses: the warning that it is lost, and the call refused.
    const refused = await loggedIn({ refusesRefresh: true }, now);
    running.push(refused.servers);
    const gone = await connected(refused, refused.auth());
    refused.servers.revokeAll();
    await expect(gone.callTool("echo", { text: "x" })).rejects.toBeInstanceOf(McpAuthRequiredError);

    const secrets = [...l.servers.issued, ...refused.servers.issued, l.verifier, refused.verifier];
    expect(secrets.length).toBeGreaterThanOrEqual(10);
    // The lines were written — a capture that saw nothing would pass for the wrong reason.
    expect(lines.some((line) => line.includes("could not store an MCP server's renewed login"))).toBe(true);
    expect(lines.some((line) => line.includes("could not renew an MCP server's login ahead of its expiry"))).toBe(true);
    expect(lines.some((line) => line.includes("can no longer be renewed"))).toBe(true);
    for (const line of [...lines, ...written]) {
      for (const secret of secrets) expect(line.includes(secret), `${secret} in ${line}`).toBe(false);
    }
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});
