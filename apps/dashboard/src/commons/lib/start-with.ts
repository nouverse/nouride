/**
 * The agent a new chat starts with, when a link names one, and a message written for the person to send.
 *
 * The Office's Open chat opened `/chat` whichever cat was picked, and the chat started with the orchestrator: a person
 * who picked Nix found Nouva, and what they sent went to her (2026-11-02). The link now names the agent in `?agent=`.
 *
 * `?draft=` is a message put in the box for the person to read and send (`AskAgentButton`, 0.8.19). It is never sent
 * from the address: `?initialMessage=` once was, and every reload sent it again. The page takes it once and drops it
 * from the address, so a reload does not put it back over what the person changed.
 */

/** What `/chat/` takes from its URL: the agent to start with, and a draft for the box, never a message to send. */
export interface ChatSearch {
  agent?: string;
  draft?: string;
}

/** A draft is a message for a person to read before sending, not a document: anything longer is cut here. */
const DRAFT_LIMIT = 2_000;

export function parseChatSearch(search: Record<string, unknown>): ChatSearch {
  const agent = typeof search.agent === "string" ? search.agent.trim() : "";
  const draft = typeof search.draft === "string" ? search.draft.trim().slice(0, DRAFT_LIMIT) : "";
  return { ...(agent ? { agent } : {}), ...(draft ? { draft } : {}) };
}

/**
 * The named agent, for a new chat only and only one the daemon has: an open conversation is its own agent's, and an id
 * nobody has is ignored rather than sent to. Empty when there is nothing to start with.
 */
export function startWith(named: string | undefined, sessionId: string | undefined, agents: { id: string }[]): string {
  return !sessionId && named && agents.some((agent) => agent.id === named) ? named : "";
}
