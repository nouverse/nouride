/**
 * `/approvals balanced` drains every pending request that auto-approval covers.
 *
 * The operator typed "stop asking me" — leaving grantable requests waiting until a separate
 * `/approve all` is the friction the feature exists to remove. Hardline requests still need
 * an explicit answer.
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
 * A context with a resolve function that tracks which ids were approved.
 */
function ctx(
  pending: ApprovalRequest[],
  options: { available?: boolean; byAgent?: Record<string, ApprovalRequest[]> } = {},
): { hookCtx: HookContext; resolved: string[]; held: string[] } {
  const { available = true, byAgent } = options;
  const agents = Object.keys(byAgent ?? { nouva: [] });
  const resolved: string[] = [];
  const held: string[] = [];
  const hookCtx = {
    agent: { config: { id: "nouva" } },
    gatewayId: "telegram:bot",
    chatId: "chat-1",
    senderId: "gading",
    envelope: { gatewayId: "telegram:bot", chatId: "chat-1", senderId: "gading", chatType: "dm" },
    deps: {
      registry: { enabled: () => agents.map((id) => ({ config: { id } })) },
      approvals: {
        available,
        pending: (agentId: string) => byAgent?.[agentId] ?? pending,
        pendingForChat: (agentId: string) => byAgent?.[agentId] ?? pending,
        stopShowing: (ids: readonly string[]) => void held.push(...ids),
        resolve: (id: string, _decision: string, _by: string) => {
          resolved.push(id);
          return true;
        },
      },
    },
  } as unknown as HookContext;
  return { hookCtx, resolved, held };
}

describe("nothing pending", () => {
  test("drains zero and returns no notice", () => {
    const { hookCtx } = ctx([]);
    const result = drainCoveredPending(hookCtx);
    expect(result.drained).toBe(0);
    expect(result.notice).toEqual([]);
  });

  test("no gate returns zero", () => {
    const { hookCtx } = ctx([request()], { available: false });
    const result = drainCoveredPending(hookCtx);
    expect(result.drained).toBe(0);
    expect(result.notice).toEqual([]);
  });
});

describe("only grantable requests pending", () => {
  test("drains all of them", () => {
    const { hookCtx, resolved } = ctx([
      request({ id: "a", grantable: true, autoCoverable: true }),
      request({ id: "b", grantable: true, autoCoverable: true }),
    ]);
    const result = drainCoveredPending(hookCtx);
    expect(result.drained).toBe(2);
    expect(resolved).toEqual(["a", "b"]);
    // No hardline notice
    expect(result.notice).toEqual([]);
  });

  test("requests without grantable field are treated as coverable", () => {
    // grantable is undefined by default — not hardline
    const { hookCtx, resolved } = ctx([request({ id: "c" })]);
    const result = drainCoveredPending(hookCtx);
    expect(result.drained).toBe(1);
    expect(resolved).toEqual(["c"]);
  });
});

describe("only hardline requests pending", () => {
  test("drains none and reports all", () => {
    const { hookCtx, resolved } = ctx([
      request({ id: "a", grantable: false, autoCoverable: false, tool: "exec", reason: "privilege escalation" }),
    ]);
    const result = drainCoveredPending(hookCtx);
    expect(result.drained).toBe(0);
    expect(resolved).toEqual([]);
    const text = result.notice.join("\n");
    expect(text).toContain("does **not** cover");
    expect(text).toContain("`exec`");
    expect(text).toContain("privilege escalation");
    expect(text).toContain("/approve");
  });
});

describe("mixed queue", () => {
  test("drains coverable and reports hardline", () => {
    const { hookCtx, resolved } = ctx([
      request({ id: "hard", grantable: false, autoCoverable: false, tool: "exec", reason: "credentials" }),
      request({ id: "soft", grantable: true, autoCoverable: true, tool: "write" }),
    ]);
    const result = drainCoveredPending(hookCtx);
    expect(result.drained).toBe(1);
    expect(resolved).toEqual(["soft"]);

    const text = result.notice.join("\n");
    expect(text).toContain("1 request is still waiting");
    expect(text).toContain("`exec`");
    // The coverable one should NOT appear in the notice — it was already approved
    expect(text).not.toContain("`write`");
  });
});

describe("cross-agent requests", () => {
  test("drains coverable from another agent", () => {
    const nexaRequest = request({ id: "nexa_soft", agentId: "nexa", grantable: true, autoCoverable: true, tool: "read" });
    const { hookCtx, resolved } = ctx([], { byAgent: { nouva: [], nexa: [nexaRequest] } });
    const result = drainCoveredPending(hookCtx);
    expect(result.drained).toBe(1);
    expect(resolved).toEqual(["nexa_soft"]);
  });
});

/**
 * What the drain takes off screen, and what it deliberately leaves there.
 *
 * `/approvals balanced` answers everything auto-approval covers and leaves the hardline ones. The covered ones
 * must not be asked about — the operator has just answered them — and the hardline ones must, because
 * nothing else is going to. See `tools/approval-floor.ts`.
 */
describe("the queue behind the prompt", () => {
  test("covered requests are taken off screen, hardline ones are not", () => {
    const { hookCtx, held, resolved } = ctx([
      request({ id: "apr_1", autoCoverable: true }),
      request({ id: "apr_2", autoCoverable: false }),
      request({ id: "apr_3", autoCoverable: true }),
    ]);

    drainCoveredPending(hookCtx);

    expect(held).toEqual(["apr_1", "apr_3"]);
    expect(resolved).toEqual(["apr_1", "apr_3"]);
  });
});
