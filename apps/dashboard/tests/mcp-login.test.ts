/**
 * A remote MCP server's login on the MCP page (0.7.19): what a card says about it, when it asks for a client id, and
 * the page a login comes back to staying put for a visitor who is signed out — sent to the login form, the code and
 * the state in its address would be gone.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type McpServer, type Principal } from "@/commons/lib/api";
import { MCP_LOGIN_CALLBACK, redirectFor } from "@/commons/lib/session";
import { loginLine, McpServerLogin, needsClientId } from "@/commons/components/mcp/McpServerLogin";

const remote = { transport: "streamable-http" as const };
const login = { scope: "read write", loggedInBy: "gading", loggedInAt: 1, expiresAt: null };

describe("what a card says about a login", () => {
  test("a server waiting for one asks for it — again, when it had one", () => {
    expect(loginLine({ ...remote, needsLogin: true })).toBe("Needs a login before its tools work.");
    expect(loginLine({ ...remote, needsLogin: true, login })).toBe("Its login stopped working. Log in again to use its tools.");
  });

  test("a connected one says who pressed Connect, where and when — never as if it were the service's account", () => {
    const line = loginLine({ ...remote, login })!;
    expect(line).toMatch(/^Connected: by gading from the dashboard, .+\. Access: read write\.$/);
    expect(line).not.toMatch(/logged in (with|by)/i);
    // Notion's scope is "default", which says nothing — it read as "logged in with default".
    expect(loginLine({ ...remote, login: { ...login, scope: "default" } })).not.toContain("default");
    expect(loginLine({ ...remote, login: { ...login, scope: null } })).not.toContain("Access");
    // Finished in a terminal on the server: said as that, never by its command (0.8.19, plain words).
    expect(loginLine({ ...remote, login: { ...login, loggedInBy: "cli" } })).toMatch(/^Connected: on the server itself, .+\. Access: read write\.$/);
  });

  test("nothing for a stdio server, or a remote one with nothing to log in to", () => {
    expect(loginLine({ transport: "stdio", needsLogin: true })).toBeNull();
    expect(loginLine(remote)).toBeNull();
  });
});

describe("a client id", () => {
  test("is asked for when the server registers nobody, and not for any other failure", () => {
    expect(needsClientId(new ApiError(400, "the authorization server https://github.com/login/oauth offers no dynamic client registration, so logging in to it needs a client id — …"))).toBe(true);
    expect(needsClientId(new ApiError(400, "found no metadata for the authorization server"))).toBe(false);
    expect(needsClientId(null)).toBe(false);
  });
});

describe("the card's login section", () => {
  const server = (over: Partial<McpServer>): McpServer => ({ name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp", hasCredential: false, connected: false, running: true, tools: 0, ...over });
  const as = (role: Principal["role"], shown: McpServer): string => {
    const client = new QueryClient();
    client.setQueryData(["me"], { kind: "user", role, actor: "gading", user: null } satisfies Principal);
    return renderToString(createElement(QueryClientProvider, { client }, createElement(McpServerLogin, { scope: { agentId: "nouva" }, server: shown, onChanged: () => {} })));
  };

  test("offers Connect to an admin while the server waits for a login — and Log out once it has one", () => {
    const waiting = as("admin", server({ needsLogin: true }));
    expect(waiting).toMatch(/<\/svg> ?Connect</);
    expect(waiting).not.toContain("Log out");
    const loggedIn = as("admin", server({ connected: true, login }));
    expect(loggedIn).toContain("Log out");
    // The Connect button, not the word: the line says "Connected: by …".
    expect(loggedIn).not.toMatch(/<\/svg> ?Connect</);
  });

  test("offers neither to anybody else, who still reads what it says", () => {
    const waiting = as("operator", server({ needsLogin: true }));
    expect(waiting).toContain("Needs a login");
    expect(waiting).not.toContain("Connect");
    expect(as("viewer", server({ connected: true, login }))).not.toContain("Log out");
  });
});

describe("the page a login comes back to", () => {
  test("stays put for a visitor who is signed out — every other page sends them to sign in", () => {
    expect(redirectFor(null, null, `${MCP_LOGIN_CALLBACK}`)).toBeNull();
    expect(redirectFor(null, null, "/agents/nouva/mcp")).toBe(`/login?next=${encodeURIComponent("/agents/nouva/mcp")}`);
    expect(redirectFor(null, null, "/")).toBe("/login");
  });
});
