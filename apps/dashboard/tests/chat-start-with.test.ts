/**
 * The agent a new chat starts with when a link names one (`?agent=`), as the Office's Open chat does — it opened
 * `/chat` whichever cat was picked, and the chat started with the orchestrator (2026-11-02).
 */

import { describe, expect, test } from "bun:test";
import { parseChatSearch, startWith } from "@/modules/chat/lib/start-with";

const AGENTS = [{ id: "nouva" }, { id: "nix" }];

describe("the agent a new chat starts with", () => {
  test("is the one the link names, in a new chat", () => {
    expect(startWith("nix", undefined, AGENTS)).toBe("nix");
  });

  test("never over a conversation already open: that is its own agent's", () => {
    expect(startWith("nix", "ses_nouva:web:dashboard:web-1", AGENTS)).toBe("");
  });

  test("is none for an agent the daemon does not have — or before its list has arrived", () => {
    expect(startWith("ghost", undefined, AGENTS)).toBe("");
    expect(startWith("nix", undefined, [])).toBe("");
    expect(startWith(undefined, undefined, AGENTS)).toBe("");
  });
});

describe("what /chat takes from its URL", () => {
  test("the agent, trimmed, and nothing else — never a message to send", () => {
    expect(parseChatSearch({ agent: " nix " })).toEqual({ agent: "nix" });
    expect(parseChatSearch({ agent: "", message: "hi" })).toEqual({});
    expect(parseChatSearch({ agent: 42 })).toEqual({});
  });

  test("a draft for the box (0.8.19, AskAgentButton): trimmed, cut to a message's length, and nothing when empty", () => {
    expect(parseChatSearch({ agent: "nouva", draft: " Please install Claude Code. " })).toEqual({ agent: "nouva", draft: "Please install Claude Code." });
    expect(parseChatSearch({ draft: "   " })).toEqual({});
    expect(parseChatSearch({ draft: ["a"] })).toEqual({});
    expect(parseChatSearch({ draft: "x".repeat(5_000) }).draft).toHaveLength(2_000);
  });
});
