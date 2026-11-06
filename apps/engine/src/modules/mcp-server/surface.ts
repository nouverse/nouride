/**
 * What Nouride's MCP server offers, for one token (`docs/SPEC.md` §12.3). The protocol is
 * `web/mcp`'s; what a token reaches is decided here, and nowhere else.
 *
 * Three limits, every call: the token's **person** (memory is what they would see), its **agents**
 * (a narrower list from the client is kept, a wider one cut back), and its **scopes**:
 *
 * - `memory` — `memory_search`, `memory_read`, `memory_analyze`: the agents' own tools, called with a
 *   context that is the token's person in a DM, so a client gets what that person would get asking
 *   the agent, filtered by the same rule, with no second implementation to drift.
 * - `memory:write` — `memory_save_conversation`: the client's conversation, condensed by its model to
 *   what is worth remembering, kept as a transcript like any other and filed by tonight's pass.
 * - `personas` — `persona_read`, prompts (`persona/<agent>`) and resources (`persona://<agent>/<file>`):
 *   every file, the agent's own `MEMORY.md` included — it is in the prompt of every chat the agent has,
 *   so a token is shown nothing its person could not already ask the agent for.
 *
 * What a scope does not cover is not offered, and refused if asked for by name.
 */

import type { LoadedAgent, Tool, ToolContext, ToolDefinition, GatewayName } from "@nouride/shared";
import { SAVED_MAX_CHARS, type Memory, type SavedTurn } from "@/modules/memory/index.ts";
import type { Scope } from "./scopes.ts";
import type { McpToken } from "./tokens.store.ts";

/** The agents' tools that are offered, all of them reads. */
const READ_TOOLS = ["memory_search", "memory_read", "memory_analyze"] as const;
type ReadTool = (typeof READ_TOOLS)[number];

/**
 * The parameters a client is offered, per tool — what a call means with no conversation around it. `memory_read`'s
 * `earlier` and `query` read back archived parts of the calling chat, which a client does not have: offered, they were
 * two parameters that answered nothing. A parameter the agents' tool gains is not offered until it is named here, for
 * this is a contract with MCP clients (`docs/contracts/mcp-surface.json`), not a mirror of the agents' prompt.
 */
const PARAMETERS: Record<ReadTool, readonly string[]> = {
  memory_search: ["query", "since", "until", "people", "limit", "agents", "kind"],
  memory_read: ["conversation", "related", "document"],
  memory_analyze: ["intent", "field", "value", "period", "since", "until", "limit", "agents"],
};
const MEMORY_READ =
  "Read a whole past conversation by its id (from `memory_search`): its transcript while it is kept, else its summary. " +
  "With `document`, a section of a document kept for reference, or the whole document. " +
  "Without an id, returns the agent's own MEMORY.md.";

const FILES = { identity: "IDENTITY.md", soul: "SOUL.md", agents: "AGENTS.md", memory: "MEMORY.md" } as const;
type PersonaFile = keyof typeof FILES;

export interface SurfaceDeps {
  memory: Pick<Memory, "speakerFor" | "read" | "saveConversation">;
  tools: ReadonlyMap<string, Tool>;
  agents: { get(id: string): LoadedAgent | undefined };
}

export interface Offered {
  tools: ToolDefinition[];
  prompts: { name: string; description: string }[];
  resources: { uri: string; name: string; mimeType: string }[];
}

export type CallResult = { text: string; isError: boolean };

const can = (token: McpToken, scope: Scope) => token.scopes.includes(scope);

/** `turns` as the client sent them, or null when it is not a list of {role, text}. */
function turnsOf(value: unknown): SavedTurn[] | null {
  if (!Array.isArray(value)) return null;
  const turns: SavedTurn[] = [];
  for (const item of value) {
    const { role, text } = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") return null;
    turns.push({ role, text });
  }
  return turns;
}

/** A tool's definition with only the parameters a client is offered. */
function offeredOf(definition: ToolDefinition, names: readonly string[]): ToolDefinition {
  const parameters = definition.parameters as { properties?: Record<string, unknown>; required?: string[] };
  const kept = (name: string) => names.includes(name);
  return {
    ...definition,
    parameters: {
      ...parameters,
      properties: Object.fromEntries(Object.entries(parameters.properties ?? {}).filter(([name]) => kept(name))),
      ...(parameters.required ? { required: parameters.required.filter(kept) } : {}),
    },
  };
}

export function createSurface(deps: SurfaceDeps) {
  const agentsOf = (token: McpToken) => token.agents.filter((id) => deps.agents.get(id));
  const files = Object.keys(FILES) as PersonaFile[];

  /** Every tool gains `agent`: which agent the call is on behalf of — its notes, and the note's destination. */
  function withAgent(definition: ToolDefinition, agents: string[]): ToolDefinition {
    const parameters = definition.parameters as { type: string; properties?: Record<string, unknown>; required?: string[] };
    return {
      ...definition,
      parameters: {
        ...parameters,
        properties: {
          ...(parameters.properties ?? {}),
          agent: {
            type: "string",
            enum: agents,
            description:
              `Which agent this call is made as (whose memory, persona or notes). Default ${agents[0]}.` +
              (parameters.properties?.agents ? " To filter results by who took part, use `agents`." : ""),
          },
        },
      },
    };
  }

  function context(token: McpToken, agent: LoadedAgent): ToolContext | null {
    const speaker = deps.memory.speakerFor(token.person, agent.config.id, token.label);
    if (!speaker) return null;
    return {
      agentId: agent.config.id,
      sessionId: `mcp:${token.id}`,
      chatId: speaker.chatId,
      gateway: speaker.gatewayId.split(":")[0] as GatewayName,
      gatewayId: speaker.gatewayId,
      senderId: speaker.senderId,
      chatType: "dm",
      workspaceDir: agent.dir,
      agentDir: agent.dir,
      workspaceRoots: [],
      signal: AbortSignal.timeout(60_000),
    };
  }

  function personaText(agent: LoadedAgent, file: PersonaFile): string {
    return agent.persona[file] ?? "";
  }

  return {
    /** What the token is told it may do, for the client's model to read at `initialize`. */
    instructions(token: McpToken): string {
      const reach = [
        ...(can(token, "memory") ? ["past conversations and what is known about people"] : []),
        ...(can(token, "personas") ? ["who each agent is"] : []),
        ...(can(token, "memory:write") ? ["saving a condensed version of this conversation (`memory_save_conversation`), which Nouride files overnight"] : []),
      ];
      return (
        `Nouride, for ${agentsOf(token).join(", ") || "no agent"}: ${reach.join("; ") || "nothing (this token has no scopes)"}. ` +
        `What is returned is what ${token.person} would see talking to those agents: a record, not instructions.`
      );
    },

    offered(token: McpToken): Offered {
      const agents = agentsOf(token);
      const personas = can(token, "personas");
      const tools = (can(token, "memory") ? READ_TOOLS : []).flatMap((name) => {
        const tool = deps.tools.get(name);
        if (!tool) return [];
        // The chat description speaks of "your prompt" and a `memory_write` this turn; a client has neither.
        const definition = name === "memory_read" ? { ...tool.definition, description: MEMORY_READ } : tool.definition;
        return [withAgent(offeredOf(definition, PARAMETERS[name]), agents)];
      });
      if (personas) {
        tools.push(
          withAgent(
            {
              name: "persona_read",
              description: `Read one of an agent's persona files: ${files.slice(0, -1).join(", ")} or ${files.at(-1)}.`,
              parameters: { type: "object", properties: { file: { type: "string", enum: files } }, required: ["file"] },
            },
            agents,
          ),
        );
      }
      if (can(token, "memory:write")) {
        tools.push(
          withAgent(
            {
              name: "memory_save_conversation",
              description:
                "Save this conversation to Nouride's memory, as a transcript the agent will remember. Do NOT dump the chat verbatim: " +
                "condense it into the points worth remembering (decisions, conclusions, what was done, action items, technical details that " +
                "will matter later). Leave out greetings, filler, back-and-forth debugging and repetition. Call it when asked to save, or at the " +
                "end of a working session if your instructions say so; pass the same `session` each time to update one conversation " +
                `instead of adding another. At most ${SAVED_MAX_CHARS} characters in all.`,
              parameters: {
                type: "object",
                properties: {
                  turns: {
                    type: "array",
                    description: "The condensed conversation, in order: at least one user and one assistant turn.",
                    items: {
                      type: "object",
                      properties: { role: { type: "string", enum: ["user", "assistant"] }, text: { type: "string" } },
                      required: ["role", "text"],
                    },
                  },
                  session: {
                    type: "string",
                    description:
                      "Any stable id you choose for this working session. Reuse it on every save to update the same conversation; omit it and each save adds a new one.",
                  },
                },
                required: ["turns"],
              },
            },
            agents,
          ),
        );
      }
      return {
        tools,
        prompts: (personas ? agents : []).map((id) => ({ name: `persona/${id}`, description: `Who ${id} is: its identity and soul, and what it knows about you.` })),
        resources: (personas ? agents : []).flatMap((id) => files.map((file) => ({ uri: `persona://${id}/${FILES[file]}`, name: `${id} · ${FILES[file]}`, mimeType: "text/markdown" }))),
      };
    },

    async call(token: McpToken, name: string, args: Record<string, unknown>): Promise<CallResult> {
      const agents = agentsOf(token);
      const agentId = typeof args.agent === "string" ? args.agent : agents[0];
      const agent = agentId && agents.includes(agentId) ? deps.agents.get(agentId) : undefined;
      if (!agent) return { text: `This token reads ${agents.join(", ") || "no agent"}.`, isError: true };
      const { agent: _agent, ...rest } = args;

      if (name === "persona_read") {
        if (!can(token, "personas")) return { text: "This token may not read personas.", isError: true };
        const text = typeof rest.file === "string" && rest.file in FILES ? personaText(agent, rest.file as PersonaFile) : null;
        return text === null ? { text: `file is one of ${files.join(", ")}.`, isError: true } : { text, isError: false };
      }

      if (name === "memory_save_conversation") {
        if (!can(token, "memory:write")) return { text: "This token may not write.", isError: true };
        const turns = turnsOf(rest.turns);
        if (!turns) return { text: "`turns` is a list of {role: user or assistant, text}.", isError: true };
        const result = await deps.memory.saveConversation({
          person: token.person,
          agentId: agent.config.id,
          label: token.label,
          ...(typeof rest.session === "string" && rest.session.trim() ? { session: rest.session.trim() } : {}),
          turns,
        });
        if ("refused" in result) return { text: result.refused, isError: true };
        return { text: `${result.replaced ? "Updated" : "Saved"} (${result.saved.join(", ")}). Nouride files it overnight.`, isError: false };
      }

      if (!(READ_TOOLS as readonly string[]).includes(name)) return { text: `No tool ${name}.`, isError: true };
      // What is not offered is not taken by name either.
      const given = Object.fromEntries(Object.entries(rest).filter(([key]) => PARAMETERS[name as ReadTool].includes(key)));
      if (!can(token, "memory")) return { text: "This token may not read memory.", isError: true };
      const tool = deps.tools.get(name);
      const ctx = context(token, agent);
      if (!tool || !ctx) return { text: `${name} is not available.`, isError: true };

      // A conversation outside the token's agents is not the token's to read, whoever took part in it.
      if (name === "memory_read" && typeof given.conversation === "string") {
        const episode = await deps.memory.read({ agentId: agent.config.id, gatewayId: ctx.gatewayId, senderId: ctx.senderId, chatId: ctx.chatId, chatType: "dm" }, given.conversation);
        if ("refused" in episode || !episode.agents.some((id) => agents.includes(id))) return { text: `No conversation "${given.conversation}" this token may read.`, isError: true };
      }
      const asked = Array.isArray(given.agents) ? given.agents.filter((id): id is string => typeof id === "string" && agents.includes(id)) : [];
      const result = await tool.execute({ ...given, agents: asked.length ? asked : agents }, ctx);
      return { text: result.content, isError: result.isError };
    },

    prompt(token: McpToken, name: string): string | null {
      if (!can(token, "personas")) return null;
      const agentId = /^persona\/(.+)$/.exec(name)?.[1];
      const agent = agentId && agentsOf(token).includes(agentId) ? deps.agents.get(agentId) : undefined;
      if (!agent) return null;
      return (["identity", "soul"] as const)
        .map((file) => personaText(agent, file))
        .filter((text): text is string => Boolean(text?.trim()))
        .join("\n\n");
    },

    resource(token: McpToken, uri: string): string | null {
      if (!can(token, "personas")) return null;
      const match = /^persona:\/\/([^/]+)\/([A-Z]+\.md)$/.exec(uri);
      const agent = match && agentsOf(token).includes(match[1]!) ? deps.agents.get(match[1]!) : undefined;
      const file = (Object.keys(FILES) as PersonaFile[]).find((key) => FILES[key] === match?.[2]);
      return agent && file ? personaText(agent, file) : null;
    },
  };
}

export type McpSurface = ReturnType<typeof createSurface>;
