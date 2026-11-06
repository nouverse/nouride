/**
 * What `/approve` says when the thing it was answering is already gone.
 *
 * From a live Telegram session. The operator answered the prompt within thirty seconds; the message
 * spent three and a half minutes stuck in a stalled long-poll, and by the time it arrived the request
 * had expired with the turn that asked for it. The reply was "Nothing is waiting for approval." —
 * true, and indistinguishable from a broken gate. Both facts that would have explained it were
 * sitting in the database: that there *had* been a request here, and that it died rather than being
 * answered by somebody else.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@nouride/shared";
import { noPendingReply, type HookContext } from "@/modules/hooks/registry.ts";

function settled(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "apr_1",
    agentId: "nouva",
    chatId: "chat-1",
    gateway: "telegram",
    tool: "exec",
    params: {},
    status: "expired",
    requestedAt: Date.now() - 200_000,
    resolvedAt: Date.now() - 120_000,
    grantable: false,
    timeoutMs: 300_000,
    ...over,
  } as ApprovalRequest;
}

function ctx(history: ApprovalRequest[] | undefined): HookContext {
  return {
    agent: { config: { id: "nouva" } },
    gatewayId: "telegram:bot",
    chatId: "chat-1",
    senderId: "gading",
    deps: {
      registry: { enabled: () => [{ config: { id: "nouva" } }] },
      approvals: {
        available: true,
        pending: () => [],
        pendingForChat: () => [],
        resolve: () => false,
        ...(history ? { recentlySettledForChat: () => history } : {}),
      },
    },
  } as unknown as HookContext;
}

describe("an answer that arrives too late", () => {
  test("names the request that expired, and how long ago", () => {
    const reply = noPendingReply(ctx([settled()]));
    expect(reply).toContain("expired");
    expect(reply).toContain("exec");
    expect(reply).toContain("2m");
    // The operator's next move, which the old reply left them to guess at.
    expect(reply).toContain("again");
  });

  test("distinguishes a request somebody else already answered from one that died", () => {
    const reply = noPendingReply(
      ctx([settled({ status: "approved", resolvedBy: "gading", tool: "write" })]),
    );
    expect(reply).toContain("approved");
    expect(reply).toContain("gading");
    expect(reply).not.toContain("expired");
  });

  test("reports the most recent one when several settled here", () => {
    // `recentlySettledForChat` returns newest first, and the reply is about the request the operator
    // was most plausibly answering.
    const reply = noPendingReply(
      ctx([settled({ id: "apr_new", tool: "exec" }), settled({ id: "apr_old", tool: "write" })]),
    );
    expect(reply).toContain("exec");
    expect(reply).not.toContain("write");
  });

  test("falls back to the short reply when there is genuinely no history", () => {
    // An idle chat where somebody typed `/approve` for no reason. Inventing an explanation here would
    // be worse than the bare sentence.
    expect(noPendingReply(ctx([]))).toBe("Nothing is waiting for approval.");
  });

  test("falls back to the short reply on a gate that keeps no history", () => {
    // `recentlySettledForChat` is optional — the CLI's auto-approving and unavailable gates do not
    // have it, and they must not crash `/approve`.
    expect(noPendingReply(ctx(undefined))).toBe("Nothing is waiting for approval.");
  });
});
