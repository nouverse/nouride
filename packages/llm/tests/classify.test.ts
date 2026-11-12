/**
 * Provider failure classification, and the behaviour it drives.
 *
 * `retryable` used to be `status === 429 || status >= 500` and nothing else, so every other failure
 * looked the same. Measured live in this repo: a model id missing its provider prefix came back as
 * `model_prefix_required` — a permanent configuration error — and the chat said "The model is not
 * responding right now." The model was answering perfectly, and we retried three times first.
 *
 * A classification that does not change behaviour is decoration, so the last block asserts that the
 * retry loop actually reads it.
 */

import { describe, expect, test } from "bun:test";
import { classifyFailure, type FailureClass } from "../src/classify.ts";
import type { LLMError, LLMFailure } from "@nouride/shared";
import { postJson, reportedFailure } from "../src/http.ts";

const CASES: [string, { status?: number; message?: string }, FailureClass][] = [
  // The one that was actually observed.
  ["model prefix required", { status: 400, message: 'Model must include provider prefix. Got: "x"' }, "model_not_found"],
  ["unknown model", { status: 404, message: "The model `gpt-9` does not exist" }, "model_not_found"],
  ["no provider serves it, as a 400", { status: 400, message: '{"type":"error","error":{"type":"invalid_request_error","message":"No provider serves \\"e2e-x\\". Call /v1/models for the list."}}' }, "model_not_found"],
  ["bad key", { status: 401, message: "Incorrect API key provided" }, "auth"],
  ["unauthorized, no body", { status: 403 }, "auth"],
  ["no credit", { status: 400, message: "Your credit balance is too low" }, "billing"],
  ["insufficient quota", { status: 429, message: "You exceeded your current quota, insufficient_quota" }, "billing"],
  ["rate limited", { status: 429, message: "Rate limit reached for requests" }, "rate_limit"],
  ["overloaded", { status: 529, message: "Overloaded" }, "overloaded"],
  ["context overflow", { status: 400, message: "This model's maximum context length is 8192 tokens" }, "context_overflow"],
  ["prompt too long", { status: 400, message: "prompt is too long: 210000 tokens" }, "context_overflow"],
  ["payload too large", { status: 413, message: "Payload Too Large" }, "payload_too_large"],
  ["content policy", { status: 400, message: "Your request was rejected by our content_policy" }, "content_policy"],
  ["malformed", { status: 400, message: "Invalid request: missing required field 'messages'" }, "request_invalid"],
  ["plain 500", { status: 500 }, "transient"],
  ["nothing at all", {}, "unknown"],
];

describe("classifyFailure", () => {
  test.each(CASES)("%s → %s", (_label, input, expected) => {
    expect(classifyFailure(input).class).toBe(expected);
  });

  test("a spending cap is billing, not auth, even though it arrives as 403", () => {
    // Telling the operator to check their API key when the balance is empty sends them to the wrong
    // file. This is why the body is consulted before the status.
    expect(classifyFailure({ status: 403, message: "spending limit reached" }).class).toBe("billing");
  });

  test("a config error and a malformed request are both 400 and classify differently", () => {
    // The whole reason body-before-status exists: one is fixable in config.toml, the other is a bug
    // in our own wire mapping, and conflating them wastes the operator's time on the wrong thing.
    expect(classifyFailure({ status: 400, message: "unknown model" }).class).toBe("model_not_found");
    expect(classifyFailure({ status: 400, message: "validation failed" }).class).toBe("request_invalid");
  });
});

describe("the action each class carries", () => {
  test.each([
    ["rate_limit", { status: 429 }, "retry"],
    ["overloaded", { status: 503 }, "retry"],
    ["transient", { status: 500 }, "retry"],
    ["context_overflow", { status: 400, message: "maximum context length" }, "shrink"],
    ["auth", { status: 401 }, "stop"],
    ["billing", { status: 402 }, "stop"],
    ["model_not_found", { status: 404 }, "stop"],
    ["content_policy", { status: 400, message: "content_policy" }, "stop"],
  ] as const)("%s → %s", (_label, input, action) => {
    expect(classifyFailure(input).action).toBe(action);
  });

  test("only the classes an operator can fix raise an alert", () => {
    // A rate limit is not their problem. An expired key is, and finding out hours later from someone
    // saying "the bot is broken" is what alerting exists to prevent.
    expect(classifyFailure({ status: 401 }).alertOperator).toBe(true);
    expect(classifyFailure({ status: 402 }).alertOperator).toBe(true);
    expect(classifyFailure({ status: 404 }).alertOperator).toBe(true);
    expect(classifyFailure({ status: 429 }).alertOperator).toBe(false);
    expect(classifyFailure({ status: 503 }).alertOperator).toBe(false);
  });

  test("the operator hint names what to change", () => {
    expect(classifyFailure({ status: 404 }).operatorHint).toMatch(/provider prefix/);
    expect(classifyFailure({ status: 401 }).operatorHint).toMatch(/api_key/);
  });

  test("no user message leaks a status code or a provider body", () => {
    for (const [, input] of CASES) {
      const { userMessage } = classifyFailure(input);
      expect(userMessage).not.toMatch(/\b[45]\d\d\b/);
      expect(userMessage).not.toMatch(/insufficient_quota|api key provided|content_policy/);
    }
  });

  test("only a plain retry is retried as it was", () => {
    expect(classifyFailure({ status: 429 }).action).toBe("retry");
    // `shrink` retries a *different* request, so the plain backoff loop must not treat it as retryable
    // — resending the same oversized payload would fail identically.
    expect(classifyFailure({ status: 400, message: "context length" }).action).not.toBe("retry");
    expect(classifyFailure({ status: 401 }).action).not.toBe("retry");
  });
});

describe("the retry loop reads the classification", () => {
  function countingFetch(status: number, body: unknown) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  test("a permanent failure is attempted once, not three times", async () => {
    // The waste this removes: three attempts against a 400 that can never succeed, with a backoff
    // delay in front of the user for each one.
    const { fetchImpl, calls } = countingFetch(401, { error: { message: "invalid_api_key" } });
    await expect(
      postJson("https://x/y", {}, {}, undefined, { fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow();
    expect(calls()).toBe(1);
  });

  test("a rate limit is retried", async () => {
    const { fetchImpl, calls } = countingFetch(429, { error: { message: "rate limit" } });
    await expect(
      postJson("https://x/y", {}, {}, undefined, { fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow();
    expect(calls()).toBeGreaterThan(1);
  });

  test("a 400 that is really a rate limit is still retried", async () => {
    // Status alone would refuse this. The provider's wording is the more reliable signal.
    const { fetchImpl, calls } = countingFetch(400, { error: { message: "Too many requests" } });
    await expect(
      postJson("https://x/y", {}, {}, undefined, { fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow();
    expect(calls()).toBeGreaterThan(1);
  });

  test("the thrown error carries the class for the caller to act on", async () => {
    const { fetchImpl } = countingFetch(400, { error: { message: "maximum context length is 8192" } });
    try {
      await postJson("https://x/y", {}, {}, undefined, { fetchImpl, sleep: async () => {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { failure?: { class: string; action: string } }).failure).toMatchObject({
        class: "context_overflow",
        action: "shrink",
      });
    }
  });
});

describe("the provider's own sentence about a failure", () => {
  const failed = async (status: number, body: string): Promise<LLMFailure | undefined> => {
    const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch;
    try {
      await postJson("https://x/y", {}, {}, undefined, { fetchImpl, sleep: async () => {} });
    } catch (err) {
      return (err as LLMError).failure;
    }
    throw new Error("should have thrown");
  };
  // What a gateway with no account for a model answers, in each of the two shapes it speaks.
  const NO_ACCOUNT = '"gpt-9" is served by kiro, but none of them has an account configured on this gateway. Add one on the provider page.';

  test("a gateway with no account for a model: a credential to add, with the sentence that says which", async () => {
    const openai = await failed(401, JSON.stringify({ error: { message: NO_ACCOUNT, type: "authentication_error", code: "no_account" } }));
    expect(openai).toMatchObject({ class: "auth", action: "stop", alertOperator: true, said: NO_ACCOUNT });
    const anthropic = await failed(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: NO_ACCOUNT } }));
    expect(anthropic).toMatchObject({ class: "auth", action: "stop", alertOperator: true, said: NO_ACCOUNT });
  });

  test("a message at the top of the body, or an error that is one string, is read too", async () => {
    expect((await failed(404, JSON.stringify({ message: "no such model here" })))?.said).toBe("no such model here");
    expect((await failed(404, JSON.stringify({ error: "no such model here" })))?.said).toBe("no such model here");
  });

  test("a body that is not that shape gives no sentence: a proxy's page is not one", async () => {
    expect((await failed(502, "<html><body><h1>502 Bad Gateway</h1></body></html>"))?.said).toBeUndefined();
    expect((await failed(401, JSON.stringify({ error: { code: 401 } })))?.said).toBeUndefined();
    expect((await failed(401, JSON.stringify(["unauthorized"])))?.said).toBeUndefined();
    expect((await failed(401, "null"))?.said).toBeUndefined();
  });

  test("it is one line, no longer than an alert carries, with what is named like a credential taken out", async () => {
    const long = await failed(401, JSON.stringify({ error: { message: `unauthorized:\n  ${"x".repeat(400)}` } }));
    expect(long?.said).toHaveLength(240);
    expect(long?.said).toStartWith("unauthorized: xxx");
    expect(long?.said).toEndWith("…");
    const keyed = await failed(401, JSON.stringify({ error: { message: "unauthorized: Authorization: Bearer abcdefgh12345678 was refused, api_key=mangga-manis-0001" } }));
    expect(keyed?.said).toContain("Bearer [redacted]");
    expect(keyed?.said).toContain("api_key=[redacted]");
    expect(keyed?.said).not.toContain("abcdefgh12345678");
    expect(keyed?.said).not.toContain("mangga-manis-0001");
  });

  test("a failure named inside an answer that began as a success carries its sentence, and a made-up one does not", () => {
    expect(reportedFailure({ message: NO_ACCOUNT, type: "authentication_error" }, "the provider ended the answer with an error").failure?.said).toBe(NO_ACCOUNT);
    expect(reportedFailure({}, "the provider ended the answer with an error").failure?.said).toBeUndefined();
  });
});
