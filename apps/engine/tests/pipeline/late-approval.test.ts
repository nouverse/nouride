/**
 * An approval answered after its turn stopped waiting puts the agent back on the job: the answer goes into the
 * conversation the request came from, as the daemon's own message, through that chat's queue
 * (`Pipeline.resumeAfterApproval`, `wake-ups.ts`). The approval gate's `onLateAnswer` is its one caller, so nothing but
 * this test sees whether the answer still reaches the agent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalRequest, GatewayName } from "@nouride/shared";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

async function daemon() {
  bench = await pipelineBench({ turns: [{ text: "Ran it." }] });
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  return bench;
}

/** A request asked ten minutes ago; `gateway` holds the connection it was asked on, as the gate keeps it. */
function asked(gatewayId: string): ApprovalRequest {
  return {
    id: "apr_late",
    agentId: "nouva",
    chatId: "5550001111",
    gateway: gatewayId as GatewayName,
    tool: "exec",
    params: { command: "systemctl restart caddy" },
    status: "pending",
    requestedAt: Date.now() - 600_000,
    timeoutMs: 300_000,
  };
}

describe("a late answer to an approval", () => {
  test("wakes the agent that asked, in the chat it asked in, saying who answered and what", async () => {
    const h = await daemon();
    expect(h.pipeline.resumeAfterApproval(asked(h.gateway.id), "allow-once", "Gading")).toBe(true);
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    const sent = JSON.stringify(h.requests[0]);
    expect(sent).toContain("Gading has just approved the `exec` call you asked about");
    expect(sent).toContain("Carry on from there if it is still worth doing");
    expect(h.gateway.sent.map((message) => [message.chatId, message.text])).toContainEqual(["5550001111", "Ran it."]);
  });

  test("a refusal wakes it too, told not to look for another way", async () => {
    const h = await daemon();
    expect(h.pipeline.resumeAfterApproval(asked(h.gateway.id), "deny", "Gading")).toBe(true);
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.requests[0])).toContain("They said no. Do not run it");
  });

  test("a connection gone since has nothing to hand it back through: false, and no turn", async () => {
    const h = await daemon();
    expect(h.pipeline.resumeAfterApproval(asked("telegram:gone"), "allow-once", "Gading")).toBe(false);
    await h.pipeline.idle();

    expect(h.requests).toHaveLength(0);
  });
});
