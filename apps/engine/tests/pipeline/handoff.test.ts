/**
 * The return contract for delegated work.
 *
 * Every test here is one way a worker's own final message lies about what happened, and the assertion
 * is that the envelope says otherwise. That is the whole point of the file: the status and the file
 * list are derived from what the harness watched, so a model cannot report success it did not have.
 */

import { describe, expect, test } from "bun:test";
import { buildHandoff, isHandoffError, renderHandoff, type HandoffSource } from "@/modules/tools/handoff.ts";

/** A turn that finished cleanly, with the fields a caller can override per test. */
function source(over: Partial<HandoffSource> = {}): HandoffSource {
  return {
    agentId: "nox",
    startedAt: 1_000,
    now: 18_000,
    result: {
      text: "build fixed, PR is up",
      toolCalls: 5,
      iterations: 3,
      approvalsRefused: 0,
      toolSteps: [
        { name: "read", ok: true, path: "/w/a.ts" },
        { name: "edit", ok: true, path: "/w/a.ts" },
      ],
      stopReason: "stop",
      ...over.result,
    },
    ...over,
  };
}

describe("status is derived, not declared", () => {
  test("a clean run is success", () => {
    const h = buildHandoff(source());
    expect(h.status).toBe("success");
    expect(h.reason).toBeUndefined();
    expect(isHandoffError(h)).toBe(false);
  });

  test("a refused approval is requires_human, however confident the summary sounds", () => {
    // The case this file exists for. The worker wrote "build fixed, PR is up" *and* had a tool call
    // refused, so part of what it just claimed did not happen. Before the envelope, the caller had
    // nothing but that sentence and relayed it to a person as done.
    const h = buildHandoff(source({ result: { ...source().result!, approvalsRefused: 1 } }));

    expect(h.status).toBe("requires_human");
    expect(h.reason).toContain("not approved");
    // Still not a tool error: the work partly happened, and flagging it as a failure would invite the
    // caller to throw away the part that did.
    expect(isHandoffError(h)).toBe(false);
    expect(h.summary).toBe("build fixed, PR is up");
  });

  test("more than one refusal is counted, not pluralised wrongly", () => {
    const h = buildHandoff(source({ result: { ...source().result!, approvalsRefused: 3 } }));
    expect(h.reason).toContain("3 tool calls");
  });

  test("a stopped turn is incomplete even with text in hand", () => {
    // `/stop`, or the turn deadline. The worker still returns whatever paragraph it had written.
    const h = buildHandoff(source({ aborted: true }));
    expect(h.status).toBe("incomplete");
    expect(h.reason).toContain("stopped");
  });

  test("still asking for tools when the loop ended means it hit the ceiling", () => {
    const h = buildHandoff(source({ result: { ...source().result!, stopReason: "tool_calls" } }));
    expect(h.status).toBe("incomplete");
    expect(h.reason).toContain("tool-call limit");
  });

  test("wrapped up at its limit — of rounds or of time — is incomplete, though the wrap-up ends the loop with `stop`", () => {
    // The wrap-up call rewrote the stop reason to `stop`, so a helper cut off at its limit handed back `success` with a
    // summary that itself said it had not finished — and a background helper's parent reported it done (0.7.15).
    const rounds = buildHandoff(source({ result: { ...source().result!, wrappedUp: "iteration cap" } }));
    expect(rounds.status).toBe("incomplete");
    expect(rounds.reason).toContain("tool-call limit");
    const time = buildHandoff(source({ result: { ...source().result!, wrappedUp: "turn deadline" } }));
    expect(time.status).toBe("incomplete");
    expect(time.reason).toContain("ran out of time");
    // A wrap-up a tool asked for is how the work was meant to end, not a limit.
    expect(buildHandoff(source({ result: { ...source().result!, wrappedUp: "background_started" } })).status).toBe("success");
  });

  test("ended by the same call giving the same answer is incomplete, not success", () => {
    // Live (0.8.12): a video helper re-read the same stills until `SameAnswers` ended it; it handed back `success` with
    // a summary that began "Not finished", and the job was listed as succeeded.
    const h = buildHandoff(source({ result: { ...source().result!, wrappedUp: "same_answer" } }));
    expect(h.status).toBe("incomplete");
    expect(h.reason).toContain("same answer");
  });

  test("running out of output space is incomplete, not success", () => {
    const h = buildHandoff(source({ result: { ...source().result!, stopReason: "max_tokens" } }));
    expect(h.status).toBe("incomplete");
  });

  test("silence is incomplete, and says so rather than reading as an empty answer", () => {
    const h = buildHandoff(source({ result: { ...source().result!, text: "   " } }));
    expect(h.status).toBe("incomplete");
    expect(h.reason).toContain("without saying anything");
  });

  test("a thrown run is failed, and the reason is the error", () => {
    const h = buildHandoff({ agentId: "nox", startedAt: 0, now: 500, error: "nox is paused" });
    expect(h.status).toBe("failed");
    expect(h.reason).toBe("nox is paused");
    expect(isHandoffError(h)).toBe(true);
    expect(h.metrics).toEqual({ toolCalls: 0, steps: 0, ms: 500 });
  });

  test("failure outranks a refused approval", () => {
    // Both are true and only one is worth saying: the run did not finish, so "it needs a human" is
    // not the thing the caller has to act on.
    const h = buildHandoff(
      source({ error: "the provider refused the request", result: { ...source().result!, approvalsRefused: 2 } }),
    );
    expect(h.status).toBe("failed");
  });
});

describe("the file list comes from the tool calls, not the summary", () => {
  test("only the tools that write, and each path once", () => {
    const h = buildHandoff(
      source({
        result: {
          ...source().result!,
          toolSteps: [
            { name: "read", ok: true, path: "/w/read-only.ts" },
            { name: "write", ok: true, path: "/w/new.ts" },
            { name: "edit", ok: true, path: "/w/a.ts" },
            { name: "edit", ok: true, path: "/w/a.ts" },
            { name: "multi_edit", ok: true, path: "/w/b.ts" },
            { name: "grep", ok: true, path: "/w/never.ts" },
          ],
        },
      }),
    );

    // Order is first-touched, and a file edited twice appears once.
    expect(h.files).toEqual(["/w/new.ts", "/w/a.ts", "/w/b.ts"]);
    // `read` and `grep` take a path and change nothing. Listing them would tell the caller a file was
    // modified when it was only opened.
    expect(h.files).not.toContain("/w/read-only.ts");
    expect(h.files).not.toContain("/w/never.ts");
  });

  test("a step with no path is skipped rather than listed as blank", () => {
    const h = buildHandoff(
      source({ result: { ...source().result!, toolSteps: [{ name: "write", ok: true }] } }),
    );
    expect(h.files).toEqual([]);
  });
});

describe("what the caller reads", () => {
  test("status first, then the summary, then the facts", () => {
    const text = renderHandoff(buildHandoff(source()));
    const lines = text.split("\n");

    expect(lines[0]).toBe("[nox · success]");
    expect(lines[1]).toBe("build fixed, PR is up");
    expect(text).toContain("Files it changed: /w/a.ts");
    expect(text).toContain("5 tool calls · 3 steps · 17s");
  });

  test("the metrics line is there to make a grinding worker visible", () => {
    // The failure it exists for: a specialist asked one question that answers with ninety-three small
    // tool calls over thirty-two model turns and fills its own context until the run dies. From the
    // caller's side that is indistinguishable from a slow answer until it is too late.
    const text = renderHandoff(
      buildHandoff(
        source({
          aborted: true,
          result: { ...source().result!, toolCalls: 93, iterations: 32 },
        }),
      ),
    );

    expect(text).toContain("93 tool calls · 32 steps");
    expect(text).toContain("incomplete");
  });

  test("a reason is shown whenever there is one", () => {
    const text = renderHandoff(buildHandoff(source({ result: { ...source().result!, approvalsRefused: 1 } })));
    expect(text).toContain("[nox · requires_human]");
    expect(text).toContain("not approved");
  });

  test("no report says so, rather than rendering an empty line", () => {
    const text = renderHandoff(buildHandoff({ agentId: "nox", startedAt: 0, now: 0, error: "gone" }));
    expect(text).toContain("(no report)");
    expect(text).toContain("gone");
  });

  test("nothing is truncated here", () => {
    // A worker that writes four pages is a real problem, and the fix for it is one level up: the
    // executor caps and spills an oversized tool result, handing the caller a head, a tail and a path.
    // A second quieter cap in the renderer would drop text with no pointer to what was dropped.
    const long = "x".repeat(20_000);
    const text = renderHandoff(buildHandoff(source({ result: { ...source().result!, text: long } })));
    expect(text).toContain(long);
  });

  test("singulars read as singulars", () => {
    const text = renderHandoff(
      buildHandoff(source({ result: { ...source().result!, toolCalls: 1, iterations: 1 } })),
    );
    expect(text).toContain("1 tool call · 1 step ·");
  });
});

describe("large outputs are handed back by path", () => {
  test("a spilled call is listed once per call, and rendered as something to open", () => {
    const h = buildHandoff(
      source({
        result: {
          ...source().result!,
          toolSteps: [
            { name: "exec", ok: true, spilledTo: "/data/tool-output/s/c1.txt" },
            { name: "exec", ok: false, spilledTo: "/data/tool-output/s/c2.txt" },
            { name: "read", ok: true, path: "/w/a.ts" },
          ],
        },
      }),
    );
    expect(h.spills).toEqual(["/data/tool-output/s/c1.txt", "/data/tool-output/s/c2.txt"]);
    expect(renderHandoff(h)).toContain("open with `read` (offset/limit) or `grep`: /data/tool-output/s/c1.txt, /data/tool-output/s/c2.txt");
  });

  test("nothing is said when nothing spilled", () => {
    expect(renderHandoff(buildHandoff(source()))).not.toContain("Full output");
  });
});

