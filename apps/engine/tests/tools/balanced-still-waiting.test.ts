/**
 * What `/approvals balanced` says about the requests it cannot answer.
 *
 * The failure, seen live on a phone: three credential-touching commands in a row, each asking. On the
 * third the operator switched the level rather than answering — a fair reading of "stops the asking
 * in this chat". Auto-approval never covers a hardline class, so that request kept waiting; the turn
 * sat parked for four minutes and then gave up. The reply had just said "I will not ask before running
 * tools" while the thing it was asking about was still on screen.
 *
 * Nothing was broken. Nothing said anything either, which was the whole problem. The drain itself — what
 * it answers, and what it takes off screen — is `auto-drain-pending.test.ts`; this is the notice.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@nouride/shared";
import { drainCoveredPending } from "@/modules/hooks/registry.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "apr_1",
    agentId: "nouva",
    chatId: "chat-1",
    gateway: "telegram",
    tool: "exec",
    params: {},
    status: "pending",
    requestedAt: 0,
    timeoutMs: 60_000,
    ...over,
  } as ApprovalRequest;
}

/**
 * Only what the drain reads. Building a whole pipeline to render four lines is not a test.
 *
 * The registry is in here because the notice asks who else is in this conversation: an agent answers
 * through another agent's bot when its own is not in the room, so a request raised by one can only be
 * found by looking past the one that was addressed.
 */
function ctx(byAgent: Record<string, ApprovalRequest[]>): HookContext {
  const agents = Object.keys(byAgent);
  return {
    agent: { config: { id: "nouva" } },
    gatewayId: "telegram:bot",
    chatId: "chat-1",
    senderId: "gading",
    envelope: { gatewayId: "telegram:bot", chatId: "chat-1", senderId: "gading", chatType: "dm" },
    deps: {
      registry: { enabled: () => agents.map((id) => ({ config: { id } })) },
      approvals: {
        available: true,
        pending: (agentId: string) => byAgent[agentId] ?? [],
        pendingForChat: (agentId: string) => byAgent[agentId] ?? [],
        stopShowing: () => undefined,
        resolve: () => true,
      },
    },
  } as unknown as HookContext;
}

const notice = (byAgent: Record<string, ApprovalRequest[]>): string => drainCoveredPending(ctx(byAgent)).notice.join("\n");

describe("a request auto-approval will never cover", () => {
  const text = () =>
    notice({
      nouva: [
        request({
          grantable: false,
          autoCoverable: false,
          tool: "exec",
          reason: "touches credentials (/srv/nouride/.nouride/agents/shared/.credentials)",
        }),
      ],
    });

  test("is named, with the reason", () => {
    // Without this the operator waits four minutes for a turn that is waiting for them.
    expect(text()).toContain("does **not** cover");
    expect(text()).toContain("exec");
    expect(text()).toContain("touches credentials");
  });

  test("says what to type", () => {
    expect(text()).toContain("/approve");
  });

  test("says why waiting will not help", () => {
    // The sentence that closes the loop: it is not slow, it will never happen on its own.
    expect(text()).toContain("never covers these");
  });
});

describe("a request raised by another agent in the same chat", () => {
  test("is still found", () => {
    // The dead end this closes: Nexa asked, its own bot was not in the thread so the prompt went out
    // under Nouva's name, and `@Nouva /approve` reported nothing waiting while Nexa — with no bot
    // present — could not be addressed at all.
    const nexaRequest = request({ id: "apr_nexa", agentId: "nexa", tool: "nouva-mcp__memory_query", grantable: false, autoCoverable: false });
    expect(notice({ nouva: [], nexa: [nexaRequest] })).toContain("nouva-mcp__memory_query");
  });

  test("the addressed agent's own request is listed first", () => {
    // So a bare `/approve` with one request of its own keeps resolving that one, exactly as before.
    const mine = request({ id: "apr_mine", agentId: "nouva", tool: "exec", grantable: false, autoCoverable: false });
    const theirs = request({ id: "apr_theirs", agentId: "nexa", tool: "read", grantable: false, autoCoverable: false });
    const lines = notice({ nouva: [mine], nexa: [theirs] });
    expect(lines.indexOf("`exec`")).toBeLessThan(lines.indexOf("`read`"));
  });

  test("the same request seen through two agents is not counted twice", () => {
    const shared = request({ id: "apr_shared", tool: "exec", grantable: false, autoCoverable: false });
    expect(notice({ nouva: [shared], nexa: [shared] })).toContain("1 request is still waiting");
  });
});
