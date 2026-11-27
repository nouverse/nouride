/**
 * An http MCP server's headers (issue #43): more than one, each a literal (`headers`) or a stored secret's name
 * (`header_secrets`), and one the daemon fills with who a call is made for (`identity`). Every way a server names a
 * header is held to one value per header: two would leave which one the server read to whichever was written last.
 */

import { describe, expect, test } from "bun:test";
import { parseAgentMcp, effectiveMcpServers } from "../src/mcp-library.ts";
import { parseMcpServers } from "../src/config.ts";

const server = (over: Record<string, unknown>) =>
  parseMcpServers([{ name: "crm", transport: "streamable-http", url: "https://crm.example/mcp", ...over }], "agents/mcp.toml", "[[servers]]")[0]!;

describe("header_secrets", () => {
  test("is read as header → secret name, beside the literal headers and the bearer token", () => {
    expect(server({ headers: { "x-client-version": "2" }, header_secrets: { "x-app-key": "crm_key" }, auth_secret: "crm_token" })).toMatchObject({
      headers: { "x-client-version": "2" },
      headerSecrets: { "x-app-key": "crm_key" },
      authSecret: "crm_token",
    });
  });

  test("refuses the credential itself, a name no header has, and a stdio server", () => {
    expect(() => server({ header_secrets: { "x-app-key": "sk-live-0123456789abcdefghijABCDEFGHIJ0123" } })).toThrow("looks like a credential");
    expect(() => server({ header_secrets: { "x app key": "crm_key" } })).toThrow("is not a header's name");
    expect(() => parseMcpServers([{ name: "gh", command: "npx", header_secrets: { "x-a": "a" } }], "agents/mcp.toml")).toThrow("env_secrets");
  });
});

describe("identity", () => {
  test("is read with what an unknown sender gets, omit unless said", () => {
    expect(server({ identity: { header: "x-app-sender", format: "{person_key}" } }).identity).toEqual({ header: "x-app-sender", format: "{person_key}", onUnknown: "omit" });
    expect(server({ identity: { header: "x-app-sender", format: "{account}", on_unknown: "fail" } }).identity?.onUnknown).toBe("fail");
  });

  test("refuses a format that names no sender, a field the daemon does not fill, a stdio server, and an unknown key", () => {
    expect(() => server({ identity: { header: "x-app-sender", format: "everyone" } })).toThrow("names no sender");
    expect(() => server({ identity: { header: "x-app-sender", format: "{email}" } })).toThrow("{email} is not something the daemon fills");
    expect(() => server({ identity: { header: "x-app-sender", on_unknown: "guess" } })).toThrow("on_unknown");
    expect(() => server({ identity: { header: "x-app-sender", sender: "x" } })).toThrow("identity.sender is not a key");
    expect(() => parseMcpServers([{ name: "gh", command: "npx", identity: { header: "x-a" } }], "agents/mcp.toml")).toThrow("one process for every sender");
  });
});

describe("one value per header", () => {
  test("a header two ways set is refused, whatever its case", () => {
    expect(() => server({ headers: { "X-App-Key": "a" }, header_secrets: { "x-app-key": "crm_key" } })).toThrow("x-app-key is set by both headers and header_secrets");
    expect(() => server({ auth_secret: "crm_token", header_secrets: { authorization: "crm_key" } })).toThrow("auth_secret (as a bearer token)");
    expect(() => server({ auth_secret: "crm_token", auth_header: "x-api-key", identity: { header: "X-API-Key", format: "{account}" } })).toThrow("identity");
  });
});

describe("an agent's own header secrets on a library server", () => {
  const library = [server({ header_secrets: { "x-app-key": "crm_key", "x-tenant-key": "tenant_key" } })];

  test("over the library's, header by header", () => {
    const choices = parseAgentMcp({ servers: { crm: { on: true, header_secrets: { "x-app-key": "nox_crm_key" } } } }, "agents/nox/mcp.toml");
    expect(effectiveMcpServers("nox", library, choices)[0]!.headerSecrets).toEqual({ "x-app-key": "nox_crm_key", "x-tenant-key": "tenant_key" });
  });

  test("none of the library's for a per_agent server, whose credential is each agent's own", () => {
    const perAgent = [{ ...library[0]!, perAgent: true }];
    const choices = parseAgentMcp({ servers: { crm: { on: true, header_secrets: { "x-app-key": "nox_crm_key" } } } }, "agents/nox/mcp.toml");
    expect(effectiveMcpServers("nox", perAgent, choices)[0]!.headerSecrets).toEqual({ "x-app-key": "nox_crm_key" });
    expect(effectiveMcpServers("nox", perAgent, { crm: { on: true } })[0]!.headerSecrets).toBeUndefined();
  });
});
