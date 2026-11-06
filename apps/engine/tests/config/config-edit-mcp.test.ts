/**
 * Editing `[[servers]]` in the install's MCP library (`agents/mcp.toml`).
 *
 * An array of tables, which the general editor deliberately refuses — so this one is narrow on purpose
 * and the tests pin the narrowness. The property that matters most is the same as everywhere else in
 * this file: the library is hand-edited config-as-code, and an edit that eats the operator's comments is
 * discovered weeks later when nobody remembers what was there.
 */

import { describe, expect, test } from "bun:test";
import { parseToml } from "@nouride/runtime";
import { removeMcpServer, upsertMcpServer } from "@/modules/config/edit-blocks.ts";

/** Any hand-edited TOML: the editor touches the `[[servers]]` blocks and nothing around them. */
const PACK = `# Agent config — hand-edited, keep the comments.

[agent]
name = "nouva"

[llm]
provider = "default"
model = "some-model"

# Which chats this agent answers in.
[channels]
"telegram:bot" = ["123"]
`;

const SERVER = {
  name: "nouva-mcp",
  transport: "stdio" as const,
  command: "python3",
  args: ["/opt/nouva-mcp-server/src/main.py", "--transport", "stdio"],
  cwd: "/opt/nouva-mcp-server",
};

function servers(source: string): { name?: string; cwd?: string; args?: string[] }[] {
  return (parseToml<{ servers?: never[] }>(source).servers ?? []) as never[];
}

describe("adding a server", () => {
  test("appends a block that parses back to what went in", () => {
    const next = upsertMcpServer(PACK, SERVER);
    const [server] = servers(next);

    expect(server?.name).toBe("nouva-mcp");
    expect(server?.cwd).toBe("/opt/nouva-mcp-server");
    expect(server?.args).toEqual([
      "/opt/nouva-mcp-server/src/main.py",
      "--transport",
      "stdio",
    ]);
  });

  test("leaves every other byte alone", () => {
    const next = upsertMcpServer(PACK, SERVER);

    expect(next).toContain("# Agent config — hand-edited, keep the comments.");
    expect(next).toContain("# Which chats this agent answers in.");
    expect(next).toContain('"telegram:bot" = ["123"]');
    const parsed = parseToml<{ llm: { model: string } }>(next);
    expect(parsed.llm.model).toBe("some-model");
  });

  test("writes an env inline table that round-trips", () => {
    const next = upsertMcpServer(PACK, { ...SERVER, env: { MEMORY_DIR: "/data/memory" } });
    const parsed = parseToml<{ servers: { env: Record<string, string> }[] }>(next);
    expect(parsed.servers[0]?.env).toEqual({ MEMORY_DIR: "/data/memory" });
  });
});

describe("updating a server", () => {
  test("replaces the one with that name rather than adding a second", () => {
    const once = upsertMcpServer(PACK, SERVER);
    const twice = upsertMcpServer(once, { ...SERVER, cwd: "/opt/moved" });

    // The bug this catches: two blocks with the same name, where the loader takes one and the operator
    // reads the other.
    expect(servers(twice)).toHaveLength(1);
    expect(servers(twice)[0]?.cwd).toBe("/opt/moved");
  });

  test("a different name is a second server, not a replacement", () => {
    const once = upsertMcpServer(PACK, SERVER);
    const twice = upsertMcpServer(once, { name: "other", transport: "stdio", command: "node" });

    expect(servers(twice).map((s) => s.name)).toEqual(["nouva-mcp", "other"]);
  });

  test("repeated saves do not grow or eat blank lines", () => {
    let next = upsertMcpServer(PACK, SERVER);
    const after = next;
    for (let i = 0; i < 3; i += 1) next = upsertMcpServer(next, SERVER);

    // A file that gains a blank line every time a setting is saved looks corrupted even though it
    // parses.
    expect(next).toBe(after);
  });
});

describe("removing a server", () => {
  test("takes the block and nothing else", () => {
    const with2 = upsertMcpServer(
      upsertMcpServer(PACK, SERVER),
      { name: "other", transport: "stdio", command: "node" },
    );
    const next = removeMcpServer(with2, "nouva-mcp");

    expect(servers(next).map((s) => s.name)).toEqual(["other"]);
    expect(next).toContain("# Which chats this agent answers in.");
  });

  test("an unknown name changes nothing", () => {
    const once = upsertMcpServer(PACK, SERVER);
    expect(removeMcpServer(once, "not-there")).toBe(once);
  });

  test("removing the last one leaves a file that still parses", () => {
    const once = upsertMcpServer(PACK, SERVER);
    const next = removeMcpServer(once, "nouva-mcp");

    expect(servers(next)).toHaveLength(0);
    expect(parseToml<{ agent: { name: string } }>(next).agent.name).toBe("nouva");
  });
});
