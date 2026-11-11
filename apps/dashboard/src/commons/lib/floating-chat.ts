/**
 * The chat that floats over every page (`commons/components/floating-chat`): whether it is open, the agent it is on,
 * and a message written for the person to send. One store for the whole page, apart from the panel that draws it, so a
 * button on any page opens it (`AskAgentButton`) without that page knowing where the panel is.
 *
 * Kept while the page is open and no longer: closed, it holds nothing but the agent it was last on.
 */

import { useSyncExternalStore } from "react";

export interface FloatingChatState {
  open: boolean;
  /** The agent it is on: the one it was opened on, then whichever the person picks in its bar. Empty before it is opened. */
  agent: string;
  /** A message for the box, put there once and then let go of (`useDraft`): never sent from here. */
  draft: string | null;
}

const CLOSED: FloatingChatState = { open: false, agent: "", draft: null };
let state = CLOSED;
const listeners = new Set<() => void>();

function set(next: FloatingChatState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Open it on an agent, with a message for the box where its opener wrote one. Open already, it moves to that agent. */
export function openFloatingChat(on: { agent: string; draft?: string }): void {
  set({ open: true, agent: on.agent, draft: on.draft ?? state.draft });
}

export function closeFloatingChat(): void {
  if (state.open || state.draft !== null) set({ ...state, open: false, draft: null });
}

/** The person picked another agent in its bar. */
export function pickFloatingAgent(agent: string): void {
  if (state.agent !== agent) set({ ...state, agent });
}

/** The message is in the box: let go of, so it is not put back over what the person changed. */
export function takeFloatingDraft(): void {
  if (state.draft !== null) set({ ...state, draft: null });
}

export function useFloatingChat(): FloatingChatState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

/** The agent a page belongs to, by its address: an agent's own pages, and no other (`/agents/settings` is every agent's). */
export function agentOfPage(pathname: string): string | undefined {
  const id = /^\/agents\/([^/]+)/.exec(pathname)?.[1];
  return id && id !== "settings" ? id : undefined;
}

/**
 * The agent it opens on: the one the page on screen belongs to, else the one it was last on in this browser, else the
 * orchestrator. Each only while the daemon still has it: an agent since deleted is passed over, never opened on.
 */
export function agentAtOpen(o: { page: string | undefined; last: string; orchestrator: string | null; agents: readonly { id: string }[] }): string {
  const known = (id: string | null | undefined) => (id && o.agents.some((agent) => agent.id === id) ? id : undefined);
  return known(o.page) ?? known(o.last) ?? known(o.orchestrator) ?? o.agents[0]?.id ?? "";
}
