/**
 * What an agent open to everyone holds: four tools, the daemon's list and never its pack's.
 *
 * `open` was the whole install's, and boot refused it beside any agent with a shell: a bot for customers cost every
 * agent its `exec`. It is one agent's now, and safe for the reason this file is: whatever its pack lists, an open
 * agent answers, searches and reads the knowledge collections opened to everyone, reads a file its chat sent it, and
 * sends a file kept in such a collection into the chat it is answering. Nothing here reaches the computer, another
 * agent, another chat, a secret, or what the agent remembers: those tools are not in what its model is sent, and a
 * call to one made anyway is refused, never asked about, since the one who would be asked is a stranger.
 *
 * Which collections are open to everyone is memory's to say, for an open agent whoever is asking (`memory/public.ts`).
 */

import type { GateDecision, Tool, ToolDefinition } from "@nouride/shared";
import type { AgentToolset } from "./registry.ts";

export const OPEN_AGENT_TOOLS: readonly string[] = ["attachment_read", "memory_read", "memory_search", "send_file"];

const NOT_HELD = "this agent is open to everyone, and holds only the tools that answer from what was opened to everyone";
const DOCUMENT_ALONE =
  "an agent open to everyone sends only a file kept in a collection opened to everyone, named by `document` (the id `memory_search` gave it): no path and no address";

/** `send_file` as an open agent is told of it: a kept document, into the chat it is answering. */
function documentAlone(definition: ToolDefinition): ToolDefinition {
  const properties = (definition.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  // Said without the ways of sending it does not have: the tool's own words name them beside this one.
  const document = { type: "string", description: "The file to send: the id `memory_search` gave it, in ⟨⟩." };
  return {
    ...definition,
    description: "Send a file kept in the knowledge base into this chat, as it is.",
    parameters: { type: "object", properties: { document, ...(properties.caption ? { caption: properties.caption } : {}) }, required: ["document"] },
  };
}

const takesDocument = (tool: Tool) => Boolean((tool.definition.parameters as { properties?: Record<string, unknown> }).properties?.document);

/**
 * The four, where this daemon built them: a daemon with no memory has no collection to answer from, and one with no
 * knowledge base has no kept file to send, so `send_file` would be left with nothing it may send and is not offered.
 */
export function openToolset(registry: ReadonlyMap<string, Tool>): AgentToolset {
  const built = OPEN_AGENT_TOOLS.flatMap((name) => (registry.has(name) ? [[name, registry.get(name)!] as const] : []));
  const held = new Map(built.filter(([name, tool]) => name !== "send_file" || takesDocument(tool)));
  return {
    definitions: [...held.values()].map((tool) => (tool.definition.name === "send_file" ? documentAlone(tool.definition) : tool.definition)),
    get: (name) => held.get(name),
    // Nobody is asked: the one in the chat is a stranger, and each of the four reaches only what was opened to everyone.
    requiresApproval: () => false,
    parallelSafe: (name) => held.get(name)?.parallelSafe === true,
    gate: (name, args): GateDecision => {
      if (!held.has(name)) return { action: "refuse", reason: NOT_HELD };
      if (name === "send_file" && (typeof args.document !== "string" || args.path !== undefined || args.paths !== undefined || args.url !== undefined)) {
        return { action: "refuse", reason: DOCUMENT_ALONE };
      }
      return { action: "run", via: "ceiling" };
    },
    blockedPatterns: [],
  };
}
