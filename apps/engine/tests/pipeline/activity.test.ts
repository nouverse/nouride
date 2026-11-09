/**
 * The lines a turn's steps are written as.
 *
 * Observed while writing the CLI walkthrough: a turn that ran 21 seconds showed nothing at all — blank
 * screen, then a finished answer. The daemon knew it was reading a file and calling a provider; none of
 * it reached the person waiting. A long silence is indistinguishable from a hang.
 */

import { describe, expect, test } from "bun:test";
import { describeToolCall, describeToolResult } from "@/commons/activity.ts";

describe("describeToolCall", () => {
  test.each([
    ["exec", { command: ["bun", "test"] }, "exec bun test"],
    ["read", { path: "notes.md" }, "read notes.md"],
    ["grep", { pattern: "FIXME" }, "grep FIXME"],
    ["web_fetch", { url: "https://example.com" }, "web_fetch https://example.com"],
  ] as const)("%s reads like a terminal line", (name, args, expected) => {
    // `exec bun test`, not `exec {"command":["bun","test"]}`. Someone watching wants to recognise the
    // action at a glance; the audit log has the full arguments for when they want precision.
    expect(describeToolCall(name, args)).toBe(expected);
  });

  test("an unfamiliar tool still shows something", () => {
    expect(describeToolCall("mystery", { alpha: 1 })).toContain("alpha");
  });

  test("a tool with no arguments is just its name", () => {
    expect(describeToolCall("session_status", {})).toBe("session_status");
  });

  test("a very long argument is clipped", () => {
    const text = describeToolCall("exec", { command: ["echo", "x".repeat(500)] });
    expect(text.length).toBeLessThan(200);
  });

  test("a clipped command keeps the end, which is what it is about", () => {
    // The live complaint, and the reason this test is here rather than only in the chat renderer:
    // *this* is where the cut happens. It used to take 120 characters off the front with no marker,
    // so every long `ssh` step read as "ssh-ing somewhere" and the host and command it ran — the
    // whole point of the line — were gone before anything else could show them.
    const text = describeToolCall("exec", {
      command: [
        "ssh",
        "-i",
        "/srv/nouride/.nouride/agents/shared/.credentials/id_ed25519_nouva",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=no",
        "user@192.168.0.6",
        'powershell -Command "Get-ChildItem D:\\projects\\voice-compute\\voices"',
      ],
    });

    expect(text.startsWith("exec ssh -i /srv/nouride")).toBe(true);
    // The half that used to be thrown away silently.
    expect(text).toContain("voice-compute");
    // And it is visibly a cut, rather than a command that happens to end there.
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(200);
  });
});

describe("describeToolResult", () => {
  test("a search that found nothing does not say ok", () => {
    // `glob ok` for zero matches cost real debugging time: a search that had found nothing looked like a
    // search that had worked, and the operator concluded the agent was confused when its workspace root
    // simply did not exist.
    expect(describeToolResult({ isError: false, metadata: { count: 0 } })).toBe("no matches");
    expect(describeToolResult({ isError: false, metadata: { matches: 0 } })).toBe("no matches");
  });

  test("a search that found something says how many", () => {
    expect(describeToolResult({ isError: false, metadata: { count: 3 } })).toBe("3 found");
  });

  test("a tool with no count keeps ok rather than inventing one", () => {
    expect(describeToolResult({ isError: false })).toBe("ok");
    expect(describeToolResult({ isError: false, metadata: { path: "/x" } })).toBe("ok");
  });

  test("an error is an error whatever the count says", () => {
    // A count is not evidence of success: a tool can return matches and still have failed.
    expect(describeToolResult({ isError: true, metadata: { count: 5 } })).toBe("failed");
  });

  describe("a command that ran and exited non-zero", () => {
    /**
     * The misreading this fixes, from a live screen:
     *
     *     exec which chromium chromium-browser google-chrome
     *     exec failed · 3ms
     *
     * Nothing had broken. `which` exits 1 when it finds nothing, so that is the agent asking whether a
     * browser is installed and being told no. Three of the four red rows on that screen were `which`
     * probes and the fourth was an `import playwright` check; the turn succeeded by another route.
     */
    test("reports its exit code, which is an answer rather than an accusation", () => {
      expect(describeToolResult({ isError: true, metadata: { exitCode: 1 } })).toBe("exit 1");
      expect(describeToolResult({ isError: true, metadata: { exitCode: 127 } })).toBe("exit 127");
    });

    test("a timeout is named as one, not as an exit code", () => {
      // A killed process has an exit code too, and `exit 143` would send somebody looking up what
      // signal 15 means instead of reading the one word that explains it.
      expect(
        describeToolResult({ isError: true, metadata: { timedOut: true, exitCode: 143 } }),
      ).toBe("timed out");
    });

    test("a command killed with the turn says so", () => {
      expect(describeToolResult({ isError: true, metadata: { aborted: true, exitCode: 143 } })).toBe(
        "killed",
      );
    });

    test("anything that never ran is still `failed`", () => {
      // A refusal, a throw, a path outside the sandbox: no exit code, because nothing executed. This
      // is the case the word was always right for.
      expect(describeToolResult({ isError: true })).toBe("failed");
      expect(describeToolResult({ isError: true, metadata: { exitCode: null } })).toBe("failed");
      // Exit 0 with `isError` set is a tool reporting failure some other way — `send_file` refusing a
      // web page, for instance. Not an exit code worth showing.
      expect(describeToolResult({ isError: true, metadata: { exitCode: 0 } })).toBe("failed");
    });
  });
});

describe("a batched web_fetch", () => {
  test("names the hosts, not the JSON", () => {
    // The fallback cut the JSON after the first URL, so a two-page batch read as a one-page fetch.
    expect(describeToolCall("web_fetch", { urls: ["https://example.com/a", "https://docs.example.org/b"] })).toBe(
      "web_fetch 2 pages: example.com, docs.example.org",
    );
  });

  test("its result says how many pages came back and how long the slowest took", () => {
    // Set against the call's own duration, which follows it on the same line, that is what shows the
    // pages ran together: the call takes about as long as its slowest page, not the sum of them.
    expect(describeToolResult({ isError: false, metadata: { pages: 3, failed: 1, slowestMs: 412 } })).toBe(
      "2/3 pages · slowest 412ms",
    );
  });
});
