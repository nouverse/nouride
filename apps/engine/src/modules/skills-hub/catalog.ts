/**
 * Nouverse's skills catalog as the daemon asks it: a search, best first, and without words Nouverse's own list, what
 * it pinned first.
 *
 * Nouverse keeps a copy of the hubs' listings with its own order on top (`GET /skills-catalog`), so every install
 * asks one place and a skill known to work well is found first. This only asks. What it is answered was written by
 * strangers and is read as such: an entry whose reference is not one the hub's install takes, or whose link is not a
 * web address, is left out. Nothing here installs: a result carries its reference, and the install (`index.ts`)
 * fetches from the hub itself, so what a person approves is what its author published.
 */

import { oneLine } from "@nouride/shared";
import { hubBytes, HubError, type HubFetchDeps } from "./fetch.ts";
import { parseRef, type HubHit } from "./sources.ts";

/** Nouverse's catalog. `NOURIDE_SKILLS_CATALOG_URL` names another, or, set empty, none. */
export const SKILLS_CATALOG_URL = "https://service.nouverse.tech/skills-catalog";
/** A page of fifty is a few tens of kilobytes; four megabytes is an answer that is not one. */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;
/** Someone is waiting on a search box. */
const TIMEOUT_MS = 15_000;
/**
 * A search's answer is kept this long, and this many: a word typed, deleted and typed again, or an agent asking what
 * it asked a minute ago, does not ask Nouverse twice. A failure is not kept.
 */
const SEARCH_KEPT_MS = 5 * 60 * 1000;
const SEARCHES_KEPT = 50;
/** Where Nouverse puts its ranking of an entry. */
const RANKING = "tech.nouverse/catalog";
const REF_MAX = 300;
const DESCRIPTION_MAX = 1000;

export interface CatalogSkills {
  hits: HubHit[];
  /** How many match in all: `hits` are the first of them. */
  total: number;
  /** When Nouverse last brought its copy up to date (ISO). Null: it has not yet. */
  syncedAt: string | null;
}

export interface SkillsCatalog {
  /** Best first. Without words, Nouverse's own list, what it pinned first. */
  search(query: string, limit?: number): Promise<CatalogSkills>;
}

/** Where the catalog is, from the environment: Nouverse's, another an operator named, or none (set empty). */
export function skillsCatalogAddress(env: Record<string, string | undefined>): { url: string; chosen: boolean } | null {
  const named = env.NOURIDE_SKILLS_CATALOG_URL;
  if (named === undefined) return { url: SKILLS_CATALOG_URL, chosen: false };
  return named.trim() ? { url: named.trim(), chosen: true } : null;
}

/** The catalog this install asks, from the environment: none when `NOURIDE_SKILLS_CATALOG_URL` is set empty. */
export function skillsCatalogFromEnvironment(env: Record<string, string | undefined>): SkillsCatalog | undefined {
  const at = skillsCatalogAddress(env);
  // An address the operator chose may be on their own network; Nouverse's never is.
  return at ? createSkillsCatalog({ url: at.url, fetch: { allowPrivate: at.chosen } }) : undefined;
}

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined);
/** How much something is used, to show: the catalog writes 0 where a source keeps no such number, and "0 installs" would read as nobody wanting it. */
const used = (value: unknown): number | undefined => count(value) || undefined;
const words = (value: unknown, max: number): string => (typeof value === "string" ? oneLine(value).slice(0, max) : "");

/** A web address, or nothing: a link is shown to be pressed, so nothing else is kept as one. */
function webAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** One entry of an answer as a hit, or null when it is not one Nouride can install from or show. */
function readHit(item: unknown): HubHit | null {
  if (!isRaw(item) || typeof item.ref !== "string" || item.ref.length > REF_MAX) return null;
  // Its source is what its reference says, never what the entry says beside it: the badge and the install agree.
  const parsed = parseRef(item.ref);
  if (typeof parsed === "string" || (parsed.kind !== "clawhub" && parsed.kind !== "github")) return null;
  const url = webAddress(item.url);
  const name = words(item.name, 200);
  if (!url || !name) return null;
  const ranking = isRaw(item._meta) && isRaw(item._meta[RANKING]) ? item._meta[RANKING] : {};
  const title = words(item.title, 200);
  const owner = words(item.owner, 100);
  const installs = used(item.installs);
  const stars = used(item.stars);
  return {
    ref: item.ref,
    source: parsed.kind,
    name,
    description: words(item.description, DESCRIPTION_MAX),
    url,
    ...(installs !== undefined ? { installs } : {}),
    ...(stars !== undefined ? { stars } : {}),
    ...(title && title !== name ? { title } : {}),
    ...(owner ? { owner } : {}),
    ...(typeof ranking.pinned === "number" ? { pick: true } : {}),
  };
}

export function createSkillsCatalog(deps: { url?: string; fetch?: HubFetchDeps; now?: () => number } = {}): SkillsCatalog {
  const base = (deps.url ?? SKILLS_CATALOG_URL).replace(/\/+$/, "");
  const now = deps.now ?? Date.now;
  const searched = new Map<string, CatalogSkills & { at: number }>();

  /** The catalog's answer, out of its envelope. */
  const ask = async (path: string): Promise<Raw> => {
    const bytes = await hubBytes(`${base}${path}`, deps.fetch ?? {}, { maxBytes: ANSWER_MAX_BYTES, accept: "application/json", timeoutMs: TIMEOUT_MS });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new HubError(`the skills catalog at ${base} did not answer with JSON`);
    }
    if (!isRaw(body) || body.success !== true || !isRaw(body.payload)) {
      throw new HubError(`the skills catalog refused: ${isRaw(body) && typeof body.message === "string" && body.message ? body.message : "no reason given"}`);
    }
    return body.payload;
  };

  return {
    async search(query, limit = 20) {
      const params = new URLSearchParams({ limit: String(Math.min(Math.max(Math.trunc(limit), 1), 50)) });
      const asked = oneLine(query).toLowerCase().slice(0, 100);
      if (asked) params.set("search", asked);
      const key = params.toString();
      const held = searched.get(key);
      if (held && now() - held.at < SEARCH_KEPT_MS) return { hits: held.hits, total: held.total, syncedAt: held.syncedAt };

      const payload = await ask(`?${key}`);
      const hits = (Array.isArray(payload.skills) ? payload.skills : []).map(readHit).filter((hit) => hit !== null);
      const metadata = isRaw(payload.metadata) ? payload.metadata : {};
      const answer = {
        hits,
        total: count(metadata.total) ?? hits.length,
        syncedAt: typeof metadata.syncedAt === "string" ? metadata.syncedAt : null,
      };
      searched.delete(key);
      searched.set(key, { ...answer, at: now() });
      if (searched.size > SEARCHES_KEPT) searched.delete(searched.keys().next().value!);
      return answer;
    },
  };
}
