/**
 * The conversation's event stream, as the chat hook uses it (`/events/stream`, 0.7.4).
 *
 * The page polled a running turn every half second whether anything had happened or not. It now follows the
 * conversation's events: each one polls at once, and while they arrive the timer is only a net under them. The
 * stream makes the page sooner, never necessary — a browser that cannot open one polls as it did.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ChatTurn, LiveTurn } from "@/commons/lib/api";
import type { Conversation } from "@/commons/hooks/use-conversation";
import { rowEffects } from "@/commons/lib/event-stream";
import { eventually, sleep } from "./wait.ts";

let dom: Window;
let realFetch: typeof fetch;
const DOM_GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;

/** An `EventSource` the test opens and speaks through. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  /** 1 open; 2 closed — refused by the server, which a browser never retries by itself. */
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of DOM_GLOBALS) {
    (globalThis as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  }
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as Record<string, unknown>).EventSource;
  FakeEventSource.opened = [];
});

/**
 * Wait for the loop's next poll. An event sent right after one has the whole 2 s net ahead of it, so a poll that follows
 * within a second is the event's doing — said with a second of room, where it used to be given 150 ms and a loaded
 * machine could miss that.
 */
async function nextPoll(daemon: { polls: () => number }): Promise<void> {
  const seen = daemon.polls();
  await eventually(() => daemon.polls() > seen, 4_000);
}

const running: ChatTurn = { id: "turn_1", agentId: "ren", chatId: "dev-1", sessionId: "s1", status: "running", prompt: "check the build", reply: "", toolCalls: 0, startedAt: 1_000, steps: [] };

/** The daemon's routes the hook reads, counting the live polls. */
function serve(): { polls: () => number; asked: (path: string) => number } {
  let polls = 0;
  const seen = new Map<string, number>();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    seen.set(url.pathname, (seen.get(url.pathname) ?? 0) + 1);
    if (url.pathname.endsWith("/sessions/s1/live")) {
      polls += 1;
      return json({ turn: { ...running, cursor: 0 } satisfies LiveTurn, jobs: [] });
    }
    if (url.pathname.endsWith("/sessions/s1/turns")) {
      const session = { id: "s1", agentId: "ren", chatId: "dev-1", gatewayId: "web:dashboard", updatedAt: 1, writable: true };
      return json({ session, earlier: [], turns: [], events: [], messages: [] });
    }
    return json({});
  }) as typeof fetch;
  return { polls: () => polls, asked: (path) => seen.get(path) ?? 0 };
}

async function mount(): Promise<{ latest: () => Conversation | null; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { useConversation } = await import("@/commons/hooks/use-conversation");
  let latest: Conversation | null = null;
  const Probe = (): null => {
    latest = useConversation({ sessionId: "s1", agentId: "ren", onSession: () => {} });
    return null;
  };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  return { latest: () => latest, unmount: () => (root.unmount(), host.remove(), client.clear()) };
}

describe("the conversation's event stream", () => {
  test("opened for the conversation's own chat, from now — and closed with the page", async () => {
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    serve();
    const view = await mount();
    try {
      await eventually(() => FakeEventSource.opened.length > 0, 2_000);
      const url = new URL(FakeEventSource.opened[0]!.url, "http://localhost");
      expect(url.pathname).toBe("/api/control/events/stream");
      expect(Object.fromEntries(url.searchParams)).toEqual({ tail: "1", chat: "dev-1", gateway: "web:dashboard" });
    } finally {
      view.unmount();
    }
    expect(FakeEventSource.opened.every((source) => source.closed)).toBe(true);
  });

  // That an event polls at once is the next test's first half, on a `tool_done` row.
  test("while the stream is open, the timer waits longer than the half second it did", async () => {
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    const daemon = serve();
    const view = await mount();
    try {
      await eventually(() => view.latest()?.liveTurns[0]?.status === "running", 2_000);
      const stream = FakeEventSource.opened[0]!;
      stream.onopen?.();
      // Settle into the open stream's rhythm, then count: at most the net's polls, not one every half second.
      await sleep(600);
      const quiet = daemon.polls();
      await sleep(1_200);
      expect(daemon.polls() - quiet).toBeLessThanOrEqual(1);
    } finally {
      view.unmount();
    }
  });

  test("the audit row and the usage of a call do not poll — the step or answer they came with did", async () => {
    const wakes = (frame: string) => rowEffects(frame).wakes;
    expect(wakes(JSON.stringify({ kind: "audit", data: {} }))).toBe(false);
    expect(wakes(JSON.stringify({ kind: "usage", data: {} }))).toBe(false);
    // Nor what a request carried (1.4): the turn's record reads it when it is opened.
    expect(wakes(JSON.stringify({ kind: "context", data: { request: 1 } }))).toBe(false);
    expect(wakes(JSON.stringify({ kind: "tool_done", data: { step: 2 } }))).toBe(true);
    // What the page cannot read still wakes it: a poll too many is cheap.
    expect(wakes("{}")).toBe(true);
    expect(wakes("not json")).toBe(true);

    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    const daemon = serve();
    const view = await mount();
    try {
      await eventually(() => view.latest()?.liveTurns[0]?.status === "running", 2_000);
      const stream = FakeEventSource.opened[0]!;
      stream.onopen?.();
      // The step polls, which also puts the 2 s net timer back to the start…
      await nextPoll(daemon);
      const before = daemon.polls();
      stream.onmessage?.({ data: JSON.stringify({ kind: "tool_done", data: { step: 2 } }), lastEventId: "10" });
      await eventually(() => daemon.polls() > before, 1_000);
      // …so nothing polls in the next moment unless the audit row does.
      const after = daemon.polls();
      stream.onmessage?.({ data: JSON.stringify({ kind: "audit", data: { tool: "exec" } }), lastEventId: "11" });
      await sleep(300);
      expect(daemon.polls()).toBe(after);
    } finally {
      view.unmount();
    }
  });

  test("a stream the daemon refused — a 503 while it starts — is opened again, where a browser would not", async () => {
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    serve();
    const view = await mount();
    try {
      await eventually(() => FakeEventSource.opened.length === 1, 2_000);
      const first = FakeEventSource.opened[0]!;
      first.readyState = FakeEventSource.CLOSED;
      first.onerror?.();
      await eventually(() => FakeEventSource.opened.length === 2, 3_500);
      expect(first.closed).toBe(true);
      expect(FakeEventSource.opened[1]!.url).toBe(first.url);
    } finally {
      view.unmount();
    }
  });

  test("a stream that only dropped is left to the browser, which retries it", async () => {
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    serve();
    const view = await mount();
    try {
      await eventually(() => FakeEventSource.opened.length === 1, 2_000);
      FakeEventSource.opened[0]!.onerror?.();
      await sleep(2_500);
      expect(FakeEventSource.opened.length).toBe(1);
    } finally {
      view.unmount();
    }
  });

  test("without one, the page polls as it always did", async () => {
    const daemon = serve();
    const view = await mount();
    try {
      await eventually(() => view.latest()?.liveTurns[0]?.status === "running", 2_000);
      const from = daemon.polls();
      await sleep(1_200);
      expect(daemon.polls() - from).toBeGreaterThanOrEqual(2);
    } finally {
      view.unmount();
    }
  });
});

/** Over HTTP/1.1 a browser allows six connections to one host; five hidden chat tabs held five of them. */
describe("a hidden tab", () => {
  const show = (state: "hidden" | "visible") => {
    Object.defineProperty(dom.document, "visibilityState", { value: state, configurable: true });
    dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  };

  test("holds no stream: closed when hidden, opened again — from now — when looked at", async () => {
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    serve();
    const view = await mount();
    try {
      await eventually(() => FakeEventSource.opened.length === 1, 2_000);
      show("hidden");
      await eventually(() => FakeEventSource.opened[0]!.closed, 500);
      await sleep(50);
      expect(FakeEventSource.opened.length).toBe(1);
      show("visible");
      await eventually(() => FakeEventSource.opened.length === 2, 500);
      expect(new URL(FakeEventSource.opened[1]!.url, "http://localhost").searchParams.get("tail")).toBe("1");
    } finally {
      show("visible");
      view.unmount();
    }
  });
});

describe("what the stream is news for", () => {
  test("an approval about to be asked, and a turn ended — refetched at once, where they were polled every second", () => {
    expect(rowEffects(JSON.stringify({ kind: "waiting", data: { step: 3, text: "waiting for approval" } })).refresh).toEqual([["approvals"]]);
    expect(rowEffects(JSON.stringify({ kind: "turn", data: { phase: "end", status: "done" } })).refresh).toEqual([["sessions"], ["rooms"]]);
    expect(rowEffects(JSON.stringify({ kind: "turn", data: { phase: "start" } })).refresh).toEqual([]);
    expect(rowEffects(JSON.stringify({ kind: "tool", data: { step: 1 } })).refresh).toEqual([]);
  });

  test("a `waiting` row refetches the approvals the page shows", async () => {
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    const daemon = serve();
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
    const { useConversation } = await import("@/commons/hooks/use-conversation");
    const { api } = await import("@/commons/lib/api");
    // The conversation, and the page's approvals beside it — polled slowly, so only the row can explain a second ask.
    const Probe = (): null => {
      useConversation({ sessionId: "s1", agentId: "ren", onSession: () => {} });
      useQuery({ queryKey: ["approvals"], queryFn: api.approvals, refetchInterval: 60_000 });
      return null;
    };
    const host = dom.document.createElement("div");
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    try {
      await eventually(() => FakeEventSource.opened.length === 1 && daemon.asked("/api/control/approvals") === 1, 2_000);
      FakeEventSource.opened[0]!.onmessage?.({ data: JSON.stringify({ kind: "waiting", data: { step: 3, text: "waiting" } }), lastEventId: "12" });
      await eventually(() => daemon.asked("/api/control/approvals") === 2, 500);
    } finally {
      root.unmount();
      host.remove();
      client.clear();
    }
  });
});
