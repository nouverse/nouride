/**
 * What a bare `/approve` means once two agents can ask at the same time.
 *
 * A prompt is posted one at a time — see `tools/approval-floor.ts` — so "several pending" no longer
 * means "several on screen". Refusing to act on the one the person is looking at, and listing two
 * 24-character ids instead, is the friction that made `/approve` on its own worth having.
 *
 * The rule has one hard edge and it is not cosmetic: never guess. Answering something the person
 * never saw is exactly the failure the conversation scope was built to prevent.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "@nouride/shared";
import { answerAllApprovals, answerApproval } from "@/modules/hooks/pending.ts";
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
    grantable: true,
    timeoutMs: 60_000,
    ...over,
  } as ApprovalRequest;
}

function ctx(
  pending: ApprovalRequest[],
  displayed?: string | null,
): { hookCtx: HookContext; resolved: string[]; held: string[] } {
  const resolved: string[] = [];
  const held: string[] = [];
  const hookCtx = {
    agent: { config: { id: "nouva" } },
    gatewayId: "telegram:bot",
    chatId: "chat-1",
    senderId: "gading",
    envelope: { gatewayId: "telegram:bot", chatId: "chat-1", senderId: "gading", chatType: "dm" },
    deps: {
      // Every agent that has something waiting, plus the one being addressed. `pendingHere` walks
      // this list, so an agent missing from it is an agent whose request is invisible.
      registry: {
        enabled: () =>
          [...new Set(["nouva", ...pending.map((r) => r.agentId)])].map((id) => ({ config: { id } })),
      },
      approvals: {
        available: true,
        pending: () => pending,
        pendingForChat: (agentId: string) => pending.filter((r) => r.agentId === agentId),
        ...(displayed === undefined ? {} : { displayedForChat: () => displayed }),
        stopShowing: (ids: readonly string[]) => void held.push(...ids),
        resolve: (id: string) => {
          if (!pending.some((r) => r.id === id)) return false;
          resolved.push(id);
          return true;
        },
      },
    },
  } as unknown as HookContext;
  return { hookCtx, resolved, held };
}

describe("one request waiting", () => {
  test("a bare `/approve` answers it, with or without a gate that tracks the screen", async () => {
    // Unchanged behaviour, and the overwhelmingly common case. Asserted so the new branch cannot
    // quietly take it over.
    for (const displayed of [undefined, null, "apr_1"]) {
      const { hookCtx, resolved } = ctx([request()], displayed);
      const result = await answerApproval(hookCtx, "allow-once");
      expect(result.reply).toContain("Approved");
      expect(resolved).toEqual(["apr_1"]);
    }
  });
});

describe("two requests waiting, one on screen", () => {
  const two = () => [
    request({ id: "apr_1", agentId: "nouva", tool: "exec" }),
    request({ id: "apr_2", agentId: "nexa", tool: "write" }),
  ];

  test("a bare `/approve` answers the one the person is looking at", async () => {
    // Nexa's question has not been posted yet. The only prompt in the chat is Nouva's, so that is
    // the thing the word "approve" points at.
    const { hookCtx, resolved } = ctx(two(), "apr_1");
    const result = await answerApproval(hookCtx, "allow-once");

    expect(resolved).toEqual(["apr_1"]);
    expect(result.reply).toContain("apr_1");
  });

  test("`/deny` follows the same target", async () => {
    const { hookCtx, resolved } = ctx(two(), "apr_2");
    const result = await answerApproval(hookCtx, "deny");

    expect(resolved).toEqual(["apr_2"]);
    expect(result.reply).toContain("Denied");
  });

  test("an explicit id still wins over what is on screen", async () => {
    const { hookCtx, resolved } = ctx(two(), "apr_1");
    await answerApproval(hookCtx, "allow-once", "apr_2");
    expect(resolved).toEqual(["apr_2"]);
  });
});

describe("when it cannot be sure, it asks", () => {
  test("a gate that does not track the screen still asks for an id", async () => {
    // A gate without the floor — an older build, or a surface that posts everything at once. Guessing
    // there would approve something the person never read.
    const { hookCtx, resolved } = ctx(
      [request({ id: "apr_1" }), request({ id: "apr_2", agentId: "nexa" })],
      undefined,
    );
    const result = await answerApproval(hookCtx, "allow-once");

    expect(resolved).toEqual([]);
    expect(result.reply).toContain("2 requests are waiting");
  });

  test("a displayed request that is no longer pending is not answered by guesswork", async () => {
    // The race: the operator answered it from the CLI a moment ago, so the floor still names an id
    // that has settled. Falling back to "the other one" would answer a question nobody asked about.
    const { hookCtx, resolved } = ctx(
      [request({ id: "apr_1" }), request({ id: "apr_2", agentId: "nexa" })],
      "apr_gone",
    );
    const result = await answerApproval(hookCtx, "allow-once");

    expect(resolved).toEqual([]);
    expect(result.reply).toContain("Name one");
  });

  test("the list names the agent, because two agents can be waiting on the same tool", async () => {
    const { hookCtx } = ctx(
      [
        request({ id: "apr_1", agentId: "nix", tool: "exec" }),
        request({ id: "apr_2", agentId: "nexa", tool: "exec" }),
      ],
      undefined,
    );
    const result = await answerApproval(hookCtx, "allow-once");

    expect(result.reply).toContain("nix: exec");
    expect(result.reply).toContain("nexa: exec");
  });
});

describe("`/approve all`", () => {
  test("takes the queue off screen before it answers any of it", async () => {
    // Each answer hands the floor to the next question in this conversation, and the prompt for it is
    // posted asynchronously while the answer lands synchronously — so without this the operator gets a
    // question in the chat a moment after they already approved it.
    const { hookCtx, resolved, held } = ctx(
      [
        request({ id: "apr_1", agentId: "nouva" }),
        request({ id: "apr_2", agentId: "nexa" }),
        request({ id: "apr_3", agentId: "nix" }),
      ],
      "apr_1",
    );

    const result = await answerAllApprovals(hookCtx, "allow-once");

    expect(held).toEqual(["apr_1", "apr_2", "apr_3"]);
    expect(resolved).toEqual(["apr_1", "apr_2", "apr_3"]);
    expect(result.reply).toContain("Approved 3");
  });
});
