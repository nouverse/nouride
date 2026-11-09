/**
 * The approval gate a turn working in the background asks through (`sayingWho`): its questions say whose work they are
 * for, once there is an answer to that, and everything else is the gate it wraps — what a question showed above all,
 * which a tool whose write depends on it (`persona`) reads back once the answer is yes.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalPreview } from "@nouride/shared";
import type { ApprovalAsk, ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { helperAsking, sayingWho } from "@/modules/pipeline/background-turn.ts";

function recording() {
  const asked: ApprovalAsk[] = [];
  const preview = { kind: "edit", against: "abc" } as unknown as ApprovalPreview;
  const gate: ApprovalGate = {
    available: true,
    canAsk: () => true,
    pending: () => [],
    previewOf: (id) => (id === "apr_1" ? preview : null),
    expireAll: () => 3,
    request: async (ask): Promise<ApprovalOutcome> => (asked.push(ask), { status: "approved", by: "user-1", decision: "allow-once", id: "apr_1" }),
  };
  return { gate, asked, preview };
}

const ask = { agentId: "nouva", tool: "probe", reason: "probe requires approval for this agent" } as ApprovalAsk;

describe("a gate that says who asks", () => {
  test("names the work once there is a name, and says nothing before", async () => {
    const { gate, asked } = recording();
    let who: string | null = null;
    const wrapped = sayingWho(gate, () => who);
    await wrapped.request(ask);
    who = helperAsking("job_1", 'Check the "docs" build');
    await wrapped.request(ask);
    expect(asked.map((one) => one.reason)).toEqual([
      "probe requires approval for this agent",
      `a background task (job_1: "Check the 'docs' build") wants to run this: probe requires approval for this agent`,
    ]);
  });

  test("is the gate it wraps in everything else, what a question showed included", () => {
    const { gate, preview } = recording();
    const wrapped = sayingWho(gate, () => null);
    expect(wrapped.previewOf?.("apr_1")).toBe(preview);
    expect(wrapped.previewOf?.("apr_2")).toBeNull();
    expect(wrapped.available).toBe(true);
    expect(wrapped.canAsk?.()).toBe(true);
    expect(wrapped.expireAll("nouva")).toBe(3);
  });
});
