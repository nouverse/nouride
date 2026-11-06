/**
 * A finished turn's record under its pill (0.7.26): each model call and why it ended — a reply cut at the output limit
 * marked — what each request carried, and the work it handed to the background. Drawn from `/turns/:id` as the daemon
 * answers it; an older daemon's answer, without the newer parts, draws without those sections.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TurnRecordView } from "../src/commons/components/turns/TurnRecord.tsx";
import type { TurnRecordDetail } from "../src/commons/lib/api.ts";

const record = (extra: Partial<TurnRecordDetail> = {}): TurnRecordDetail => ({
  turn: { id: "t1", agentId: "nouva", status: "done", prompt: "verify the 52 documents", reply: "Done 30." },
  calls: [
    { at: 1_760_000_000_000, agentId: "nouva", model: "claude-sonnet-4-5", inputTokens: 150_000, outputTokens: 8_192, stopReason: "max_tokens" },
    { at: 1_760_000_060_000, agentId: "nouva", model: "claude-sonnet-4-5", inputTokens: 151_000, outputTokens: 40, stopReason: "tool_calls" },
    { at: 1_760_000_090_000, agentId: "nouva", model: "gemini-3.8-flash", inputTokens: 90_000, outputTokens: 2_000, purpose: "compaction" },
  ],
  steps: [],
  ...extra,
});

const drawn = (value: TurnRecordDetail) => renderToString(createElement(TurnRecordView, { record: value }));

describe("a turn's record", () => {
  test("each call says why it ended: the cut one marked, one with no reason saying none", () => {
    const html = drawn(record());
    expect(html).toContain("cut at the output limit");
    expect(html).toContain("asked for tools");
    expect(html).toContain("compaction");
    // Three calls, two reasons: the compaction's provider gave none, and none is drawn.
    expect(html.match(/cut at the output limit|asked for tools|finished|failed/g)).toHaveLength(2);
  });

  test("what each request carried: its size, the results cleared and where they were kept, a summary", () => {
    const html = drawn(
      record({ contexts: [{ request: 3, estimatedTokens: 148_200, cleared: 2, keptAt: ["/data/spill/s1/cleared-call_1-ab12.txt"], summary: true, notes: false }] }),
    );
    expect(html).toContain("148,200");
    expect(html).toContain("2 earlier results cleared");
    expect(html).toContain("kept at /data/spill/s1/cleared-call_1-ab12.txt");
    expect(html).toContain("with a summary of earlier turns");
  });

  test("the work it handed to the background, each a line that opens", () => {
    const html = drawn(
      record({
        delegated: [{ id: "turn_h1", agentId: "nox", status: "running", prompt: "Deploy v2 to staging", startedAt: 1, cause: { via: "ask_agent", job: "job_7" } }],
      }),
    );
    expect(html).toContain("Handed to the background");
    expect(html).toContain("asked nox");
    expect(html).toContain("Deploy v2 to staging");
  });

  test("an older daemon's answer draws without the newer sections", () => {
    const html = drawn(record());
    expect(html).not.toContain("What each request carried");
    expect(html).not.toContain("Handed to the background");
  });
});
