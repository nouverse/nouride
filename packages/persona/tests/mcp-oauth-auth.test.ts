/**
 * `auth = "oauth"` on a remote MCP server (0.7.19): a server a person logged in to, its tokens in the secret store. The
 * one value it takes, the one kind of server it fits, and never beside a credential of the server's own.
 */

import { describe, expect, test } from "bun:test";
import { parseMcpServers } from "../src/config.ts";

// The library's reading of a server (`agents/mcp.toml`), the one place a server is declared since 0.7.19.
const server = (over: Record<string, unknown>) =>
  parseMcpServers([{ name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp", ...over }], "agents/mcp.toml", "[[servers]]")[0];

describe("auth = oauth", () => {
  test("is read on a remote server, either transport, and absent stays absent", () => {
    expect(server({ auth: "oauth" })).toMatchObject({ name: "notion", auth: "oauth" });
    expect(server({ transport: "sse", url: "https://x.example/sse", auth: "oauth" })).toMatchObject({ auth: "oauth" });
    expect(server({})).not.toHaveProperty("auth");
    // A header that is not the credential's place is fine beside it.
    expect(server({ auth: "oauth", headers: { "X-Client": "nouride" } })).toMatchObject({ auth: "oauth", headers: { "X-Client": "nouride" } });
  });

  test("takes no other value", () => {
    expect(() => server({ auth: "bearer" })).toThrow('auth must be "oauth"');
    expect(() => server({ auth: true })).toThrow('auth must be "oauth"');
  });

  test("is refused on a stdio server", () => {
    expect(() => server({ transport: "stdio", url: undefined, command: "npx", auth: "oauth" })).toThrow("is for a remote server");
  });

  test("is refused beside auth_secret, or an Authorization header in any case", () => {
    expect(() => server({ auth: "oauth", auth_secret: "notion_token" })).toThrow("auth_secret are two credentials");
    expect(() => server({ auth: "oauth", headers: { authorization: "Basic x" } })).toThrow("an Authorization header are two credentials");
    expect(() => server({ auth: "oauth", headers: { AUTHORIZATION: "x" } })).toThrow("two credentials");
  });
});
