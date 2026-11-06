/**
 * The MCP catalog as the daemon offers it (0.7.19): a search, and for each entry the form that would add it to an
 * agent. Built once at boot and handed to the control API, the CLI's routes and the agents' `mcp_search`.
 *
 * Nouverse keeps the catalog — a mirror of the official MCP registry, ranked (`GET /mcp-catalog`) — so no install
 * copies the registry's forty-five thousand servers. This asks it: a search as someone types, an entry when someone
 * opens one to add it. What an entry means *here* — how it runs on this machine, what it asks for, the form — is
 * decided here, from the registry's own `server.json`, read as defensively as before (`entry.ts`): the catalog serves
 * what the registry's publishers wrote.
 *
 * Nothing here installs anything. An entry becomes an agent's server only through `saveMcpServer`, from a person on the
 * MCP page or `nouride mcp add --from` — an agent can find one and say where to add it, never add it itself.
 */

import { hubBytes, HubError, type HubFetchDeps } from "@/modules/skills-hub/fetch.ts";
import { draftFor, routeOf, summaryOf, type DraftResult, type InstallDraft } from "./draft.ts";
import { normalizeEntry, publisherOf, type CatalogEntry } from "./entry.ts";
import { blockerLabel, machineCan, type Blocker, type CanRun } from "./runners.ts";

export type { CatalogEntry } from "./entry.ts";
export type { DraftResult, InstallDraft } from "./draft.ts";
export type { Blocker } from "./runners.ts";

/** Nouverse's catalog. `NOURIDE_MCP_CATALOG_URL` names another — or, set empty, none. */
export const CATALOG_URL = "https://service.nouverse.tech/mcp-catalog";
/** A page of twenty is about forty kilobytes; four megabytes is an answer that is not one. */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;
/** Someone is waiting on a search box. */
const TIMEOUT_MS = 15_000;
/** An entry seen in a search or opened is kept this long, and this many: a person reading a form, then saving it. */
const ENTRY_KEPT_MS = 60 * 60 * 1000;
const ENTRIES_KEPT = 100;
/**
 * A search's answer is kept this long, and this many: a word typed, deleted and typed again, or an agent asking what it
 * asked a minute ago, does not ask Nouverse twice. The catalog itself changes every few hours.
 */
const SEARCH_KEPT_MS = 5 * 60 * 1000;
const SEARCHES_KEPT = 50;
/** Where Nouverse puts its ranking of an entry, beside the registry's own metadata. */
const RANKING = "tech.nouverse/catalog";

/** A row of results: the entry, who published it, how it would run here, and what it would ask for. */
export interface CatalogCard {
  name: string;
  version: string;
  title?: string;
  description: string;
  link?: string;
  publisher: string;
  needs: string[];
  runsVia?: InstallDraft["runsVia"];
  /** Why this machine cannot run it, instead of `runsVia`: a sentence, with how to fix it. */
  unsupported?: string;
  /** The same, in a shape a badge is built from — and the badge's own words: "needs uv", "Docker not usable". */
  blocked?: Blocker & { label: string };
  /** Its place in Nouverse's list, when Nouverse pinned it there. */
  pinned?: number;
}

export interface CatalogPage {
  cards: CatalogCard[];
  /** How many match in all — `cards` are the first of them. */
  total: number;
  /** When Nouverse last brought its copy of the registry up to date (ISO). Null: it has not yet. */
  syncedAt: string | null;
}

export interface McpCatalog {
  /** Best first. Without words, Nouverse's own list — what it pinned first. */
  search(query: string, limit?: number): Promise<CatalogPage>;
  /** One entry with the form adding it would fill in. Undefined: the catalog has no such entry. */
  open(name: string): Promise<{ card: CatalogCard; result: DraftResult } | undefined>;
}

/** Where the catalog is, from the environment: Nouverse's, another an operator named, or none (set empty). */
export function catalogAddress(env: Record<string, string | undefined>): { url: string; chosen: boolean } | null {
  const named = env.NOURIDE_MCP_CATALOG_URL;
  if (named === undefined) return { url: CATALOG_URL, chosen: false };
  return named.trim() ? { url: named.trim(), chosen: true } : null;
}

/** The catalog this install asks, from the environment — none when `NOURIDE_MCP_CATALOG_URL` is set empty. */
export function catalogFromEnvironment(env: Record<string, string | undefined>): McpCatalog | undefined {
  const at = catalogAddress(env);
  return at ? createMcpCatalog({ url: at.url, fetch: { allowPrivate: at.chosen } }) : undefined;
}

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export function createMcpCatalog(
  deps: {
    url?: string;
    fetch?: HubFetchDeps;
    /** Whether a program runs here — on the PATH a stdio server is started with (`runners.ts`). */
    can?: CanRun;
    now?: () => number;
  } = {},
): McpCatalog {
  const base = (deps.url ?? CATALOG_URL).replace(/\/+$/, "");
  const now = deps.now ?? Date.now;
  const can = deps.can ?? machineCan();

  /** The catalog's answer, out of its envelope. */
  const ask = async (path: string): Promise<Raw> => {
    const bytes = await hubBytes(`${base}${path}`, deps.fetch ?? {}, { maxBytes: ANSWER_MAX_BYTES, accept: "application/json", timeoutMs: TIMEOUT_MS });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new HubError(`the MCP catalog at ${base} did not answer with JSON`);
    }
    if (!isRaw(body) || body.success !== true || !isRaw(body.payload)) {
      throw new HubError(`the MCP catalog refused: ${isRaw(body) && typeof body.message === "string" && body.message ? body.message : "no reason given"}`);
    }
    return body.payload;
  };

  const route = (summary: ReturnType<typeof summaryOf>) => {
    const routed = routeOf(summary, can);
    return "blocked" in routed ? { unsupported: routed.unsupported, blocked: { ...routed.blocked, label: blockerLabel(routed.blocked) } } : routed;
  };

  const cardOf = (entry: CatalogEntry, pinned?: number): CatalogCard => {
    const summary = summaryOf(entry);
    return {
      name: entry.name,
      version: entry.version,
      ...(entry.title ? { title: entry.title } : {}),
      description: entry.description,
      ...(summary.link ? { link: summary.link } : {}),
      publisher: publisherOf(entry.name),
      needs: summary.needs,
      ...route(summary),
      ...(pinned ? { pinned } : {}),
    };
  };

  /** Entries a search showed or someone opened — so adding one does not ask again. */
  const kept = new Map<string, { entry: CatalogEntry; at: number }>();
  const keep = (entry: CatalogEntry) => {
    kept.delete(entry.name);
    kept.set(entry.name, { entry, at: now() });
    if (kept.size > ENTRIES_KEPT) kept.delete(kept.keys().next().value!);
  };

  /** One `{ server, _meta }` of an answer as Nouride reads it, or null when it is not an entry it can. */
  const read = (item: unknown): { entry: CatalogEntry; pinned?: number } | null => {
    if (!isRaw(item)) return null;
    const entry = normalizeEntry(item.server);
    if (!entry) return null;
    const ranking = isRaw(item._meta) && isRaw(item._meta[RANKING]) ? item._meta[RANKING] : {};
    return { entry, ...(typeof ranking.pinned === "number" ? { pinned: ranking.pinned } : {}) };
  };

  /** What a search found, not the cards: whether each runs here is asked again every time it is shown. */
  const searched = new Map<string, { found: { entry: CatalogEntry; pinned?: number }[]; total: number; syncedAt: string | null; at: number }>();
  const pageOf = (held: { found: { entry: CatalogEntry; pinned?: number }[]; total: number; syncedAt: string | null }): CatalogPage => ({
    cards: held.found.map(({ entry, pinned }) => cardOf(entry, pinned)),
    total: held.total,
    syncedAt: held.syncedAt,
  });

  return {
    async search(query, limit = 20) {
      const params = new URLSearchParams({ limit: String(Math.min(Math.max(Math.trunc(limit), 1), 50)) });
      const words = query.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 100);
      if (words) params.set("search", words);
      const key = params.toString();
      const held = searched.get(key);
      if (held && now() - held.at < SEARCH_KEPT_MS) return pageOf(held);

      const payload = await ask(`?${key}`);
      const found = (Array.isArray(payload.servers) ? payload.servers : []).map(read).filter((hit) => hit !== null);
      for (const { entry } of found) keep(entry);
      const metadata = isRaw(payload.metadata) ? payload.metadata : {};
      const answer = {
        found,
        total: typeof metadata.total === "number" ? metadata.total : found.length,
        syncedAt: typeof metadata.syncedAt === "string" ? metadata.syncedAt : null,
      };
      searched.delete(key);
      searched.set(key, { ...answer, at: now() });
      if (searched.size > SEARCHES_KEPT) searched.delete(searched.keys().next().value!);
      return pageOf(answer);
    },
    async open(name) {
      const held = kept.get(name);
      let entry = held && now() - held.at < ENTRY_KEPT_MS ? held.entry : undefined;
      if (!entry) {
        let payload: Raw;
        try {
          payload = await ask(`/servers/${encodeURIComponent(name)}`);
        } catch (err) {
          if (err instanceof HubError && err.status === 404) return undefined;
          throw err;
        }
        const hit = read(payload);
        if (!hit || hit.entry.name !== name) throw new HubError(`the MCP catalog's answer for ${name} is not an entry Nouride can read`);
        entry = hit.entry;
        keep(entry);
      }
      return { card: cardOf(entry), result: draftFor(entry, can) };
    },
  };
}
