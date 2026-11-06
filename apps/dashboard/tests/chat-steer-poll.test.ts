/**
 * A message sent while the agent works, as the conversation hook polls for it.
 *
 * Reported from the dashboard: the agent read the message, and the page showed nothing of it but a step quoting
 * its first 120 characters. The daemon now draws it on the running turn's record before the send returns, so what
 * is left here is asking soon enough to see it — and folding the turn into the history when the message, never
 * read, starts the next one between two polls.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ChatTurn, LiveTurn, TurnStep } from "@/commons/lib/api";
import type { Conversation } from "@/commons/hooks/use-conversation";
import { saidWhileWorking } from "@/commons/lib/steps";
import { eventually, sleep } from "./wait.ts";

let dom: Window;
let realFetch: typeof fetch;

const DOM_GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of DOM_GLOBALS) {
    (globalThis as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  }
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});


const ACK = "↪ Got it, I'll read that before my next step.";

function turnOf(id: string, prompt: string, steps: TurnStep[], status: ChatTurn["status"] = "running"): ChatTurn {
  return { id, agentId: "ren", chatId: "dev-1", sessionId: "s1", status, prompt, reply: "", toolCalls: 1, startedAt: 1_000, steps };
}

interface FakeDaemon {
  /** The session's newest turn, read when a poll arrives — as the daemon reads it. */
  live: () => ChatTurn | null;
  /** The transcript's turns. */
  recorded: () => ChatTurn[];
  /** Called before the send answers: the daemon draws a steer on the turn before it returns. */
  onSend?: () => void;
  liveMs: number;
  sendMs: number;
  liveCalls: number;
}

/** The three routes the hook calls, with the per-turn cursor the live route keeps. */
function serve(daemon: FakeDaemon): void {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/chat/send")) {
      await sleep(daemon.sendMs);
      daemon.onSend?.();
      return json({ sessionId: "s1", chatId: "dev-1", messageId: "m2", agentId: "ren" });
    }
    if (url.pathname.endsWith("/sessions/s1/live")) {
      daemon.liveCalls += 1;
      const turn = daemon.live();
      const after = Number(url.searchParams.get("after") ?? 0);
      const steps = turn && url.searchParams.get("turn") === turn.id ? turn.steps.filter((step) => step.seq > after) : (turn?.steps ?? []);
      const body = { turn: turn ? ({ ...turn, steps, cursor: steps.length ? steps[steps.length - 1]!.seq : after } satisfies LiveTurn) : null, jobs: [] };
      await sleep(daemon.liveMs);
      return json(body);
    }
    if (url.pathname.endsWith("/sessions/s1/turns")) {
      const session = { id: "s1", agentId: "ren", chatId: "dev-1", gatewayId: "local:dev", updatedAt: 1, writable: true };
      return json({ session, earlier: [], turns: daemon.recorded(), events: [], messages: [] });
    }
    return json({});
  }) as typeof fetch;
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
  return {
    latest: () => latest,
    unmount: () => {
      root.unmount();
      host.remove();
      client.clear();
    },
  };
}

describe("a message sent while the agent works", () => {
  test("is on screen one round trip after the send returns — not a poll interval later", async () => {
    const steps: TurnStep[] = [{ seq: 1, at: 1_100, kind: "tool", text: "web_search deepseek flash v4", ms: 100 }];
    const daemon: FakeDaemon = {
      live: () => turnOf("turn_1", "lu bisa cari deepseek flash v4?", steps),
      recorded: () => [],
      onSend: () =>
        steps.push(
          { seq: 2, at: 1_500, kind: "steer", text: "cari juga haiku 5.5 deh", ms: 400 },
          { seq: 3, at: 1_501, kind: "steer_reply", text: ACK, ms: 1 },
        ),
      liveMs: 80,
      sendMs: 40,
      liveCalls: 0,
    };
    serve(daemon);
    const view = await mount();
    try {
      await eventually(() => view.latest()?.liveTurns[0]?.status === "running", 2_000);
      // Between two polls, none in flight: the next one on the schedule is about 400ms away.
      const calls = daemon.liveCalls;
      await eventually(() => daemon.liveCalls > calls, 1_000);
      await sleep(daemon.liveMs + 100);

      view.latest()!.send("cari juga haiku 5.5 deh");
      // The poll `send` wakes goes out before the daemon has the message, and is still out when the send
      // answers: that wake has to be kept, not dropped as a second loop.
      await eventually(() => saidWhileWorking(view.latest()?.liveTurns[0]?.steps ?? []).length === 2, 350, "the steer shown before the next scheduled poll");
      expect(saidWhileWorking(view.latest()!.liveTurns[0]!.steps).map((step) => step.text)).toEqual(["cari juga haiku 5.5 deh", ACK]);
      // Read into the running turn, so no placeholder waiting for a turn of its own.
      expect(view.latest()!.pending).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("never read, it starts the next turn — and the one before is folded into the history all the same", async () => {
    // Between two polls: the first turn finishes, and the message it never read starts the next one.
    let newest = turnOf("turn_1", "lu bisa cari deepseek flash v4?", []);
    let recorded: ChatTurn[] = [];
    const daemon: FakeDaemon = { live: () => newest, recorded: () => recorded, liveMs: 5, sendMs: 5, liveCalls: 0 };
    serve(daemon);
    const view = await mount();
    try {
      await eventually(() => view.latest()?.liveTurns[0]?.id === "turn_1", 2_000);
      recorded = [{ ...turnOf("turn_1", "lu bisa cari deepseek flash v4?", [], "done"), reply: "DeepSeek is cheaper." }];
      newest = turnOf("turn_2", "cari juga haiku 5.5 deh", []);

      await eventually(() => view.latest()?.liveTurns[0]?.id === "turn_2", 2_000);
      await eventually(() => Boolean(view.latest()?.turns.some((turn) => turn.id === "turn_1")), 1_000);
    } finally {
      view.unmount();
    }
  });
});
