/**
 * A model listing and what a format can carry, said once here (`models.ts`) — setup's probe and the hearing check had
 * their own `/models` requests, their own auth, and Anthropic's version written out a second time.
 */

import { describe, expect, test } from "bun:test";
import { listModels, wireCapabilities } from "../src/index.ts";
import { ANTHROPIC_VERSION } from "../src/anthropic.ts";

function answering(status: number, body: unknown = {}) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe("listModels", () => {
  test("asks Anthropic with its key and the version the Messages client speaks", async () => {
    const f = answering(200, { data: [{ id: "claude-x" }] });
    const listing = await listModels({ kind: "anthropic", baseUrl: "https://api.anthropic.com/v1/", apiKey: "sk-a", timeoutMs: 1_000, fetchImpl: f.fetchImpl });
    expect(listing).toEqual({ ok: true, url: "https://api.anthropic.com/v1/models", models: [{ id: "claude-x" }] });
    expect(f.asked[0]!.headers).toMatchObject({ "x-api-key": "sk-a", "anthropic-version": ANTHROPIC_VERSION });
    expect(f.asked[0]!.headers.authorization).toBeUndefined();
  });

  test("asks an OpenAI-compatible endpoint with a bearer key, beside the profile's own headers, and reads what it states", async () => {
    const f = answering(200, { data: [{ id: "a:m", legacy_id: "m-old", input_modalities: ["text", "audio"], input_audio_formats: ["mp3"] }, { id: 7 }] });
    const listing = await listModels({ kind: "openai", baseUrl: "https://gw.test/v1", apiKey: "sk-o", headers: { "x-gateway": "g" }, timeoutMs: 1_000, fetchImpl: f.fetchImpl });
    expect(listing).toMatchObject({ ok: true, models: [{ id: "a:m", legacyId: "m-old", inputModalities: ["text", "audio"], inputAudioFormats: ["mp3"] }] });
    expect(f.asked[0]!.headers).toMatchObject({ authorization: "Bearer sk-o", "x-gateway": "g" });
  });

  test("reads the context window an endpoint states, under each name it is given, and nothing that is not one (G2)", async () => {
    const f = answering(200, {
      data: [
        { id: "nougate:m", context_window: 1_000_000 },
        { id: "openrouter/m", context_length: 131_072 },
        { id: "vllm-m", max_model_len: 32_768 },
        { id: "both", context_window: 200_000, context_length: 128_000 },
        { id: "fraction", context_window: 1_000.5 },
        { id: "tiny", context_window: 512 },
        { id: "text", context_window: "200k" },
        { id: "none" },
      ],
    });
    const listing = await listModels({ kind: "openai", baseUrl: "https://gw.test/v1", apiKey: "k", timeoutMs: 1_000, fetchImpl: f.fetchImpl });
    const windows = listing.ok ? Object.fromEntries(listing.models.map((model) => [model.id, model.contextWindow ?? null])) : {};
    expect(windows).toEqual({ "nougate:m": 1_000_000, "openrouter/m": 131_072, "vllm-m": 32_768, both: 200_000, fraction: null, tiny: null, text: null, none: null });
  });

  test("says why there is no listing, and never throws", async () => {
    const base = { kind: "openai" as const, baseUrl: "https://gw.test/v1", apiKey: "k", timeoutMs: 1_000 };
    expect(await listModels({ ...base, fetchImpl: answering(401).fetchImpl })).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(await listModels({ ...base, fetchImpl: answering(404).fetchImpl })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await listModels({ ...base, fetchImpl: answering(500).fetchImpl })).toMatchObject({ ok: false, reason: "status", status: 500 });
    expect(await listModels({ ...base, baseUrl: "not a url" })).toMatchObject({ ok: false, reason: "invalid_url" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await listModels({ ...base, fetchImpl: down })).toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("wireCapabilities", () => {
  test("Anthropic's format carries no audio and has no embeddings; OpenAI's has both", () => {
    expect(wireCapabilities("anthropic")).toEqual({ audioInput: false, embeddings: false });
    expect(wireCapabilities("openai")).toEqual({ audioInput: true, embeddings: true });
  });
});
