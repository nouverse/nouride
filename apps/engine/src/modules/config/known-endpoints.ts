/**
 * Endpoints known by their address, and what a provider profile on one is written with beyond its wire format.
 *
 * The one table. Setup and the Models page write a profile through `saveProvider`, which adds what its endpoint needs
 * here; the boot adds it to a profile written before an entry existed (`boot/endpoint-keys.ts`), and `config check`
 * says what that start will write. The client never asks where it is pointed: it reads the profile's own keys, so a
 * difference between endpoints is something a profile says, and this table is how it comes to say it.
 *
 * OpenAI's own API refuses `max_tokens` for its newer models ("Use 'max_completion_tokens' instead"), on every reply
 * and every compaction, and takes `max_completion_tokens` for every chat model. A server that speaks the same format
 * (OpenRouter, Ollama, vLLM, llama.cpp, Groq, Nougate) may know only `max_tokens`, so the field is written for the
 * endpoint known to need it and for no other. A key the profile already says, either way, is the operator's answer.
 *
 * `identify` is off unless a profile says it, because a strict server rejects a field it does not know. The two
 * vendors' own APIs take the fields it sends, and on OpenAI's one of them keeps a conversation's requests on the
 * cache its prefix is already in, so a profile on either is written with it. What it sends names no person: the
 * conversation goes as a digest (`executor/provider-caller.ts`).
 *
 * A plan that includes its key is written `billing = "included"`, so its use is counted in tokens and never shown as
 * money spent: OpenCode Go's, a subscription, and Command Code's, whose requests draw on plan credits. What Go asks
 * for beyond its key, a header that says the conversation, is not written from here: it is one of the profile's own
 * `headers`, which the form fills when Go is picked and the person may change.
 */

import { parseToml } from "@nouride/runtime";
import type { ProviderKind } from "@nouride/shared";
import { isPlainObject } from "./global/merge.ts";

/** A value a profile is written with, and why: a line for whoever reads where it is written (`config check`, the boot's log). */
interface EndpointKey {
  value: string | boolean;
  why: string;
}

interface KnownEndpoint {
  kind: ProviderKind;
  baseUrl: string;
  /** What a profile on it is written with, as `config.toml` spells it. */
  keys: Readonly<Record<string, EndpointKey>>;
  /**
   * Minutes the endpoint keeps a cached prompt after its last request, where its vendor states one figure: what a
   * profile on it is read with when it has no `cache_minutes` of its own. Read at load and never written, so a
   * better figure reaches every install that did not set one.
   */
  cacheMinutes?: number;
}

const OPENCODE_GO: KnownEndpoint["keys"] = {
  billing: { value: "included", why: "OpenCode Go is a subscription: use counts against the plan's limits, and nothing is charged per token" },
};

const KNOWN_ENDPOINTS: readonly KnownEndpoint[] = [
  // Five minutes: the lifetime Anthropic documents for the cache marker the client sends, which asks for no longer one.
  {
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keys: { identify: { value: true, why: "Anthropic's own API takes metadata.user_id, which tells one conversation's requests from another's" } },
    cacheMinutes: 5,
  },
  // No lifetime here: OpenAI documents from minutes to a day, by model and by the organization's retention, so a
  // profile on it is read as any endpoint that does not say, unless its `cache_minutes` does.
  {
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keys: {
      max_tokens_field: { value: "max_completion_tokens", why: "OpenAI's own API takes a reply's output limit only as max_completion_tokens for its newer models" },
      identify: { value: true, why: "OpenAI's own API takes user and prompt_cache_key, which keeps a conversation's requests on the cache its prefix is in" },
    },
  },
  { kind: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1", keys: OPENCODE_GO },
  { kind: "anthropic", baseUrl: "https://opencode.ai/inference/go/anthropic/v1", keys: OPENCODE_GO },
  {
    kind: "openai",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    keys: { billing: { value: "included", why: "a Command Code plan includes the key: use draws on the plan's credits, and nothing is charged per token" } },
  },
];

/** The wire format's own vendor: the address setup offers when nobody names one. */
export function defaultEndpoint(kind: ProviderKind): string {
  return KNOWN_ENDPOINTS.find((endpoint) => endpoint.kind === kind)!.baseUrl;
}

/** Scheme, host and path as a server reads them: a host's case and a trailing slash change nothing. */
function address(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url.trim());
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function endpointAt(kind: unknown, baseUrl: unknown): KnownEndpoint | undefined {
  const at = address(baseUrl);
  return at ? KNOWN_ENDPOINTS.find((endpoint) => endpoint.kind === kind && address(endpoint.baseUrl) === at) : undefined;
}

/** How long a profile's endpoint keeps a cached prompt, in minutes, where it is known by its address and states one. */
export function knownCacheMinutes(kind: unknown, baseUrl: unknown): number | undefined {
  return endpointAt(kind, baseUrl)?.cacheMinutes;
}

/** The `[providers]` tables as the file holds them. */
function profileTables(text: string): Record<string, unknown> {
  const providers = parseToml<{ providers?: unknown }>(text).providers;
  return isPlainObject(providers) ? providers : {};
}

/**
 * What writing a profile changes beyond its kind, address and key: the keys its endpoint is written with that its table
 * does not say yet, and, for a profile moved off another known endpoint, what that one wrote and this one does not
 * need. A `max_completion_tokens` left on a profile moved to OpenRouter would be sent there.
 *
 * `now` is where the profile is being pointed; absent, where the file already points it.
 */
export function endpointKeys(text: string, profile: string, now?: { kind: unknown; baseUrl: unknown }): { set: Record<string, string | boolean>; remove: string[]; why: string[] } {
  const found = profileTables(text)[profile];
  const table = isPlainObject(found) ? found : undefined;
  const was = table ? endpointAt(table.kind, table.base_url) : undefined;
  const to = now ? endpointAt(now.kind, now.baseUrl) : was;
  const remove = was && was !== to ? Object.entries(was.keys).filter(([key, { value }]) => table?.[key] === value && to?.keys[key]?.value !== value).map(([key]) => key) : [];
  // Only what the table does not say: a key written either way, `identify = false` included, is the operator's answer.
  const lacking = Object.entries(to?.keys ?? {}).filter(([key]) => table?.[key] === undefined || remove.includes(key));
  return { set: Object.fromEntries(lacking.map(([key, { value }]) => [key, value])), remove, why: lacking.map(([, { why }]) => why) };
}

/**
 * Every profile in the file on a known endpoint that lacks what the endpoint needs: what it lacks, and why. Only a
 * profile named in TOML's bare letters: the config editor addresses a table by a dotted path, which a quoted name with
 * a dot in it would split.
 */
export function profilesBehind(text: string): { profile: string; set: Record<string, string | boolean>; why: string }[] {
  return Object.entries(profileTables(text)).flatMap(([profile, table]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(profile) || !isPlainObject(table)) return [];
    const { set, why } = endpointKeys(text, profile);
    if (Object.keys(set).length === 0) return [];
    return [{ profile, set, why: why.join("; ") }];
  });
}
