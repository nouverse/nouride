/**
 * Who an MCP call is made for (`tools/mcp-identity.ts`, issue #43): one header a server's `identity` names, filled by
 * the daemon from the turn's resolved sender, never from what a model wrote. A turn with no sender, or a person People
 * does not know where the format needs one, sends no header (`omit`) or is refused the call (`fail`): never an empty
 * header, never the agent's own id.
 */

import { describe, expect, test } from "bun:test";
import type { McpIdentityHeader, Person, ToolContext } from "@nouride/shared";
import { buildMcpTools, type McpToolCaller } from "@/modules/tools/mcp-tools.ts";
import { identityHeaders } from "@/modules/tools/mcp-identity.ts";

const PEOPLE = [
  { key: "ann", name: "Ann", ids: ["whatsapp:6281234@s.whatsapp.net", "telegram:555"] },
  { key: "bob", name: "Bob", ids: ["discord:777"] },
] as unknown as Person[];

const who = (gatewayId: string, senderId: string, senderAlso?: string[]) => ({ gatewayId, senderId, ...(senderAlso ? { senderAlso } : {}) });
const identity = (format: string, onUnknown: "omit" | "fail" = "omit"): McpIdentityHeader => ({ header: "x-app-sender", format, onUnknown });

describe("the header's value", () => {
  test("the account it arrived from, every address the platform names, and the person's key", () => {
    // WhatsApp delivers Ann under a hidden id, and names her number beside it.
    const ann = who("whatsapp:nouva", "998877@lid", ["6281234@s.whatsapp.net"]);
    expect(identityHeaders(identity("{account}"), ann, PEOPLE, "crm")).toEqual({ headers: { "x-app-sender": "whatsapp:998877@lid" } });
    expect(identityHeaders(identity("{accounts}"), ann, PEOPLE, "crm")).toEqual({ headers: { "x-app-sender": "whatsapp:998877@lid, whatsapp:6281234@s.whatsapp.net" } });
    // Known by her number in People, though she arrived under the hidden id.
    expect(identityHeaders(identity("{person_key}"), ann, PEOPLE, "crm")).toEqual({ headers: { "x-app-sender": "ann" } });
    expect(identityHeaders(identity("{person_key}"), who("telegram:nouva", "555"), PEOPLE, "crm")).toEqual({ headers: { "x-app-sender": "ann" } });
    expect(identityHeaders(identity("user={person_key}; via={account}"), who("discord:nero", "777"), PEOPLE, "crm")).toEqual({ headers: { "x-app-sender": "user=bob; via=discord:777" } });
  });

  test("no sender — a schedule, a webhook, a mission — and an unknown person: no header, or the call refused", () => {
    const system = who("telegram:nouva", "nouride:system");
    expect(identityHeaders(identity("{account}"), system, PEOPLE, "crm")).toEqual({ headers: {} });
    expect(identityHeaders(identity("{account}", "fail"), system, PEOPLE, "crm")).toHaveProperty("refused");
    const stranger = who("telegram:nouva", "123");
    expect(identityHeaders(identity("{person_key}"), stranger, PEOPLE, "crm")).toEqual({ headers: {} });
    expect(identityHeaders(identity("{person_key}", "fail"), stranger, PEOPLE, "crm")).toHaveProperty("refused");
    // A stranger's own account is still theirs to say.
    expect(identityHeaders(identity("{account}", "fail"), stranger, PEOPLE, "crm")).toEqual({ headers: { "x-app-sender": "telegram:123" } });
  });

  test("an id that would break the header across lines is never sent", () => {
    expect(identityHeaders(identity("{account}", "fail"), who("web:dashboard", "evil\r\nx-admin: 1"), PEOPLE, "crm")).toHaveProperty("refused");
  });

  test("a server with no identity sends nothing of it", () => {
    expect(identityHeaders(undefined, who("telegram:nouva", "555"), PEOPLE, "crm")).toEqual({ headers: {} });
  });
});

describe("a call through the tool", () => {
  function server() {
    const calls: { args: Record<string, unknown>; headers?: Readonly<Record<string, string>> }[] = [];
    const client: McpToolCaller = {
      async callTool(_name, args, options) {
        calls.push({ args, ...(options?.headers ? { headers: options.headers } : {}) });
        return { text: "ok", isError: false };
      },
    };
    return { client, calls };
  }
  const tool = (client: McpToolCaller, id: McpIdentityHeader) =>
    buildMcpTools({ server: "crm", client, tools: [{ name: "lookup", inputSchema: { type: "object" } }], identity: id, people: () => PEOPLE }).get("crm__lookup")!;
  const ctx = (senderId: string) => ({ agentId: "nouva", gatewayId: "telegram:nouva", senderId }) as ToolContext;

  test("carries the sender the daemon resolved, whatever the model put in the arguments", async () => {
    const s = server();
    await tool(s.client, identity("{person_key}")).execute({ "x-app-sender": "bob", as: "admin" }, ctx("555"));
    expect(s.calls).toEqual([{ args: { "x-app-sender": "bob", as: "admin" }, headers: { "x-app-sender": "ann" } }]);
  });

  test("refused before anything is sent where `fail` finds no sender", async () => {
    const s = server();
    const result = await tool(s.client, identity("{account}", "fail")).execute({}, ctx("nouride:system"));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("no sender it can name");
    expect(s.calls).toEqual([]);
  });
});
