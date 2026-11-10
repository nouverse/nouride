/**
 * `max_tokens_field` from config to the wire: the profile key is read, the registry hands it to the client, and what
 * runs beside a turn on the same profile — compaction here — goes through that client and carries it too.
 *
 * OpenAI's own API refused every reply and every compaction of a GPT-5-family model with `max_tokens` in the request.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { SecretStore } from "@nouride/secrets";
import type { ChatMessage } from "@nouride/shared";
import { parseConfig } from "@/modules/config/global/index.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { compactHistory, resetCompactionBreaker } from "@/modules/llm/summarize.ts";
import { tempDir } from "../helpers.ts";

const profile = (extra: Record<string, unknown>) => ({
  providers: { openai: { kind: "openai", base_url: "https://api.openai.com/v1", api_key: "openai_api_key", ...extra } },
});

/** A registry over `profile`, and every request body it sent. */
async function registry(extra: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: "Headline: the build\n## Done\n- fixed it" }, finish_reason: "stop" }] });
  }) as unknown as typeof fetch;
  const config = parseConfig(profile(extra));
  const providers = new ProviderRegistry(config.providers, await SecretStore.open(tempDir("secrets"), { OPENAI_API_KEY: "k" }), { fetchImpl });
  return { providers, bodies };
}

/** About a thousand tokens a turn, so thirty of them are well past a 10k limit. */
function history(turns: number): ChatMessage[] {
  return Array.from({ length: turns }, (_, i) => [
    { role: "user" as const, content: `question ${i} ${"x".repeat(2_000)}`, timestamp: i * 1000 },
    { role: "assistant" as const, content: `answer ${i} ${"y".repeat(2_000)}`, timestamp: i * 1000 + 1 },
  ]).flat();
}

beforeEach(() => resetCompactionBreaker());

describe("[providers.<name>] max_tokens_field", () => {
  test("read; absent and max_tokens are the default; anything else refused by its path, and on the Anthropic wire", () => {
    expect(parseConfig(profile({ max_tokens_field: "max_completion_tokens" })).providers.openai?.maxTokensField).toBe("max_completion_tokens");
    expect(parseConfig(profile({})).providers.openai?.maxTokensField).toBeUndefined();
    expect(parseConfig(profile({ max_tokens_field: "max_tokens" })).providers.openai?.maxTokensField).toBeUndefined();
    expect(() => parseConfig(profile({ max_tokens_field: "max_output_tokens" }))).toThrow(
      '[providers.openai] max_tokens_field must be "max_tokens" or "max_completion_tokens", got "max_output_tokens"',
    );
    expect(() => parseConfig(profile({ max_tokens_field: 1 }))).toThrow("[providers.openai] max_tokens_field");
    expect(() => parseConfig(profile({ kind: "anthropic", max_tokens_field: "max_completion_tokens" }))).toThrow(
      '[providers.openai] max_tokens_field = "max_completion_tokens" is for kind = "openai"',
    );
  });

  test("handed to the client the registry builds: a reply's limit goes in max_completion_tokens", async () => {
    const { providers, bodies } = await registry({ max_tokens_field: "max_completion_tokens" });
    await providers.get("openai").chat({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], maxTokens: 32_000 });
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 32_000 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });

  test("and compaction, through the same client, carries it too", async () => {
    const { providers, bodies } = await registry({ max_tokens_field: "max_completion_tokens" });
    const result = await compactHistory(history(30), { provider: providers.get("openai"), model: "gpt-5-mini", maxTokens: 10_000, limit: 10_000, key: "c" });
    expect(result.compacted).toBe(true);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.max_completion_tokens).toBeNumber();
      expect(body).not.toHaveProperty("max_tokens");
    }
  });

  test("a profile that says nothing sends max_tokens, compaction included", async () => {
    const { providers, bodies } = await registry({});
    await compactHistory(history(30), { provider: providers.get("openai"), model: "gpt-4.1-mini", maxTokens: 10_000, limit: 10_000, key: "c" });
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.max_tokens).toBeNumber();
      expect(body).not.toHaveProperty("max_completion_tokens");
    }
  });
});
