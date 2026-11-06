/**
 * The approval prompt loop, reproduced against the code the CLI runs.
 *
 * From real use: the same request printed over and over, and answering `y` produced another copy.
 */

import { describe, expect, test } from "bun:test";
import { createApprovalPoller, type PendingApproval } from "@/cli/approvals.ts";
import { sleep } from "../wait.ts";

/**
 * A complete request, because that is what the daemon sends.
 *
 * These fixtures were `pending("apr_1")` and type-checked, because `PendingApproval` had been narrowed
 * to the one field the poller compares. The `ask` callback reads four more and printed `undefined`
 * for each in the real CLI — invisible here, since the fake never had them either.
 */
const pending = (id: string): PendingApproval => ({
  id,
  agentId: "nouva",
  chatId: "chat-1",
  gateway: "web",
  tool: "exec",
  params: { command: ["ls"] },
  requestedAt: 1_757_000_000_000,
  status: "pending",
  timeoutMs: 300_000,
});

describe("polling for approvals while a turn is in flight", () => {
  test("asks once, however many times the poll fires", async () => {
    // The daemon keeps returning it — pending until answered, which is the real behaviour and the whole
    // reason the loop happened.
    const prompts: string[] = [];
    const poller = createApprovalPoller({
      fetchPending: async () => [pending("apr_1")],
      ask: async (r) => {
        prompts.push(r.id);
      },
    });

    for (let tick = 0; tick < 5; tick += 1) await poller.poll();

    expect(prompts).toEqual(["apr_1"]);
  });

  test("a pass blocked on the operator does not let the next tick print a second copy", async () => {
    const prompts: string[] = [];
    let release: (() => void) | undefined;
    const poller = createApprovalPoller({
      fetchPending: async () => [pending("apr_1")],
      ask: async (r) => {
        prompts.push(r.id);
        // Standing at the `approve?` prompt, where the real one spends its time.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = poller.poll();
    await Promise.resolve();
    await poller.poll();
    await poller.poll();
    release?.();
    await first;

    expect(prompts).toEqual(["apr_1"]);
  });

  test("a genuinely different request is still asked", async () => {
    const prompts: string[] = [];
    let queue: PendingApproval[] = [pending("apr_1")];
    const poller = createApprovalPoller({
      fetchPending: async () => queue,
      ask: async (r) => {
        prompts.push(r.id);
      },
    });

    await poller.poll();
    queue = [pending("apr_1"), pending("apr_2")];
    await poller.poll();

    // Suppressing duplicates must not suppress the next real question.
    expect(prompts).toEqual(["apr_1", "apr_2"]);
  });

  test("an id stays answered if the pending list shows it again", async () => {
    const prompts: string[] = [];
    let queue: PendingApproval[] = [pending("apr_1")];
    const poller = createApprovalPoller({
      fetchPending: async () => queue,
      ask: async (r) => {
        prompts.push(r.id);
      },
    });

    await poller.poll();
    queue = [];
    await poller.poll();
    queue = [pending("apr_1")];
    await poller.poll();

    expect(prompts).toEqual(["apr_1"]);
  });

  test("a failed fetch does nothing rather than throwing into the interval", async () => {
    const poller = createApprovalPoller({
      fetchPending: async () => null,
      ask: async () => {
        throw new Error("must not be asked");
      },
    });

    await poller.poll();
  });

  test("a throwing ask does not wedge the poller for every later request", async () => {
    const prompts: string[] = [];
    let queue: PendingApproval[] = [pending("apr_bad")];
    const poller = createApprovalPoller({
      fetchPending: async () => queue,
      ask: async (r) => {
        prompts.push(r.id);
        if (r.id === "apr_bad") throw new Error("readline died");
      },
    });

    // Without the `finally`, `inFlight` would stay true and no approval would ever be asked again —
    // silently, for the rest of the session.
    await poller.poll().catch(() => undefined);
    queue = [pending("apr_next")];
    await poller.poll();

    expect(prompts).toEqual(["apr_bad", "apr_next"]);
  });

  test("a request whose ask threw is not asked again", async () => {
    // The id is recorded *before* asking, so a prompt that blew up does not come back on the next tick.
    // Recording it afterwards instead reinstates the flood for exactly the case where the terminal is
    // already broken.
    const prompts: string[] = [];
    const poller = createApprovalPoller({
      fetchPending: async () => [pending("apr_bad")],
      ask: async (r) => {
        prompts.push(r.id);
        throw new Error("readline died");
      },
    });

    await poller.poll().catch(() => undefined);
    await poller.poll().catch(() => undefined);
    await poller.poll().catch(() => undefined);

    expect(prompts).toEqual(["apr_bad"]);
  });

  test("two different requests are never put to the operator at the same time", async () => {
    // One readline, one question at a time. Two concurrent prompts on the same terminal is the state the
    // screenshot showed: interleaved `approve?` lines where one keystroke answers an unclear one.
    let asking = 0;
    let maxConcurrent = 0;
    const releases: (() => void)[] = [];
    const poller = createApprovalPoller({
      fetchPending: async () => [pending("apr_1"), pending("apr_2")],
      ask: async () => {
        asking += 1;
        maxConcurrent = Math.max(maxConcurrent, asking);
        await new Promise<void>((resolve) => releases.push(resolve));
        asking -= 1;
      },
    });

    const first = poller.poll();
    await Promise.resolve();
    // A tick lands while the operator is still on the first question.
    const second = poller.poll();

    // Drained in rounds: the pass asks its requests one after another, so releasing the current question
    // is what creates the next one. Draining once only ever frees the first and hangs on the second.
    for (let round = 0; round < 10; round += 1) {
      while (releases.length > 0) releases.shift()?.();
      await sleep(0);
    }
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
  });
});
