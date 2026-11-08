/**
 * Nouride's tools, lent to an external agent's CLI over MCP while its turn runs (EXTERNAL_AGENTS §4, §4.2): what the
 * CLI has no way to do itself — ask another agent, search what the household remembers, keep the conversation's plan
 * and notes, schedule, a mission's own tools — and the agent's MCP servers from its library, proxied, their credentials
 * staying in the daemon. Its own files, shell and web the CLI has, and those are not lent.
 *
 * Each call runs as one of the turn's own: the turn's toolset, so the per-agent tool choice holds and a mission's
 * tools are there only in a mission; the executor's own `ToolCaller`, so the gate, the approval, the second look and
 * the audit are the ones any call meets. A CLI's session gets a token when it opens (`session/new`'s `mcpServers`),
 * good for that conversation of that agent, in memory, for the daemon's life — or, for a CLI that reads its MCP headers
 * from its environment, the agent's own token, in that environment, and the conversation named beside it. A call that
 * arrives while no turn of that conversation runs is refused: there is nothing to answer it as.
 */

import { randomToken } from "@nouride/runtime";
import type { ToolDefinition, ToolResult } from "@nouride/shared";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import { MAX_TOOL_RESULT_TOKENS, type ExecutorDeps, type TurnRequest } from "@/modules/llm/executor/types.ts";
import { isMcpToolName } from "@/modules/tools/mcp-tools.ts";

/**
 * The built-ins a CLI is lent: Nouride's own reach. Left out is what the CLI does as well itself — its files, shell and
 * web, `CLI_OWN`'s eight names (`skills.ts`), and `session` and `multi_edit`, the same shell and files — and three that
 * stay a Nouride agent's (RFC Part C §C.10): `nouride` and `update`, which restart the daemon and the CLI's process with
 * its turn, and `session_status`, which reports the Nouride model's session, none of it the CLI's.
 */
const LENT = new Set([
  "ask_agent",
  "delegate",
  "memory_search",
  "memory_read",
  "memory_analyze",
  "memory_write",
  "person_notes",
  "person_record",
  "plan",
  "notes",
  "schedule",
  "mission",
  "work",
  "send_message",
  "send_file",
  // Its own model and effort (0.8.7): asked to think harder, a CLI agent had no way to — its config is not its user's.
  "agent_configure",
  // Its own persona (0.8.8): the pack is the daemon's, so a change it proposes goes to an admin, as an internal agent's does.
  "persona",
  // Its own skill roots (0.8.24), asked of an admin as its persona is: the pack is the daemon's to write.
  "skill_root",
  // What a Nouride agent did that a CLI could not (0.8.11, §C.5). A new agent's pack and a skill in the one pool are the
  // daemon's files: a skill a CLI wrote in its own skills folder was its alone — not on the Skills tab, not checked as a
  // draft, in no other agent's pool. The hubs' queue is the daemon's; `mcp_search`'s add link names the dashboard and the
  // agent, which a CLI is not told; a credential sent in chat is in the daemon's memory, never the CLI's; and the index of
  // the conversation's files is the daemon's. Each is lent only where the agent's own toolset holds it.
  "agent_create",
  "skill_create",
  "skill_toggle",
  "skill_improve",
  "skill_search",
  "skill_install",
  "mcp_search",
  "secret_save",
  "attachment_read",
]);

/** Whether a CLI is lent this tool of Nouride's. */
export const lends = (name: string): boolean => LENT.has(name) || isMcpToolName(name);

export interface Session {
  agentId: string;
  key: string;
}

/** Where a CLI that reads its MCP headers from its environment (`mcpEnvHeaders`) finds the agent's token. */
const MCP_TOKEN_ENV = "NOURIDE_MCP_TOKEN";
/** The header naming the conversation beside an agent's token: nothing without the token, so in the open. */
export const CONVERSATION_HEADER = "x-nouride-conversation";

interface Running {
  req: TurnRequest;
  caller: ToolCaller;
}

export class LentTools {
  private readonly tokens = new Map<string, Session>();
  private readonly byConversation = new Map<string, string>();
  /** The agents' own tokens, and the conversations named beside them. */
  private readonly agentTokens = new Map<string, string>();
  private readonly byAgent = new Map<string, string>();
  private readonly named = new Map<string, Session>();
  private readonly names = new Map<string, string>();
  private readonly running = new Map<string, Running>();
  /** What was lent the last turn, for a CLI that lists its tools between turns. */
  private readonly lastLent = new Map<string, ToolDefinition[]>();
  private calls = 0;

  /** The bearer a conversation's session carries to `/mcp/agent`: the same one for its every session. */
  tokenFor(agentId: string, key: string): string {
    const conversation = `${agentId}|${key}`;
    const known = this.byConversation.get(conversation);
    if (known) return known;
    const token = `nagt_${randomToken()}`;
    this.tokens.set(token, { agentId, key });
    this.byConversation.set(conversation, token);
    return token;
  }

  /**
   * The agent's own bearer, for a CLI that reads it from its environment: one for all its conversations, so it can be
   * there when the CLI starts — before any conversation is.
   */
  agentToken(agentId: string): string {
    const known = this.byAgent.get(agentId);
    if (known) return known;
    const token = `nagt_${randomToken()}`;
    this.agentTokens.set(token, agentId);
    this.byAgent.set(agentId, token);
    return token;
  }

  /** A conversation's name beside the agent's token. Random: what it names is the agent's to know, not the box's. */
  conversationFor(agentId: string, key: string): string {
    const conversation = `${agentId}|${key}`;
    const known = this.names.get(conversation);
    if (known) return known;
    const name = `conv_${randomToken()}`;
    this.named.set(name, { agentId, key });
    this.names.set(conversation, name);
    return name;
  }

  /**
   * The headers a conversation's session is given `/mcp/agent` with. To a CLI that fills them from its environment, the
   * bearer is only named — it is in `env` — since the headers reach its command line, which any user on the box reads.
   */
  headers(agentId: string, key: string, fromEnv: boolean): { name: string; value: string }[] {
    if (!fromEnv) return [{ name: "Authorization", value: `Bearer ${this.tokenFor(agentId, key)}` }];
    return [
      { name: "Authorization", value: `Bearer \${${MCP_TOKEN_ENV}}` },
      { name: CONVERSATION_HEADER, value: this.conversationFor(agentId, key) },
    ];
  }

  /** What such a CLI starts with in its environment: the agent's own bearer. */
  env(agentId: string): Record<string, string> {
    return { [MCP_TOKEN_ENV]: this.agentToken(agentId) };
  }

  /** Whose call this is: a conversation's own bearer, or an agent's with one of its own conversations named. */
  resolve(bearer: string, conversation?: string): Session | null {
    const own = this.tokens.get(bearer);
    if (own) return own;
    const agentId = this.agentTokens.get(bearer);
    const named = conversation ? this.named.get(conversation) : undefined;
    return agentId && named?.agentId === agentId ? named : null;
  }

  /** The turn now running in this conversation, whose toolset and context its calls are answered with; returns its end. */
  begin(agentId: string, key: string, req: TurnRequest, deps: ExecutorDeps): () => void {
    const conversation = `${agentId}|${key}`;
    const running = { req, caller: new ToolCaller(deps) };
    this.running.set(conversation, running);
    this.lastLent.set(conversation, req.toolset.definitions.filter((definition) => lends(definition.name)));
    return () => {
      if (this.running.get(conversation) === running) this.running.delete(conversation);
    };
  }

  definitions(session: Session): ToolDefinition[] {
    const conversation = `${session.agentId}|${session.key}`;
    const running = this.running.get(conversation);
    return running ? running.req.toolset.definitions.filter((definition) => lends(definition.name)) : (this.lastLent.get(conversation) ?? []);
  }

  async call(session: Session, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const running = this.running.get(`${session.agentId}|${session.key}`);
    if (!running) return { content: `${name}: no turn of this conversation is running, and Nouride's tools answer inside one`, isError: true };
    if (!lends(name)) return { content: `${name} is not one of the tools Nouride lends. Use your own`, isError: true };
    this.calls += 1;
    return await running.caller.run(running.req, { id: `lent_${this.calls}`, name, arguments: args }, MAX_TOOL_RESULT_TOKENS, undefined, { lent: true });
  }
}
