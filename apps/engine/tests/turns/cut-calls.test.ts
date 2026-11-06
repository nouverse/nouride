/**
 * A call a restart cut off, read for what taking its turn up may do — one reading for a chat's turn and a mission's.
 */

import { describe, expect, test } from "bun:test";
import { cutKind, cutLine, worstCut } from "@/modules/turns/cut-calls.ts";
import { restartResumeEnvelope } from "@/modules/pipeline/restart-resume.ts";

describe("a cut-off call", () => {
  test("that only read is a read; a send and a fixed-list command ask; anything else may have changed something", () => {
    expect(cutKind({ name: "read", arguments: { path: "a.txt" } })).toBe("read");
    expect(cutKind({ name: "web_fetch", arguments: { url: "https://example.com" } })).toBe("read");
    expect(cutKind({ name: "send_message", arguments: { text: "hi" } })).toBe("asks");
    expect(cutKind({ name: "exec", arguments: { command: "rm -rf /srv/data" } })).toBe("asks");
    expect(cutKind({ name: "exec", arguments: { command: "touch made.txt" } })).toBe("changed");
    expect(cutKind({ name: "write", arguments: { path: "a.txt", content: "x" } })).toBe("changed");
  });

  test("the worst of several decides: one that asks over one that changed over one that read", () => {
    const read = { name: "read", arguments: { path: "a" } };
    const write = { name: "write", arguments: { path: "a", content: "" } };
    const rm = { name: "exec", arguments: { command: "rm -rf /srv/data" } };
    expect(worstCut([read, write, rm])?.kind).toBe("asks");
    expect(worstCut([read, write])?.call).toBe(write);
    expect(worstCut([])).toBeNull();
  });

  test("taken up again, the turn is told which call it was cut off in, and to check one that changed things", () => {
    const changed = { kind: "changed" as const, call: { name: "exec", arguments: { command: "./deploy.sh" } } };
    expect(cutLine(changed)).toContain("whether it ran is unknown: check before you redo it");
    const envelope = restartResumeEnvelope({ id: "turn_1", agentId: "nouva", gatewayId: "telegram:main", chatId: "c1", prompt: "deploy" }, "telegram", "dm", "restart", [], changed);
    expect(envelope.text).toContain("It was cut off in `exec ./deploy.sh`");
    expect(cutLine({ kind: "read", call: { name: "read", arguments: { path: "a.txt" } } })).toContain("which only reads");
  });
});
