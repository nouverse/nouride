/**
 * What the floating chat's tests share: the daemon's answers for a box with two agents, and how a test finds the
 * button, the panel and the box in it. The card is drawn at the body (`overPage`), outside the host a page mounts in.
 */

import { dom, WIRE } from "./mount-harness.ts";

const status = WIRE["/status"] as { agents: Record<string, unknown>[] } & Record<string, unknown>;
const nouva = status.agents[0]!;

/** Nouva, the orchestrator, with a conversation already (`ses_1` in the list); Nix, with none. */
const TWO_AGENTS = { ...status, orchestrator: "nouva", agents: [nouva, { ...nouva, id: "nix", displayName: "Nix", headline: "engineer" }] };

const ok = (body: unknown) => ({ status: 200, body });

/** The box with two agents, and the open conversation at rest: no turn at work, so a message sent is a turn of its own. */
export const AT_REST = { "/status": ok(TWO_AGENTS), "/sessions/ses_1/live": ok({ turn: null, jobs: [] }) };

/** Where this browser keeps the agent the floating chat was last on (`FloatingChat.tsx`). */
export const LAST_AGENT_KEY = "nouride-floating-chat-agent";

/** The floating button, whichever of its two names it has. */
export const floatButton = (host: HTMLElement) => host.querySelector('button[aria-label^="Chat with "], button[aria-label^="Close the chat with "]') as HTMLButtonElement | null;

/** The panel as a card over the button, from a tablet's width up. */
export const card = () => dom.document.querySelector("[data-floating-chat]") as unknown as HTMLElement | null;

/** The panel as a sheet from the foot of a phone, while it is open. */
export const sheet = () => dom.document.querySelector('[data-drawer="bottom"][data-open][aria-label^="Chat with "]') as unknown as HTMLElement | null;

export const boxIn = (panel: HTMLElement | null) => (panel?.querySelector("textarea") ?? null) as HTMLTextAreaElement | null;
export const sendIn = (panel: HTMLElement | null) => (panel?.querySelector('button[aria-label="Send message"]') ?? null) as HTMLButtonElement | null;

/** A key pressed with the focus where it is. */
export function pressKey(key: string): void {
  const view = dom as unknown as { KeyboardEvent: new (type: string, init: Record<string, unknown>) => Event };
  const at = (dom.document.activeElement ?? dom.document.body) as unknown as EventTarget;
  at.dispatchEvent(new view.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/**
 * What an Ask button just asked of the floating chat (`lib/floating-chat.ts`): read the way a page reads it, and the
 * chat then closed. For a test that mounts one card with no shell around it to draw the panel: the store is the whole
 * process's, and a chat left open here would be open on the next file's page.
 */
export async function floatingChatAsked(): Promise<{ open: boolean; agent: string; draft: string | null }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { closeFloatingChat, useFloatingChat } = await import("@/commons/lib/floating-chat");
  let seen: { open: boolean; agent: string; draft: string | null } = { open: false, agent: "", draft: null };
  const Probe = () => {
    seen = useFloatingChat();
    return null;
  };
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(React.createElement(Probe)));
  root.unmount();
  closeFloatingChat();
  return seen;
}

/** An `EventSource` that only writes down that it was opened, where, and whether it was closed. */
export class FakeEventSource {
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

/** Every request the page makes from here on, by path: what it asks the daemon, and how often. */
export function recordRequests(): { paths: string[]; restore: () => void } {
  const paths: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    paths.push(new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost").pathname.replace(/^\/api\/control/, ""));
    return (spy as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  return { paths, restore: () => void (globalThis.fetch = spy) };
}
