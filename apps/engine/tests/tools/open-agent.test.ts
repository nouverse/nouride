/**
 * An agent open to everyone holds the daemon's four tools, whatever its pack lists.
 *
 * `open` was the install's, refused beside any agent with a shell. It is one agent's now, and what makes that safe is
 * held here: nothing that reaches the computer, another agent, another chat or a secret is in what an open agent's
 * model is sent, and a call to one made anyway is refused at the gate, never asked about.
 */

import { describe, expect, test } from "bun:test";
import { isOpenAgent, type Tool, type ToolContext } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { OPEN_AGENT_TOOLS, openToolset } from "@/modules/tools/open-agent.ts";
import { createBuiltinTools, resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent } from "../helpers.ts";

const security = DEFAULT_CONFIG.security;
// With the ports that make the daemon build the two file tools: a real daemon with chat connections has both.
const tools = createBuiltinTools({
  security,
  web: {} as never,
  sessionStatus: (() => undefined) as never,
  memory: { knowledge: { enabled: () => true, fileOf: () => ({ refused: "no such document" }) } } as never,
  sendFile: { send: async () => ({ delivered: true }), maxBytes: 1_000_000 } as never,
  sendMessage: {} as never,
  attachmentRead: {} as never,
});
const ctx = { agentId: "nora", chatId: "814", gatewayId: "telegram:nora", senderId: "u1", chatType: "dm" } as ToolContext;

/** A pack that lists everything an operator's own agent might hold. */
const PACK = ["exec", "read", "write", "edit", "glob", "grep", "web_search", "web_fetch", "memory_write", "memory_search", "memory_read", "send_file", "session", "plan", "delegate", "skill_create", "nouride"];
const agent = (access?: "open" | "pair") => fakeAgent({ config: { ...fakeAgent().config, id: "nora", ...(access ? { access } : {}), tools: { enabled: PACK, approvalRequired: [], blocked: [] } } });
/** What the daemon adds to every agent's toolset by itself: another agent to ask, and an MCP server's tool. */
const mcpTool: Tool = { requiresApproval: false, definition: { name: "mcp__crm__lookup", description: "Look a customer up.", parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "", isError: false }) };
const daemon = { peerAgents: () => ["nouva"], mcpTools: () => [["mcp__crm__lookup", mcpTool]] as [string, Tool][] };

describe("an open agent's toolset", () => {
  const open = resolveToolset(agent("open"), tools, security, daemon as never);
  const names = open.definitions.map((definition) => definition.name).sort();

  test("is the four, whatever its pack lists and whatever the daemon would add", () => {
    expect(names).toEqual(["attachment_read", "memory_read", "memory_search", "send_file"]);
    expect([...OPEN_AGENT_TOOLS].sort()).toEqual(names);
    // The same pack on an agent that is not open holds its shell, and the daemon's own additions.
    const usual = resolveToolset(agent("pair"), tools, security, daemon as never).definitions.map((definition) => definition.name);
    expect(usual).toEqual(expect.arrayContaining(["exec", "write", "send_message", "mcp__crm__lookup", "memory_write"]));
    expect(isOpenAgent(agent("pair"))).toBe(false);
    expect(isOpenAgent(agent())).toBe(false);
  });

  test("each family of tools is refused at the gate when called anyway, and never asked about", () => {
    const families = ["exec", "read", "write", "edit", "glob", "nouride", "ask_agent", "delegate", "mission", "schedule", "work", "send_message", "secret_save", "web_search", "web_fetch", "memory_write", "person_record", "skill_create", "persona", "agent_configure", "mcp__crm__lookup"];
    for (const name of families) {
      expect(open.get(name), name).toBeUndefined();
      expect(open.gate(name, {}, ctx), name).toEqual({ action: "refuse", reason: "this agent is open to everyone, and holds only the tools that answer from what was opened to everyone" });
      expect(open.requiresApproval(name), name).toBe(false);
    }
  });

  test("the four run with nobody asked: the one in the chat is a stranger", () => {
    expect(open.gate("memory_search", { query: "price list" }, ctx)).toEqual({ action: "run", via: "ceiling" });
    expect(open.gate("memory_read", { document: "knowledge:prices/list.md#0" }, ctx)).toEqual({ action: "run", via: "ceiling" });
    expect(open.gate("attachment_read", {}, ctx)).toEqual({ action: "run", via: "ceiling" });
    expect(open.gate("send_file", { document: "knowledge:prices/list.pdf#0" }, ctx)).toEqual({ action: "run", via: "ceiling" });
    for (const name of names) expect(open.requiresApproval(name)).toBe(false);
  });

  test("the two that read are told as what they are for it: documents opened to everyone, with no conversation, person or agent to name", () => {
    const told = (name: string) => open.definitions.find((definition) => definition.name === name)!;
    const fields = (name: string) => Object.keys((told(name).parameters as { properties: Record<string, unknown> }).properties).sort();
    expect({ search: fields("memory_search"), read: fields("memory_read") }).toEqual({ search: ["limit", "query"], read: ["document"] });
    expect(told("memory_search").description).toStartWith("Search the documents opened to everyone:");
    expect(told("memory_read").description).toBe("Open a document that `memory_search` found: one section of it, or the whole document.");
    // The tools' own words, for an agent that remembers: none of them is this agent's to be told.
    const sent = JSON.stringify([told("memory_search"), told("memory_read")]);
    for (const theirs of ["conversation", "people", "agents", "facts", "MEMORY.md", "nouva", "since", "until"]) expect(sent).not.toContain(theirs);
    expect(JSON.stringify(tools.get("memory_search")!.definition)).toContain("conversations");
    // A conversation is nobody's to open here; nor its own notes, which it holds already.
    const refusal = expect.objectContaining({ action: "refuse", reason: expect.stringContaining("there is no conversation for it to open") });
    expect(open.gate("memory_read", { conversation: "2026-09-25-0459-nouva" }, ctx)).toEqual(refusal);
    expect(open.gate("memory_read", { document: "knowledge:prices/list.md#0", conversation: "2026-09-25-0459-nouva" }, ctx)).toEqual(refusal);
    expect(open.gate("memory_read", {}, ctx)).toEqual(refusal);
  });

  test("send_file sends a kept document alone: no path, no address, and its schema names neither", () => {
    const refusal = expect.objectContaining({ action: "refuse", reason: expect.stringContaining("named by `document`") });
    expect(open.gate("send_file", { path: "/etc/passwd" }, ctx)).toEqual(refusal);
    expect(open.gate("send_file", { paths: ["a.txt", "b.txt"] }, ctx)).toEqual(refusal);
    expect(open.gate("send_file", { url: "https://example.com/a.png" }, ctx)).toEqual(refusal);
    // A document named beside a path is not let through on the document's account.
    expect(open.gate("send_file", { document: "knowledge:prices/list.pdf#0", path: "/etc/passwd" }, ctx)).toEqual(refusal);
    expect(open.gate("send_file", {}, ctx)).toEqual(refusal);
    const told = open.definitions.find((definition) => definition.name === "send_file")!;
    expect(Object.keys((told.parameters as { properties: Record<string, unknown> }).properties).sort()).toEqual(["caption", "document"]);
    expect(JSON.stringify(told)).not.toContain("path");
    expect(JSON.stringify(told)).not.toContain("url");
  });

  test("a daemon that built none of them hands an open agent nothing, not its pack", () => {
    const none = openToolset(new Map([["exec", tools.get("exec")!]]));
    expect(none.definitions).toEqual([]);
    expect(none.gate("exec", { command: "id" }, ctx)).toMatchObject({ action: "refuse" });
  });

  test("with no knowledge base there is no kept file to send, so send_file is not offered with nothing it may send", () => {
    const bare = createBuiltinTools({ security, web: {} as never, sessionStatus: (() => undefined) as never, memory: {} as never, sendFile: { send: async () => ({ delivered: true }), maxBytes: 1_000_000 } as never });
    const without = openToolset(bare);
    expect(without.definitions.map((definition) => definition.name)).not.toContain("send_file");
    expect(without.gate("send_file", { document: "knowledge:a/b.md#0" }, ctx)).toMatchObject({ action: "refuse" });
    // The same registry gives an agent that is not open its `send_file`, by path.
    expect(resolveToolset(agent("pair"), bare, security).definitions.map((definition) => definition.name)).toContain("send_file");
  });
});
