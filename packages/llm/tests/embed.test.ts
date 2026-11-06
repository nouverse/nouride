/**
 * `embed()` — OpenAI's `/embeddings`, which is also what Gemini, Mistral, Jina and Ollama answer.
 */

import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../src/openai.ts";
import { fakeFetch } from "./helpers.ts";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function provider(fetchImpl: typeof fetch) {
  return new OpenAIProvider({ baseUrl: "https://api.example.com/v1/", apiKey: "sk-test", http: { fetchImpl, maxAttempts: 1 } });
}

describe("embed", () => {
  test("the wire request: model, inputs, floats, and dimensions when asked", async () => {
    const fake = fakeFetch(json({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } }));
    const result = await provider(fake.fn).embed({ model: "text-embedding-3-small", input: ["halo"], dimensions: 512 });

    expect(fake.last().url).toBe("https://api.example.com/v1/embeddings");
    expect(fake.last().headers.authorization).toBe("Bearer sk-test");
    expect(fake.last().body).toEqual({ model: "text-embedding-3-small", input: ["halo"], encoding_format: "float", dimensions: 512 });
    expect(result).toEqual({ vectors: [[0.1, 0.2]], inputTokens: 3 });
  });

  test("paired by index, not by position — a server that reorders cannot swap two facts' vectors", async () => {
    const fake = fakeFetch(json({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
    const result = await provider(fake.fn).embed({ model: "m", input: ["a", "b"] });
    expect(result.vectors).toEqual([[1], [2]]);
  });

  test("fewer vectors than inputs is an error, not a partial answer", async () => {
    const fake = fakeFetch(json({ data: [{ index: 0, embedding: [1] }] }));
    await expect(provider(fake.fn).embed({ model: "m", input: ["a", "b"] })).rejects.toThrow("1 embeddings for 2 inputs");
  });

  test("a server that says nothing about usage is estimated, and says so — not recorded as a free call", async () => {
    const fake = fakeFetch(json({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] }));
    const result = await provider(fake.fn).embed({ model: "m", input: ["the first fact about Gading", "and a second one"] });
    expect(result.estimated).toBe(true);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  test("nothing to embed asks nothing", async () => {
    const fake = fakeFetch(json({}));
    expect(await provider(fake.fn).embed({ model: "m", input: [] })).toEqual({ vectors: [], inputTokens: 0 });
    expect(fake.requests).toHaveLength(0);
  });
});
