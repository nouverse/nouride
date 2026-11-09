/**
 * What an endpoint serves, and what each wire format can carry at all.
 *
 * Both were known in the engine instead: setup's probe built a `/models` request per format with its own copy of
 * Anthropic's API version, and hearing fetched `/models` again with its own Bearer header and asked whether the
 * profile was Anthropic. A version or an auth change was two or three edits in the wrong layer — the format is this
 * package's business, and nothing above it should know either spelling.
 */

import type { ProviderKind } from "@nouride/shared";
import { ANTHROPIC_VERSION } from "./anthropic.ts";

/** What a wire format can carry, whatever the model behind it. */
export interface WireCapabilities {
  /** An audio input part exists in the format. Anthropic's Messages API has none; OpenAI's has `input_audio`. */
  audioInput: boolean;
  /** An embeddings route exists. Anthropic has none. */
  embeddings: boolean;
}

const CAPABILITIES: Record<ProviderKind, WireCapabilities> = {
  openai: { audioInput: true, embeddings: true },
  anthropic: { audioInput: false, embeddings: false },
};

export function wireCapabilities(kind: ProviderKind): WireCapabilities {
  return CAPABILITIES[kind];
}

/** One model of a listing, as the endpoint said it — a field absent is one it did not state. */
export interface ListedModel {
  id: string;
  /** A renamed model's old id (Nougate). */
  legacyId?: string;
  /** What it takes in, when the endpoint says (Nougate does, per route). */
  inputModalities?: string[];
  inputAudioFormats?: string[];
  /** How many tokens a request to it may hold, when the endpoint says — a whole number of at least 1024. */
  contextWindow?: number;
}

/**
 * The names an endpoint gives a model's context window: Nougate's `context_window`, OpenRouter's `context_length`, vLLM's
 * `max_model_len`. The first one stated wins; a number that is not a whole one of at least 1024 is not a window.
 */
const WINDOW_FIELDS = ["context_window", "context_length", "max_model_len"] as const;

function windowOf(entry: Record<string, unknown>): number | undefined {
  for (const field of WINDOW_FIELDS) {
    const value = entry[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1024) return value;
  }
  return undefined;
}

/**
 * A listing, or why there is none: `invalid_url`, `unauthorized` (401/403), `not_found` (404), `status` (any other
 * answer that is not OK), `timeout`, `unreachable`. `url` is what was asked, for a message to name.
 */
export type ModelListing =
  | { ok: true; url: string; models: ListedModel[] }
  | { ok: false; url: string; reason: "invalid_url" | "unauthorized" | "not_found" | "status" | "timeout" | "unreachable"; status?: number };

/** How each format is asked: its auth, and Anthropic's version, which `/v1/models` requires as the Messages API does. */
function headersFor(kind: ProviderKind, apiKey: string): Record<string, string> {
  return kind === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { authorization: `Bearer ${apiKey}` };
}

/**
 * The models an endpoint lists — `GET <baseUrl>/models` exactly as typed, so a base URL missing its `/v1` fails here
 * rather than on the first message. Never throws: a listing that cannot be read is a reason.
 */
export async function listModels(input: {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<ModelListing> {
  let url: string;
  try {
    new URL(input.baseUrl);
    url = `${input.baseUrl.replace(/\/+$/, "")}/models`;
  } catch {
    return { ok: false, url: input.baseUrl, reason: "invalid_url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await (input.fetchImpl ?? fetch)(url, {
      headers: { ...input.headers, ...headersFor(input.kind, input.apiKey), accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, url, reason: "unauthorized", status: res.status };
    if (res.status === 404) return { ok: false, url, reason: "not_found", status: 404 };
    if (!res.ok) return { ok: false, url, reason: "status", status: res.status };
    return { ok: true, url, models: readListing(await res.json().catch(() => ({}))) };
  } catch (err) {
    return { ok: false, url, reason: err instanceof Error && err.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Either shape: OpenAI and Anthropic both answer `{data: [{id}]}`, and a proxy in between may answer something close.
 * What does not read is left out — a working key with an unfamiliar listing is not a failure.
 */
function readListing(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
  return data.flatMap((raw) => {
    const entry = raw as { id?: unknown; legacy_id?: unknown; input_modalities?: unknown; input_audio_formats?: unknown };
    if (typeof entry?.id !== "string") return [];
    const modalities = strings(entry.input_modalities);
    const formats = strings(entry.input_audio_formats);
    const window = windowOf(entry as Record<string, unknown>);
    return [{
      id: entry.id,
      ...(typeof entry.legacy_id === "string" && entry.legacy_id ? { legacyId: entry.legacy_id } : {}),
      ...(modalities ? { inputModalities: modalities } : {}),
      ...(formats ? { inputAudioFormats: formats } : {}),
      ...(window ? { contextWindow: window } : {}),
    }];
  });
}
