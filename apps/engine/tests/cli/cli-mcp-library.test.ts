/**
 * `nouride mcp` over the library (0.7.19): `add` saves to the library and switches it on for each `--agent`; `enable`
 * and `disable` are one agent's switch, carrying its own credential when one is given; `rm` takes a server out of the
 * library, or with `--agent` only switches it off there.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@/cli/client.ts";
import { mcp } from "@/cli/commands/mcp.ts";

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

function recording(answer: Record<string, unknown> = {}): { client: Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const ack = { ok: true, restartRequired: false, ...answer };
  const client = {
    baseUrl: "http://127.0.0.1:9",
    post: async (path: string, body: unknown) => (sent.push({ method: "POST", path, body }), ack),
    put: async (path: string, body: unknown) => (sent.push({ method: "PUT", path, body }), ack),
    del: async (path: string) => (sent.push({ method: "DELETE", path }), ack),
    get: async () => ({ servers: [] }),
  } as unknown as Client;
  return { client, sent };
}

let printed: string[] = [];
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  printed = [];
  log = spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
});
afterEach(() => log.mockRestore());

describe("nouride mcp add", () => {
  test("into the library, switched on for each --agent", async () => {
    const { client, sent } = recording();
    await mcp(client, ["add", "--name", "files", "--command", "mcp-files", "--agent", "nouva", "--agent", "nox", "--per-agent"]);
    expect(sent).toEqual([{ method: "POST", path: "/mcp/library", body: { name: "files", transport: "stdio", command: "mcp-files", perAgent: true, enable: ["nouva", "nox"] } }]);
  });

  test("a change to a server agents already use says it is on for them, not how to switch it on", async () => {
    const { client } = recording({ on: ["nouva"] });
    await mcp(client, ["add", "--name", "files", "--command", "mcp-files", "--arg", "-v"]);
    expect(printed.join("\n")).toContain("on for nouva");
    expect(printed.join("\n")).not.toContain("switch it on");
  });

  test("without --agent it is in the library and on for nobody — and says how to switch it on", async () => {
    const { client, sent } = recording();
    await mcp(client, ["add", "--name", "notion", "--url", "https://mcp.notion.com/mcp"]);
    expect(sent[0]!.body).not.toHaveProperty("enable");
    expect(printed.join("\n")).toContain("nouride mcp enable notion --agent <id>");
  });
});

describe("nouride mcp enable / disable", () => {
  test("one agent's switch — with the library's credential unless it is given its own", async () => {
    const { client, sent } = recording();
    await mcp(client, ["enable", "gh", "--agent", "nox"]);
    await mcp(client, ["enable", "gh", "--agent", "nox", "--env-secret", "GITHUB_TOKEN=gh_nox"]);
    await mcp(client, ["enable", "notion", "--agent", "nox", "--own-login"]);
    await mcp(client, ["enable", "gh", "--agent", "nox", "--library-credential"]);
    await mcp(client, ["disable", "gh", "--agent", "nox"]);
    expect(sent.map((entry) => [entry.method, entry.path, entry.body])).toEqual([
      ["PUT", "/agents/nox/mcp/gh", { on: true }],
      ["PUT", "/agents/nox/mcp/gh", { on: true, credential: { envSecrets: { GITHUB_TOKEN: { secret: "gh_nox" } } } }],
      ["PUT", "/agents/nox/mcp/notion", { on: true, credential: { login: true } }],
      ["PUT", "/agents/nox/mcp/gh", { on: true, credential: "library" }],
      ["PUT", "/agents/nox/mcp/gh", { on: false }],
    ]);
    expect(printed.join("\n")).toContain("nouride mcp login --server notion --agent nox");
  });

  test("without --agent is a usage error, exit 2, and nothing is sent", async () => {
    const { client, sent } = recording();
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mcp(client, ["enable", "gh"])).rejects.toThrow("exit 2");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
    expect(sent).toEqual([]);
  });
});

describe("nouride mcp rm", () => {
  test("out of the library and every agent — or with --agent, only off for that one", async () => {
    const { client, sent } = recording();
    await mcp(client, ["rm", "gh", "--agent", "nox"]);
    await mcp(client, ["rm", "gh"]);
    expect(sent).toEqual([
      { method: "PUT", path: "/agents/nox/mcp/gh", body: { on: false } },
      { method: "DELETE", path: "/mcp/library/gh" },
    ]);
  });
});

describe("nouride mcp tools", () => {
  /** A client whose GETs answer per path: the server's tools for an agent, and the rest as `answers` says. */
  function serving(answers: Record<string, unknown>) {
    const { client, sent } = recording();
    const reads = client as unknown as { get: unknown; softGet: unknown };
    reads.get = async (path: string) => answers[path] ?? { servers: [] };
    reads.softGet = async (path: string) => {
      if (!(path in answers)) throw new Error("409");
      return answers[path];
    };
    return { client, sent };
  }
  const TOOLS = {
    all: true,
    tools: [
      { name: "notion-search", description: "Search", bytes: 2048, on: true },
      { name: "notion-fetch", description: "Fetch", bytes: 1024, on: true },
    ],
  };

  test("--only gives the agent just those, --all every one again — checked against what the server offers", async () => {
    const { client, sent } = serving({ "/agents/nox/mcp/notion/tools": TOOLS });
    await mcp(client, ["tools", "notion", "--agent", "nox", "--only", "notion-search, notion-fetch"]);
    await mcp(client, ["tools", "notion", "--agent", "nox", "--all"]);
    expect(sent).toEqual([
      { method: "PUT", path: "/agents/nox/mcp/notion", body: { tools: ["notion-search", "notion-fetch"] } },
      { method: "PUT", path: "/agents/nox/mcp/notion", body: { tools: null } },
    ]);
  });

  test("a name the server does not offer is refused before anything is written", async () => {
    const { client, sent } = serving({ "/agents/nox/mcp/notion/tools": TOOLS });
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mcp(client, ["tools", "notion", "--agent", "nox", "--only", "notion-serch"])).rejects.toThrow("exit 1");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
    expect(sent).toEqual([]);
  });

  test("with neither, lists the server's tools with what each adds to a request", async () => {
    const { client } = serving({ "/agents/nox/mcp/notion/tools": TOOLS });
    await mcp(client, ["tools", "notion", "--agent", "nox"]);
    const out = printed.join("\n");
    expect(out).toContain("notion-search");
    expect(out).toContain("2KB");
    expect(out).toContain("3KB of schema per request");
  });
});

describe("nouride mcp (the listing)", () => {
  test("puts the orchestrator first in a server's agents, as the dashboard does", async () => {
    const library = { servers: [{ name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp", agents: [{ id: "alpha", on: true, own: false }, { id: "nouva", on: true, own: false }] }] };
    const client = {
      get: async (path: string) => (path === "/mcp/library" ? library : { servers: [] }),
      softGet: async () => ({ orchestrator: "nouva" }),
    } as unknown as Client;
    await mcp(client, []);
    const agents = printed.filter((line) => /alpha|nouva/.test(line));
    expect(agents[0]).toContain("nouva");
    expect(agents[1]).toContain("alpha");
  });
});
