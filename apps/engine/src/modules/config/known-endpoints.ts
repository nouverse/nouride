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
 */

import { parseToml } from "@nouride/runtime";
import type { ProviderKind } from "@nouride/shared";
import { isPlainObject } from "./global/merge.ts";

interface KnownEndpoint {
  kind: ProviderKind;
  baseUrl: string;
  /** What a profile on it is written with, as `config.toml` spells it. */
  keys: Readonly<Record<string, string>>;
  /** Why, in a line for whoever reads where it is written (`config check`, the boot's log). */
  why?: string;
}

const KNOWN_ENDPOINTS: readonly KnownEndpoint[] = [
  { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", keys: {} },
  {
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keys: { max_tokens_field: "max_completion_tokens" },
    why: "OpenAI's own API takes a reply's output limit only as max_completion_tokens for its newer models",
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
export function endpointKeys(text: string, profile: string, now?: { kind: unknown; baseUrl: unknown }): { set: Record<string, string>; remove: string[] } {
  const found = profileTables(text)[profile];
  const table = isPlainObject(found) ? found : undefined;
  const was = table ? endpointAt(table.kind, table.base_url) : undefined;
  const to = now ? endpointAt(now.kind, now.baseUrl) : was;
  const remove = was && was !== to ? Object.entries(was.keys).filter(([key, value]) => table?.[key] === value && to?.keys[key] !== value).map(([key]) => key) : [];
  const set = Object.fromEntries(Object.entries(to?.keys ?? {}).filter(([key]) => table?.[key] === undefined || remove.includes(key)));
  return { set, remove };
}

/**
 * Every profile in the file on a known endpoint that lacks what the endpoint needs: what it lacks, and why. Only a
 * profile named in TOML's bare letters: the config editor addresses a table by a dotted path, which a quoted name with
 * a dot in it would split.
 */
export function profilesBehind(text: string): { profile: string; set: Record<string, string>; why: string }[] {
  return Object.entries(profileTables(text)).flatMap(([profile, table]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(profile) || !isPlainObject(table)) return [];
    const { set } = endpointKeys(text, profile);
    if (Object.keys(set).length === 0) return [];
    return [{ profile, set, why: endpointAt(table.kind, table.base_url)?.why ?? "" }];
  });
}
