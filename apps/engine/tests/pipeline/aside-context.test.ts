/**
 * What a call beside the conversation is shown of it (`aside-context.ts`, 0.8.20): `/btw` and the steer line see the
 * conversation and the work in flight as the agent does. A side question on a coding CLI's turn,
 * fifteen tool calls in, was shown only its prompt (live, 2026-11-05): a CLI journals its prompt and records its steps.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@nouride/shared";
import { conversationSoFar, workInFlight } from "@/modules/pipeline/aside-context.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import type { JournalEntry } from "@/modules/turns/journal.store.ts";
import type { TurnStep } from "@/modules/turns/turns.store.ts";

const user = (content: string): ChatMessage => ({ role: "user", content, timestamp: 0 });
const assistant = (content: string, toolCalls?: ChatMessage["toolCalls"]): ChatMessage => ({ role: "assistant", content, ...(toolCalls ? { toolCalls } : {}), timestamp: 0 });

describe("the conversation so far", () => {
  test("what was said, by whom, in order: the tool calls and their results left out", () => {
    const said = conversationSoFar(
      [
        user("is the disk full?"),
        assistant("", [{ id: "c1", name: "exec", arguments: { command: "df -h" } }]),
        { role: "tool", content: "/dev/sda1 30%", toolCallId: "c1", timestamp: 0 } as ChatMessage,
        assistant("30% used."),
        user("and the inodes?"),
      ],
      10_000,
    );
    expect(said).toBe("They said: is the disk full?\nYou said: 30% used.\nThey said: and the inodes?");
  });

  test("the newest kept within its budget, a long message cut", () => {
    const messages = Array.from({ length: 40 }, (_, i) => (i % 2 ? assistant(`answer ${i}`) : user(`question ${i}`)));
    const said = conversationSoFar(messages, 200);
    expect(said.length).toBeLessThanOrEqual(200);
    expect(said.endsWith("You said: answer 39")).toBe(true);
    expect(said).not.toContain("question 0\n");
    const long = conversationSoFar([user("x".repeat(5_000))], 10_000);
    expect(long.length).toBeLessThan(1_600);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a conversation just begun has none", () => {
    expect(conversationSoFar([], 10_000)).toBe("");
  });
});

describe("the work in flight", () => {
  const deps = (o: { running: string | null; entries: JournalEntry[]; steps: Partial<TurnStep>[] }) =>
    ({
      turns: { runningFor: () => o.running, stepsSince: () => o.steps },
      journal: { read: () => ({ entries: o.entries }) },
    }) as unknown as Pick<PipelineDeps, "turns" | "journal">;

  test("none running: nothing", () => {
    expect(workInFlight(deps({ running: null, entries: [], steps: [] }), "nix", "telegram:nix", "1")).toBe("");
  });

  test("an agent on its own model: its journal, every step it took, and not the recorded steps again", () => {
    const shown = workInFlight(
      deps({
        running: "t1",
        entries: [{ message: user("check the release") }, { message: assistant("", [{ id: "c1", name: "exec", arguments: { command: "gh release list" } }]) }] as JournalEntry[],
        steps: [{ kind: "tool", text: "exec gh release list" }],
      }),
      "nouva",
      "telegram:nouva",
      "1",
    );
    expect(shown).toContain("Asked: check the release");
    expect(shown).toContain('You called exec {"command":"gh release list"}');
    expect(shown).not.toContain("- exec gh release list");
  });

  test("a coding CLI's: its prompt, then the steps it recorded, which its journal does not hold", () => {
    const shown = workInFlight(
      deps({
        running: "t1",
        entries: [{ message: user("cek progress claude di v0.8.19") }] as JournalEntry[],
        steps: [
          { kind: "tool", text: "exec ls ~/.claude/projects" },
          { kind: "reasoning", text: "weighing which session is the release one" },
          { kind: "tool_done", text: "exec: 3 sessions" },
          { kind: "note", text: "Claude's session on the laptop is found" },
        ],
      }),
      "nix",
      "telegram:nix",
      "1",
    );
    expect(shown).toBe("Asked: cek progress claude di v0.8.19\n- exec ls ~/.claude/projects\n- exec: 3 sessions\n- Claude's session on the laptop is found");
  });
});
