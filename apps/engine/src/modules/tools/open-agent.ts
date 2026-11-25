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
const WHAT_IT_WAS_TOLD = "an agent open to everyone calls this tool with what it was told of and nothing else";
const A_DOCUMENT_TO_READ = "an agent open to everyone reads a document, named by `document` (the id `memory_search` gave it): there is no conversation for it to open";
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

/**
 * The three that read, as an open agent is told of them: the documents opened to everyone and the files of its own
 * chat, and nothing of the conversations, people, agents, paths and other tools their own words name. Its model is
 * sent these with every stranger's message.
 */
const TOLD: Record<string, Pick<ToolDefinition, "description" | "parameters">> = {
  memory_search: {
    description:
      "Search the documents opened to everyone: it returns sections of them, each with an id `memory_read` opens. Query in keywords (the names, things and topics the answer would contain), not the question as asked. A document keeps its own language, with an English title: search in either. Nothing found: try a synonym or a broader word.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords for what to find, e.g. `price list` or `opening hours`, not a sentence." }, limit: { type: "number", description: "At most this many results (default 10, at most 30)." } },
      required: ["query"],
    },
  },
  attachment_read: {
    description:
      "Open a file somebody sent in this conversation, by its ref: the text of a document, what a picture shows, what a voice note says. With no ref, it lists this conversation's files. Never describe a file you have not opened.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The file's ref, as shown in the conversation (looks like `f1a2b3c4d5`). Leave it out to list the files of this conversation." },
        question: { type: "string", description: "What you need to know about a picture, e.g. \"what does the label say?\"." },
      },
    },
  },
  memory_read: {
    description: "Open a document that `memory_search` found: one section of it, or the whole document.",
    parameters: {
      type: "object",
      properties: { document: { type: "string", description: "A section's id from `memory_search`, in ⟨⟩; end it with #all instead of the number for the whole document." } },
      required: ["document"],
    },
  },
};

/** A tool as an open agent's model is told of it. */
function told(definition: ToolDefinition): ToolDefinition {
  if (definition.name === "send_file") return documentAlone(definition);
  const own = TOLD[definition.name];
  return own ? { ...definition, ...own } : definition;
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
    definitions: [...held.values()].map((tool) => told(tool.definition)),
    get: (name) => held.get(name),
    // Nobody is asked: the one in the chat is a stranger, and each of the four reaches only what was opened to everyone.
    requiresApproval: () => false,
    parallelSafe: (name) => held.get(name)?.parallelSafe === true,
    gate: (name, args): GateDecision => {
      const tool = held.get(name);
      if (!tool) return { action: "refuse", reason: NOT_HELD };
      // Called with what it was told of, and nothing else of the tool's own: each other argument is a way to something
      // an open agent has no business with. `memory_read`'s `earlier` was one, never named to it and taken all the
      // same: this chat's archived exchanges, every agent's on the connection, those a `/new` had put away among them.
      const toldOf = Object.keys((told(tool.definition).parameters as { properties?: Record<string, unknown> }).properties ?? {});
      const more = Object.keys(args).filter((key) => args[key] !== undefined && !toldOf.includes(key));
      if (name === "send_file" && (typeof args.document !== "string" || more.length > 0)) return { action: "refuse", reason: DOCUMENT_ALONE };
      // A conversation is nobody's to open here, and with no id the tool reads the agent's own notes, which it holds already.
      if (name === "memory_read" && (typeof args.document !== "string" || more.length > 0)) return { action: "refuse", reason: A_DOCUMENT_TO_READ };
      if (more.length > 0) return { action: "refuse", reason: `${WHAT_IT_WAS_TOLD}: ${toldOf.join(", ") || "nothing"}` };
      return { action: "run", via: "ceiling" };
    },
    blockedPatterns: [],
  };
}
