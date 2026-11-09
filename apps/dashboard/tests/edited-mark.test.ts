/**
 * The "edited" mark: a person's message that was answered as edited says so, quietly, under it.
 *
 * The daemon has recorded it since 0.7.17 — `cause: { via: "edit" }` on the turn that answered an edit, `editOf` on a
 * message edited while a turn worked — and the chat drew neither: an edited message read exactly like one typed that
 * way, and a mid-turn edit showed only the `✎` the record keeps for readers that know no `editOf`.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { answersAnEdit, saidAsDrawn } from "../src/commons/lib/turn-display.ts";
import { TurnView } from "../src/modules/chat/components/Turn.tsx";
import type { ChatTurn } from "@nouride/wire";

const turn = (extra: Partial<ChatTurn> = {}): ChatTurn => ({
  id: "t1",
  agentId: "nouva",
  chatId: "tg-1",
  status: "done",
  prompt: "what time is it in Jakarta?",
  reply: "It is 9pm.",
  toolCalls: 0,
  startedAt: 1,
  steps: [],
  ...extra,
});

// A reply reads its agent's face from the status query: a client with nothing in it draws the column without one.
const drawn = (value: ChatTurn) => renderToString(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TurnView, { turn: value, sessionId: "s1" })));

describe("is this an edit", () => {
  test("a turn whose cause is a person's edit is one — edited while it waited or after it was answered", () => {
    expect(answersAnEdit({ cause: { via: "edit", of: "m1" } })).toBe(true);
    expect(answersAnEdit({ cause: { via: "edit" } })).toBe(true);
  });

  test("a turn typed as it is, one the daemon started, or one from before causes were kept is not", () => {
    expect(answersAnEdit({})).toBe(false);
    expect(answersAnEdit({ cause: { via: "schedule", job: "job_1" }, system: true })).toBe(false);
    expect(answersAnEdit({ cause: { via: "edit", of: "m1" }, system: true })).toBe(false);
  });

  test("a message said while a turn worked is drawn marked when it is an edit, without the ✎ kept for older readers", () => {
    expect(saidAsDrawn({ text: "✎ make it Bandung", editOf: "m2" })).toEqual({ text: "make it Bandung", edited: true });
    expect(saidAsDrawn({ text: "✎ a pencil I typed myself" })).toEqual({ text: "✎ a pencil I typed myself", edited: false });
  });
});

describe("on the page", () => {
  test("the edited message carries the mark, said in words a screen reader reads", () => {
    const html = drawn(turn({ cause: { via: "edit", of: "m1" } }));
    expect(html).toContain("edited");
    expect(html).toContain("answered as it reads now");
  });

  test("a message nobody edited carries none", () => {
    expect(drawn(turn())).not.toContain("edited");
  });

  test("a message edited while the turn worked is marked where it is drawn", () => {
    const html = drawn(turn({ steps: [{ seq: 1, at: 2, ms: 1, kind: "steer", text: "✎ make it Bandung", editOf: "m1" }] }));
    expect(html).toContain("make it Bandung");
    expect(html).not.toContain("✎");
    expect(html).toContain("edited");
  });
});
