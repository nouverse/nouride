/**
 * The install's MCP library and each agent's word on it (0.7.19): an agent's `mcp.toml` read strictly and written back
 * the same, and the servers an agent ends up using — the library's it switched on, its own credential laid over, whose
 * login each is reached with.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseToml } from "@nouride/runtime";
import type { McpServerConfig } from "@nouride/shared";
import { effectiveMcpServers, parseAgentMcp, parseMcpLibrary, readMcpLibrary, renderAgentMcp, SHARED_LOGIN } from "../src/mcp-library.ts";

const notion: McpServerConfig = { name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp" };
const github: McpServerConfig = { name: "github", transport: "stdio", command: "npx", args: ["-y", "gh-mcp"], envSecrets: { GITHUB_TOKEN: "mcp-lib-github-github_token", GITHUB_HOST: "mcp-lib-github-github_host" } };
const mail: McpServerConfig = { name: "mail", transport: "streamable-http", url: "https://mail.example/mcp", authSecret: "mcp-lib-mail", perAgent: true };
const library = [notion, github, mail];

describe("an agent's choices", () => {
  test("off unless on — a server it has no word on is not its", () => {
    expect(effectiveMcpServers("nouva", library, {})).toEqual([]);
    expect(effectiveMcpServers("nouva", library, { notion: { on: false } })).toEqual([]);
    expect(effectiveMcpServers("nouva", library, { notion: { on: true } }).map((server) => server.name)).toEqual(["notion"]);
  });

  test("the library's credential and login, unless the agent has its own — variable by variable", () => {
    const [shared] = effectiveMcpServers("nouva", library, { github: { on: true } });
    expect(shared).toMatchObject({ envSecrets: github.envSecrets, loginAs: SHARED_LOGIN });
    const [own] = effectiveMcpServers("nox", library, { github: { on: true, envSecrets: { GITHUB_TOKEN: "mcp-nox-github-github_token" } } });
    expect(own?.envSecrets).toEqual({ GITHUB_TOKEN: "mcp-nox-github-github_token", GITHUB_HOST: "mcp-lib-github-github_host" });
    const [login] = effectiveMcpServers("nox", library, { notion: { on: true, login: "own" } });
    expect(login?.loginAs).toBe("nox");
  });

  test("a per-agent server takes nothing of the library's credential, and its login is the agent's", () => {
    const [bare] = effectiveMcpServers("nouva", library, { mail: { on: true } });
    expect(bare?.authSecret).toBeUndefined();
    expect(bare?.loginAs).toBe("nouva");
    const [given] = effectiveMcpServers("nouva", library, { mail: { on: true, authSecret: "mcp-nouva-mail" } });
    expect(given?.authSecret).toBe("mcp-nouva-mail");
  });
});

describe("an agent's mcp.toml", () => {
  test("read strictly: a typo is said, with where", () => {
    expect(() => parseAgentMcp({ servers: { notion: { on: "yes" } } }, "agents/nouva/mcp.toml")).toThrow("[servers.notion] on must be true or false");
    expect(() => parseAgentMcp({ servers: { notion: { on: true, login: "mine" } } }, "w")).toThrow('login must be "own"');
    expect(() => parseAgentMcp({ servers: { gh: { on: true, env_secrets: { "1BAD": "x" } } } }, "w")).toThrow("not an environment variable's name");
    // A value where a secret's name belongs is refused, as it is in config.toml.
    expect(() => parseAgentMcp({ servers: { gh: { on: true, auth_secret: "ghp_1234567890abcdefghijklmnopqrstuvwxyz" } } }, "w")).toThrow();
  });

  test("written back the same: the file is a record of choices, nothing else", () => {
    const choices = { notion: { on: true, login: "own" as const }, github: { on: false }, gh: { on: true, envSecrets: { GITHUB_TOKEN: "mcp-nox-gh-github_token" }, authSecret: "mcp-nox-gh" } };
    const text = renderAgentMcp(choices);
    expect(parseAgentMcp(parseToml(text) as Record<string, unknown>, "w")).toEqual(choices);
    // Sorted, so the diff of a switch is one table.
    expect(text.indexOf("[servers.gh]")).toBeLessThan(text.indexOf("[servers.github]"));
  });
});

describe("the library", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-library-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("read as the packs' blocks are — the same rules, said with where — and an old login mark is not carried", () => {
    expect(parseMcpLibrary({ servers: [{ name: "notion", transport: "streamable-http", url: "https://x/mcp", auth: "oauth" }] })).toEqual([
      { name: "notion", transport: "streamable-http", url: "https://x/mcp" },
    ]);
    expect(() => parseMcpLibrary({ servers: [{ name: "a__b", transport: "stdio", command: "x" }] })).toThrow("agents/mcp.toml [[servers]] #1");
  });

  test("a library that does not load is read as empty and says why — one typo does not keep every agent from starting", async () => {
    writeFileSync(join(dir, "mcp.toml"), "[[servers]]\nname = 'x'\ntransport = 'stdio'\n");
    const broken = await readMcpLibrary(dir);
    expect(broken.servers).toEqual([]);
    expect(broken.error).toContain("needs a command");
    writeFileSync(join(dir, "mcp.toml"), "[[servers]]\nname = 'x'\ntransport = 'stdio'\ncommand = 'npx'\n");
    expect((await readMcpLibrary(dir)).servers.map((server) => server.name)).toEqual(["x"]);
  });

  test("a change is read even when the file's time did not move — two writes in one millisecond share it on Linux", async () => {
    const path = join(dir, "mcp.toml");
    // One whole second for both, so the two writes' times are equal to the last digit, as they are on a coarse clock.
    const same = 1_700_000_000;
    writeFileSync(path, "[[servers]]\nname = 'a'\ntransport = 'stdio'\ncommand = 'npx'\n");
    utimesSync(path, same, same);
    expect((await readMcpLibrary(dir)).servers.map((server) => server.name)).toEqual(["a"]);
    writeFileSync(path, "[[servers]]\nname = 'b'\ntransport = 'stdio'\ncommand = 'npx'\n");
    utimesSync(path, same, same);
    expect((await readMcpLibrary(dir)).servers.map((server) => server.name)).toEqual(["b"]);
  });

  test("none at all is an empty library, not an error", async () => {
    expect(await readMcpLibrary(dir)).toEqual({ servers: [] });
  });
});
