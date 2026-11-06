/**
 * Where a remote MCP server's login goes: the names its tokens are kept under, which servers bring a credential of
 * their own, the address the browser comes back to, the link a person is sent — and what the browser came back with.
 */

import { describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@nouride/shared";
import { hasOwnCredential, loginLinkFor, loginSecrets, redirectAnswer, redirectUriFor } from "@/modules/mcp-oauth/where.ts";

const remote = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({ name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp", ...over });

describe("the secret store's names for a login", () => {
  test("are one per token and one for a client's secret, named after the agent and the server", () => {
    expect(loginSecrets("nouva", "notion")).toEqual({
      access: "mcp-oauth-nouva-notion-access",
      refresh: "mcp-oauth-nouva-notion-refresh",
      client: "mcp-oauth-nouva-notion-client",
    });
  });

  test("are none when they would not fit the store's 63 characters, or are no names at all", () => {
    expect(loginSecrets("an-agent-with-a-long-name", "a-server-with-a-long-name")).toBeNull();
    expect(loginSecrets("nouva", "notion.so")).toBeNull();
  });
});

describe("a credential of the server's own", () => {
  test("is an auth_secret, or an Authorization header in any case — and nothing else", () => {
    expect(hasOwnCredential(remote({ authSecret: "notion_token" }))).toBe(true);
    expect(hasOwnCredential(remote({ headers: { authorization: "Basic x" } }))).toBe(true);
    expect(hasOwnCredential(remote({ headers: { "X-Client": "nouride" } }))).toBe(false);
    expect(hasOwnCredential(remote())).toBe(false);
  });
});

describe("where the browser comes back to", () => {
  test("the dashboard's callback at its public address — or on this machine's loopback without one", () => {
    expect(redirectUriFor({ publicUrl: "https://box.example.com/", port: 18254 })).toBe("https://box.example.com/dashboard/oauth/mcp/callback");
    expect(redirectUriFor({ publicUrl: "  ", port: 18254 })).toBe("http://127.0.0.1:18254/dashboard/oauth/mcp/callback");
  });

  test("and the link a person is sent names the agent's MCP page and the command", () => {
    expect(loginLinkFor({ publicUrl: "https://box.example.com", port: 1 }, "nouva", "notion")).toBe(
      "https://box.example.com/dashboard/agents/nouva/mcp (or `nouride mcp login --server notion --agent nouva`)",
    );
    // The library's login is made on Configure → MCP, for every agent that uses it.
    expect(loginLinkFor({ publicUrl: "https://box.example.com", port: 1 }, "shared", "notion")).toBe(
      "https://box.example.com/dashboard/mcp (or `nouride mcp login --server notion`)",
    );
  });
});

describe("what the browser came back with", () => {
  test("is a code and a state — given as such, or in the address it landed on", () => {
    expect(redirectAnswer({ code: "c-1", state: "s-1" })).toEqual({ code: "c-1", state: "s-1" });
    expect(redirectAnswer({ url: " http://127.0.0.1:18254/dashboard/oauth/mcp/callback?code=c-2&state=s-2 " })).toEqual({ code: "c-2", state: "s-2" });
  });

  test("is the server's refusal, with its state, when that is what the address says", () => {
    expect(redirectAnswer({ url: "http://x/cb?error=access_denied&error_description=The+person+said+no&state=s-3" })).toEqual({
      error: "the login was not given: access_denied (The person said no)",
      state: "s-3",
    });
  });

  test("is refused when it carries no code or state, or is not an address", () => {
    expect(redirectAnswer({ url: "http://x/cb?state=s-4" })).toHaveProperty("error");
    expect(redirectAnswer({ code: "c-5" })).toHaveProperty("error");
    expect(redirectAnswer({ url: "not an address" })).toEqual({ error: expect.stringContaining("not the address") });
  });
});
