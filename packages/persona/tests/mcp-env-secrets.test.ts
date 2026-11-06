/**
 * A stdio MCP server's credential variables (0.7.19): `env_secrets = { GITHUB_TOKEN = "github_token" }` names a secret
 * per variable, the way `auth_secret` does for an http server — so a token stops living in `env`, a file people commit.
 */

import { describe, expect, test } from "bun:test";
import { parseMcpServers } from "../src/config.ts";

// The library's reading of a server (`agents/mcp.toml`), the one place a server is declared since 0.7.19.
const server = (over: Record<string, unknown>) =>
  parseMcpServers([{ name: "gh", transport: "stdio", command: "npx", ...over }], "agents/mcp.toml", "[[servers]]")[0];

describe("env_secrets", () => {
  test("is read as variable → secret name, beside the literal env", () => {
    expect(server({ env: { LOG_LEVEL: "info" }, env_secrets: { GITHUB_TOKEN: "github_token" } })).toMatchObject({
      env: { LOG_LEVEL: "info" },
      envSecrets: { GITHUB_TOKEN: "github_token" },
    });
  });

  test("refuses a value that is the credential itself — the reason the table exists", () => {
    expect(() => server({ env_secrets: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345" } })).toThrow("looks like a credential");
  });

  test("refuses a variable env sets too, a name that is not a variable's, and an http server", () => {
    expect(() => server({ env: { GITHUB_TOKEN: "x" }, env_secrets: { GITHUB_TOKEN: "github_token" } })).toThrow("set in both env and env_secrets");
    expect(() => server({ env_secrets: { "GITHUB-TOKEN": "github_token" } })).toThrow("not an environment variable's name");
    expect(() => server({ transport: "streamable-http", command: undefined, url: "https://x/mcp", env_secrets: { T: "t" } })).toThrow("auth_secret");
  });
});
