/**
 * `nouride mcp login` and `logout` (0.7.19): the address to open printed, the one the browser landed on pasted back —
 * which works over SSH, where the browser is on another machine — a hand-registered client's secret asked for rather
 * than typed inline, and the listing saying which servers wait for a login.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { LinePrompt } from "@nouride/runtime";
import type { Client } from "@nouride/cli-kit";
import { mcp } from "@/cli/commands/mcp.ts";

const LOGIN_URL = "https://auth.example.com/authorize?client_id=c&state=s";
const LANDED = "http://127.0.0.1:18254/dashboard/oauth/mcp/callback?code=the-code&state=s";

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

function recording(library: unknown[] = [], live: unknown[] = []): { client: Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    baseUrl: "http://127.0.0.1:9",
    post: async (path: string, body: unknown) => {
      sent.push({ method: "POST", path, body });
      return path.endsWith("/oauth/start") ? { url: LOGIN_URL } : { ok: true, holder: path.includes("/agents/") || sent.some((entry) => entry.path.includes("/agents/")) ? "nouva" : "shared", server: "notion", scope: "read" };
    },
    del: async (path: string) => (sent.push({ method: "DELETE", path }), { ok: true }),
    get: async (path: string) => (sent.push({ method: "GET", path }), { servers: path === "/mcp/library" ? library : live }),
    // `/status`, which the listing reads for the orchestrator: none here.
    softGet: async () => ({ orchestrator: null }),
  } as unknown as Client;
  return { client, sent };
}

/** A terminal that answers each question in turn, and keeps what it was asked. */
function scripted(...answers: string[]): { open: () => LinePrompt; asked: string[] } {
  const asked: string[] = [];
  const answer = async (question: string) => (asked.push(question), answers.shift() ?? "");
  return { asked, open: () => ({ ask: answer, askHidden: answer, onClose: () => {}, close: () => {}, raw: undefined as never }) };
}

let printed: string[] = [];
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  printed = [];
  log = spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
});
afterEach(() => log.mockRestore());

describe("nouride mcp login", () => {
  test("prints the address to open, and finishes with the one the browser landed on", async () => {
    const { client, sent } = recording();
    const terminal = scripted(LANDED);
    await mcp(client, ["login", "--agent", "nouva", "--server", "notion"], terminal.open);

    expect(sent).toEqual([
      { method: "POST", path: "/agents/nouva/mcp/notion/oauth/start", body: {} },
      { method: "POST", path: "/mcp/oauth/finish", body: { url: LANDED } },
    ]);
    expect(printed.join("\n")).toContain(LOGIN_URL);
    expect(terminal.asked).toEqual(["Paste the address the browser landed on: "]);
    expect(printed.join("\n")).toContain("is logged in for nouva");
  });

  test("asks for a hand-registered client's secret — never takes it on the command line", async () => {
    const { client, sent } = recording();
    const terminal = scripted("hand-made-secret", LANDED);
    await mcp(client, ["login", "--agent", "nouva", "--server", "notion", "--client-id", "hand-made"], terminal.open);

    expect(sent[0]).toEqual({ method: "POST", path: "/agents/nouva/mcp/notion/oauth/start", body: { clientId: "hand-made", clientSecret: "hand-made-secret" } });
    expect(terminal.asked[0]).toContain("Client secret for hand-made");
  });

  test("nothing pasted ends it with a failure, and nothing is finished", async () => {
    const { client, sent } = recording();
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mcp(client, ["login", "--agent", "nouva", "--server", "notion"], scripted("  ").open)).rejects.toThrow("exit 1");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
    expect(sent.map((s) => s.path)).toEqual(["/agents/nouva/mcp/notion/oauth/start"]);
  });

  test("without --agent, it is the library's login — every agent that has none of its own", async () => {
    const { client, sent } = recording();
    await mcp(client, ["login", "--server", "notion"], scripted(LANDED).open);
    expect(sent[0]).toEqual({ method: "POST", path: "/mcp/library/notion/oauth/start", body: {} });
    expect(printed.join("\n")).toContain("is logged in for the library");
  });

  test("without --server is a usage error, exit 2, and nothing is sent", async () => {
    const { client, sent } = recording();
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mcp(client, ["login", "--agent", "nouva"], scripted().open)).rejects.toThrow("exit 2");
      await expect(mcp(client, ["logout"], scripted().open)).rejects.toThrow("exit 2");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
    expect(sent).toEqual([]);
  });
});

describe("nouride mcp logout", () => {
  test("deletes the login the agent uses, or the library's without --agent", async () => {
    const { client, sent } = recording();
    await mcp(client, ["logout", "--agent", "nouva", "--server", "notion"]);
    await mcp(client, ["logout", "--server", "notion"]);
    expect(sent).toEqual([
      { method: "DELETE", path: "/agents/nouva/mcp/notion/oauth" },
      { method: "DELETE", path: "/mcp/library/notion/oauth" },
    ]);
  });
});

describe("nouride mcp", () => {
  test("says which servers wait for a login, and the command that logs each in", async () => {
    const agents = [{ id: "nouva", on: true, own: false }];
    const { client } = recording(
      [
        { name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp", needsLogin: true, envSecrets: [], agents },
        { name: "files", transport: "stdio", command: "mcp-files", needsLogin: false, envSecrets: [], agents },
      ],
      [
        { agentId: "nouva", server: "notion", connected: false, tools: 0, schemaBytes: 0, needsLogin: true },
        { agentId: "nouva", server: "files", connected: true, tools: 3, schemaBytes: 900 },
      ],
    );
    await mcp(client, []);
    const lines = printed.join("\n");
    expect(lines).toContain("nouride mcp login --server notion");
    expect(lines.split("\n").filter((line) => line.includes("needs login"))).toHaveLength(1);
  });
});
