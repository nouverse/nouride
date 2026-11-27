/**
 * An http MCP server's headers that hold a credential (`header_secrets`, issue #43): each read from the secret store by
 * its name as the server is reached, sent beside its literal headers and its bearer token; one not stored stops the
 * connect, naming it, rather than turning into a 401 on every call.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@nouride/shared";
import { transportFor } from "@/modules/tools/mcp-transport.ts";
import { eventually } from "../wait.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const STORE: Record<string, string> = { crm_token: "the-token", crm_key: "the-key" };
const secrets = {
  require: (name: string, usedBy: string) => {
    const value = STORE[name];
    if (value === undefined) throw new Error(`${usedBy} needs the secret "${name}", which is not set`);
    return value;
  },
};

const CRM: McpServerConfig = {
  name: "crm",
  transport: "streamable-http",
  url: "https://crm.example/mcp",
  headers: { "x-client-version": "2" },
  headerSecrets: { "x-app-key": "crm_key" },
  authSecret: "crm_token",
};

describe("header_secrets", () => {
  test("each sent as its secret holds it, beside the literal headers and the bearer token", async () => {
    const seen: Record<string, string>[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const transport = transportFor("nox", CRM, { secrets })({ onMessage: () => {}, onLog: () => {}, onClose: () => {} });
    transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    await eventually(() => seen.length > 0);
    expect(seen[0]).toMatchObject({ "x-client-version": "2", "x-app-key": "the-key", authorization: "Bearer the-token" });
    await transport.close();
  });

  test("one not stored stops the connect, naming the secret and the header", () => {
    expect(() => transportFor("nox", { ...CRM, headerSecrets: { "x-app-key": "never_stored" } }, { secrets })).toThrow('header x-app-key needs the secret "never_stored"');
  });
});
