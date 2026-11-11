/**
 * A request that ran out of this page's patience is not a daemon that stopped answering.
 *
 * "Review now" on Skills asks a model several times and answered after minutes. The call had the client's default
 * fifteen seconds, the client told the restart follower the daemon was unreachable, and the strip said "it is probably
 * restarting" over a daemon that was working and answering everything else. So the client says which it was, and a
 * call to a route that works for minutes gives itself minutes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, request, whenUnreachable, type Unreachable } from "@/commons/lib/api.client";
import { skillsApi } from "@/commons/lib/api.skills";

const realFetch = globalThis.fetch;
const told: Unreachable[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  told.length = 0;
  whenUnreachable(() => {});
});

/** A daemon that never answers: the request ends when its own signal does. */
const never = () =>
  ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;

describe("what the client says of a request that got no answer", () => {
  test("its own clock running out is slow, and the error says how long it waited", async () => {
    whenUnreachable((how) => told.push(how));
    globalThis.fetch = never();
    const error = await request("/api/control/skills/review", { method: "POST", timeoutMs: 20 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Nouride did not answer within 0.02 seconds");
    expect(told).toEqual(["slow"]);
  });

  test("nothing coming back, or a proxy answering for it, is silence", async () => {
    whenUnreachable((how) => told.push(how));
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await request("/api/control/agents").catch(() => {});
    globalThis.fetch = (async () => new Response("", { status: 504 })) as unknown as typeof fetch;
    await request("/api/control/agents").catch(() => {});
    expect(told).toEqual(["silent", "silent"]);
  });

  test("a look at health tells nobody: its silence is how a restart is followed", async () => {
    whenUnreachable((how) => told.push(how));
    globalThis.fetch = never();
    await request("/api/health", { timeoutMs: 20 }).catch(() => {});
    expect(told).toEqual([]);
  });
});

describe("the weekly review, asked for now", () => {
  test("waits minutes for its answer, not the client's seconds", async () => {
    let waited = 0;
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => {
      waited = ms;
      return realTimeout.call(AbortSignal, ms);
    };
    try {
      globalThis.fetch = (async () => Response.json({ tighten: [], merge: [], archive: [], declined: [] })) as unknown as typeof fetch;
      await skillsApi.reviewSkills();
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    expect(waited).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
