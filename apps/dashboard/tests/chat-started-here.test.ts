/**
 * A conversation a new chat starts opens on its first answer. The page sends from /chat, the daemon names the session,
 * and the page opens again at its address — a new mount, which the conversation hook tells it opened on a send of its
 * own (`startedHere`), so the stream moves that answer in. The same conversation opened again, from the history say,
 * did not start there.
 */

import { afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Conversation } from "@/commons/hooks/use-conversation";
import { eventually } from "./wait.ts";

let dom: Window;
let realFetch: typeof fetch;
const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The daemon's three routes for a conversation it names `s9` when the first message is sent. */
function serve(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/chat/send")) return json({ sessionId: "s9", chatId: "dev-9", messageId: "m1", agentId: "ren" });
    if (url.pathname.endsWith("/sessions/s9/turns")) {
      const session = { id: "s9", agentId: "ren", chatId: "dev-9", gatewayId: "local:dev", updatedAt: 1, writable: true };
      return json({ session, earlier: [], turns: [], events: [], messages: [] });
    }
    if (url.pathname.endsWith("/sessions/s9/live")) return json({ turn: null, jobs: [] });
    return json({});
  }) as typeof fetch;
}

async function mount(options: Parameters<typeof import("@/commons/hooks/use-conversation").useConversation>[0]) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { useConversation } = await import("@/commons/hooks/use-conversation");
  let latest: Conversation | null = null;
  const Probe = (): null => {
    latest = useConversation(options);
    return null;
  };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  return {
    latest: () => latest,
    unmount: () => {
      root.unmount();
      host.remove();
      client.clear();
    },
  };
}

test("a conversation opened on the send that started it is started here, and once only", async () => {
  serve();
  let named = "";
  const fresh = await mount({ agentId: "ren", onSession: (id) => (named = id) });
  await eventually(() => fresh.latest() !== null, 2_000, "the new chat");
  fresh.latest()!.send("hello");
  await eventually(() => named === "s9", 2_000, "the session named");
  fresh.unmount();

  const opened = await mount({ sessionId: "s9", agentId: "ren", onSession: () => {} });
  await eventually(() => opened.latest()?.startedHere === true, 2_000, "it opened as started here");
  opened.unmount();

  const again = await mount({ sessionId: "s9", agentId: "ren", onSession: () => {} });
  await eventually(() => again.latest() !== null && again.latest()!.loading === false, 2_000, "the conversation read");
  const startedAgain = again.latest()!.startedHere;
  again.unmount();
  expect(startedAgain).toBe(false);
});
