/**
 * The live "Working" card: whole seconds on the clock, the reasoning before the calls, and the calls
 * as whole rows, the newest few with the earlier ones a press away, rather than a list that grows.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatDuration, formatElapsed, saidWhileWorking, turnTokens, workSteps } from "@/commons/lib/steps";
import { StepFeed } from "@/commons/components/turns/Steps";
import { LiveTurnView, TurnView } from "@/modules/chat/components/Turn";
import type { ChatTurn, LiveTurn, TurnStep } from "@nouride/wire";

describe("the clock", () => {
  test("whole seconds — no tenths", () => {
    expect(formatElapsed(4_400)).toBe("4s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(65_900)).toBe("1m 5s");
    expect(formatElapsed(120_000)).toBe("2m");
    expect(formatDuration(12_800)).toBe("13s");
    expect(formatDuration(480)).toBe("480ms");
    expect(formatDuration(224_000)).toBe("3m 44s");
  });
});

describe("the live feed", () => {
  const steps: TurnStep[] = [
    { seq: 1, at: 0, kind: "reasoning", text: "Find the newest model first, then check its card.", ms: 0 },
    ...Array.from({ length: 12 }, (_, i) => [
      { seq: 2 + i * 2, at: i, kind: "tool" as const, text: `web_search query ${i}`, ms: 10 },
      { seq: 3 + i * 2, at: i, kind: "tool_done" as const, text: "web_search ok", ms: 10 },
    ]).flat(),
  ];

  test("reasoning comes before the calls, the newest are whole rows, and the earlier ones are a press away", () => {
    const html = renderToString(createElement(StepFeed, { steps, elapsedMs: 4_400, running: true }));
    expect(html).toContain("Working");
    expect(html).toContain("4s");
    expect(html).not.toContain("4.4s");
    expect(html.indexOf("Reasoning")).toBeLessThan(html.indexOf("Show 6 earlier steps"));
    // A box scrolled to its newest row cut the row at its top in half; whole rows, and the rest on a press.
    expect(html).not.toContain("web_search query 5<");
    expect(html).toContain("web_search query 6<");
    expect(html).toContain("web_search query 11<");
    expect(html).not.toMatch(/<div class="[^"]*overflow-y-auto/);
  });
});

describe("a step's row", () => {
  test("a long outcome is cut, whole on hover, and the call's name keeps a width (0.8.1)", () => {
    // A coding CLI's outcome is a line of what its call returned; it kept its full width on the right, and squeezed
    // "WebSearch" to a letter a line on the live box.
    const outcome = "ok: Claude Mythos (https://en.wikipedia.org/wiki/Claude_Mythos) · 5563ms";
    const html = renderToString(createElement(StepFeed, { steps: [{ seq: 1, at: 0, kind: "tool", text: "WebSearch", ms: 0 }, { seq: 2, at: 1, kind: "tool_done", text: `WebSearch ${outcome}`, ms: 5563 }], elapsedMs: 6_000, running: false }));
    expect(html).toMatch(/class="min-w-20 flex-1[^"]*">WebSearch</);
    expect(html).toMatch(new RegExp(`class="[^"]*\\bsm:truncate[^"]*" title="${outcome.replace(/[.()?]/g, "\\$&")}"`));
  });

  test("on a phone, what it said is the first line and the call the whole width under it (0.8.12)", () => {
    // A Claude Code command beside "Bash ok: nr-ag…" was a column of twelve letters on an iPhone.
    const command = "getent group nr-agents; id nr-nexa 2>&1; S=/srv/nouride/.nouride/workspace/shared/nouride-demo";
    const html = renderToString(createElement(StepFeed, { steps: [{ seq: 1, at: 0, kind: "tool", text: command, ms: 0 }, { seq: 2, at: 1, kind: "tool_done", text: `${command.split(" ")[0]} Bash ok: nr-agents:x:997:`, ms: 40 }], elapsedMs: 1_000, running: false }));
    const call = /<div class="([^"]*)">getent group/.exec(html)?.[1] ?? "";
    expect(call.split(" ")).toEqual(expect.arrayContaining(["max-sm:order-last", "max-sm:basis-full"]));
    // The row wraps on a phone only; a desktop keeps the call and its outcome side by side.
    expect(html).toMatch(/class="[^"]*\bflex-wrap\b[^"]*\bsm:flex-nowrap\b[^"]*"/);
    expect(html).toMatch(/class="flex min-w-0 items-baseline[^"]*max-sm:flex-1[^"]*sm:max-w-\[45%\]/);
  });

  test("a call nothing was said about yet keeps its place beside its icon", () => {
    const html = renderToString(createElement(StepFeed, { steps: [{ seq: 1, at: 0, kind: "tool", text: "exec ls -la", ms: 0 }], elapsedMs: 100, running: true }));
    const call = /<div class="([^"]*)">exec ls -la/.exec(html)?.[1] ?? "";
    expect(call).toContain("flex-1");
    expect(call).not.toContain("max-sm:order-last");
  });
});

describe("the finished pill's token line", () => {
  test("says nothing for a turn recorded with no tokens — a coding CLI's, whose spend is its model call's (0.8.12)", () => {
    expect(turnTokens(0, 0)).toBeNull();
    expect(turnTokens(0, undefined)).toBeNull();
    expect(turnTokens(undefined, undefined)).toBeNull();
  });

  test("says what a turn its own model answered spent", () => {
    expect(turnTokens(15_600, 260)).toBe("15,600 in / 260 out tokens");
    expect(turnTokens(1_200, undefined)).toBe("1,200 in tokens");
    // Out without in is still a figure.
    expect(turnTokens(0, 12)).toBe("0 in / 12 out tokens");
  });
});

/**
 * A message sent while the agent works, steering it. Reported from the dashboard: the agent read it, and all
 * the page showed was a step quoting its first 120 characters — no bubble of the person's own, and no "Got it".
 */
describe("what was said while it worked", () => {
  const ACK = "↪ Got it, I'll read that before my next step.";
  /** The person's own bubble: square at the top right, where it points at them (`UserBubble`). */
  const PERSON_BUBBLE = "rounded-tr-xs";
  const steered: TurnStep[] = [
    { seq: 1, at: 1_000, kind: "tool", text: "web_search deepseek flash v4 vs gpt luna 5.6", ms: 900 },
    { seq: 2, at: 2_100, kind: "steer", text: "cari juga haiku 5.5 deh", ms: 1_100 },
    { seq: 3, at: 2_110, kind: "steer_reply", text: ACK, ms: 10 },
    { seq: 4, at: 3_400, kind: "steer_reply", text: "siap, gw cariin juga", ms: 1_290 },
  ];
  const turn = (overrides: Partial<LiveTurn> = {}): LiveTurn => ({
    id: "turn_1",
    agentId: "ren",
    chatId: "dev-1",
    status: "running",
    prompt: "lu bisa cari deepseek flash v4 vs gpt luna 5.6?",
    reply: "",
    toolCalls: 1,
    startedAt: 100,
    steps: steered,
    cursor: 4,
    ...overrides,
  });
  // Without the comments React puts between adjacent text nodes, so "1 step" reads as it does on screen.
  // A reply reads its agent's face from the status query: a client with nothing in it draws the column without one.
  const html = (element: Parameters<typeof renderToString>[0]) =>
    renderToString(createElement(QueryClientProvider, { client: new QueryClient() }, element)).replaceAll("<!-- -->", "");
  /** Both drawn, in this order. A bare `indexOf` comparison passes when the first is missing: -1 is before anything. */
  const inOrder = (page: string, ...texts: string[]) => {
    const at = texts.map((text) => page.indexOf(text));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  };

  test("is the conversation inside the turn, in order — and none of it a step", () => {
    expect(saidWhileWorking(steered).map((step) => step.text)).toEqual(["cari juga haiku 5.5 deh", ACK, "siap, gw cariin juga"]);
    expect(workSteps(steered).map((step) => step.seq)).toEqual([1]);
  });

  test("the person's message is their own bubble, under the steps, with what they were told under it", () => {
    const live = html(createElement(LiveTurnView, { turn: turn(), sessionId: "s1", showPrompt: true }));
    // The prompt and the message: two bubbles of the person's own — found by the corner that points at them, not
    // by a colour, which is the theme's to change.
    expect(live.split(PERSON_BUBBLE)).toHaveLength(3);
    inOrder(live, "web_search deepseek", "cari juga haiku 5.5 deh", "Got it", "siap, gw cariin juga");
    // Counted as the one thing it did.
    expect(live).toContain("1 step");

    const done = html(createElement(TurnView, { turn: { ...turn({ status: "done", reply: "Haiku 5.5 is cheaper." }) } as ChatTurn, sessionId: "s1", showPrompt: true }));
    // Outside the collapsed pill, and above the answer, which was written after the message was read.
    inOrder(done, "1 step", "cari juga haiku 5.5 deh", "Got it", "siap, gw cariin juga", "Haiku 5.5 is cheaper.");
  });

  test("in a room the message is the room's own bubble, so here it is only quoted", () => {
    const live = html(createElement(LiveTurnView, { turn: turn(), sessionId: "s1", showPrompt: false }));
    expect(live).not.toContain(PERSON_BUBBLE);
    expect(live).toContain("cari juga haiku 5.5 deh");
    expect(live).toMatch(/border-l-2[^"]*"[^>]*>cari juga haiku 5\.5 deh/);
    expect(live).toContain("siap, gw cariin juga");
  });

  test("a message sent mid-call does not make the call look finished", () => {
    // The search is still running: its own spinner, and no "Thinking…" under it as if the model had the floor.
    const midCall: TurnStep[] = [
      { seq: 1, at: 1_000, kind: "tool", text: "web_search haiku 5.5", ms: 900 },
      { seq: 2, at: 1_500, kind: "steer", text: "sama sonnet juga", ms: 500 },
    ];
    const feed = html(createElement(StepFeed, { steps: midCall, elapsedMs: 2_000, running: true }));
    expect(feed).not.toContain("Thinking");
    expect(feed).not.toContain("sama sonnet juga");
  });
});
