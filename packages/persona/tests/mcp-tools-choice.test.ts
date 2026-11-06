/**
 * Which of a server's tools an agent gets (0.7.21): `tools = [...]` in the agent's switch (`agents/<id>/mcp.toml`) or
 * in a pack's own `[[mcp_servers]]`, read strictly, written back the same, and carried to the server the agent uses.
 * Absent is every tool — what every install had before — and the library itself never chooses for an agent.
 */

import { describe, expect, test } from "bun:test";
import { parseToml } from "@nouride/runtime";
import type { McpServerConfig } from "@nouride/shared";
import { parseMcpServers } from "../src/config.ts";
import { effectiveMcpServers, parseAgentMcp, parseMcpLibrary, renderAgentMcp } from "../src/mcp-library.ts";

const notion: McpServerConfig = { name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp" };

describe("an agent's tools list", () => {
  test("absent is every tool: nothing changes for a switch written before it existed", () => {
    const choices = parseAgentMcp(parseToml('[servers.notion]\non = true\n'), "agents/nox/mcp.toml");
    expect(choices.notion).toEqual({ on: true });
    const [server] = effectiveMcpServers("nox", [notion], choices);
    expect(server).not.toHaveProperty("tools");
  });

  test("read, carried to the server the agent uses, and written back the same", () => {
    const text = '[servers.notion]\non = true\ntools = ["notion-search", "notion-fetch"]\n';
    const choices = parseAgentMcp(parseToml(text), "agents/nox/mcp.toml");
    expect(choices.notion?.tools).toEqual(["notion-search", "notion-fetch"]);
    expect(effectiveMcpServers("nox", [notion], choices)[0]?.tools).toEqual(["notion-search", "notion-fetch"]);
    const rendered = renderAgentMcp(choices);
    expect(rendered).toContain('tools = ["notion-search", "notion-fetch"]');
    expect(parseAgentMcp(parseToml(rendered), "again")).toEqual(choices);
  });

  test("anything but a list of names is said, with where", () => {
    expect(() => parseAgentMcp(parseToml('[servers.notion]\non = true\ntools = "notion-search"\n'), "agents/nox/mcp.toml")).toThrow(
      /agents\/nox\/mcp\.toml \[servers\.notion\] tools must be a list/,
    );
    expect(() => parseAgentMcp(parseToml('[servers.notion]\non = true\ntools = [""]\n'), "agents/nox/mcp.toml")).toThrow(/tools must be a list/);
  });

  test("a pack's own server takes the same list", () => {
    const [server] = parseMcpServers([{ name: "docs", command: "docs-mcp", tools: ["search", "search"] }], "agents/nox/config.toml");
    // Once each: a name twice is still one tool.
    expect(server?.tools).toEqual(["search"]);
    expect(() => parseMcpServers([{ name: "docs", command: "docs-mcp", tools: [1] }], "agents/nox/config.toml")).toThrow(/tools must be a list/);
  });

  test("the library does not choose for an agent: a list there is left out", () => {
    const [server] = parseMcpLibrary({ servers: [{ name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp", tools: ["notion-search"] }] });
    expect(server).not.toHaveProperty("tools");
  });
});
