/**
 * What a provider profile's endpoint says about its models: its `/models` listing, asked at most hourly.
 *
 * Two readers, one listing. Hearing asks which models take audio (`attachments/hearing.ts`); a turn asks how large a
 * request to its model may be (`executor/prepare.ts`). Each fetched its own listing, or would have — a gateway asked
 * twice an hour per profile for the same answer.
 *
 * A turn never waits for it. `windowNow` answers from what the endpoint last said and asks again in the background
 * when that is stale or missing — where a listing on the turn's path would hold every first turn for up to five
 * seconds of timeout against a gateway that is down.
 *
 * What the endpoint last said of each model's window is kept across a restart (`remembered`, a row of the daemon's
 * state). Without it the first turns after a boot, the messages that waited while the daemon was down among them,
 * and every turn while a listing could not be read, were budgeted by the table's guess (`contextWindowInfo`): 200,000
 * for a model the gateway lists at a million, so a coding agent's history was compacted and a tool result it was
 * still using was cut at a fifth of its room. What was kept answers until the endpoint says something new, and only
 * for the address it was said by.
 */

import { listModels, type ListedModel } from "@nouride/llm";
import { createLogger, type ProviderKind } from "@nouride/shared";

const log = createLogger("llm.catalog");

/** How long a listing is believed. Long enough to cost nothing per turn or per voice note. */
const LISTING_TTL_MS = 60 * 60 * 1000;
/** How long a listing that could not be read stays unread, so a gateway that is down is not asked per question. */
const LISTING_FAILURE_TTL_MS = 60 * 1000;
const LISTING_TIMEOUT_MS = 5000;

type Endpoint = { kind: ProviderKind; baseUrl: string; apiKey: string; headers?: Record<string, string> };

/** What each profile's endpoint last stated: its address then, and each model's window, null where it stated none. */
export type RememberedWindows = Record<string, { address: string; windows: Record<string, number | null> }>;

export interface CatalogDeps {
  /** The profile's endpoint as it is now — throws for a profile or a credential that is not there. */
  endpointFor(profile: string): Endpoint;
  /** Where what the endpoints said is kept across a restart. Absent, nothing is: a test, the CLI. */
  remembered?: { load(): RememberedWindows; save(windows: RememberedWindows): void };
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Entry {
  at: number;
  /** By every name a model answers to — its id, and a renamed one's old id (Nougate's `legacy_id`). Null: unreadable. */
  models: Map<string, ListedModel> | null;
}

export class ModelCatalog {
  private readonly entries = new Map<string, Entry>();
  /** A listing being asked for, so the readers that ask at once share one request. */
  private readonly asking = new Map<string, Promise<Map<string, ListedModel> | null>>();

  /** What was kept, as it was loaded and since written: read where no listing of this boot answers. */
  private readonly kept: RememberedWindows;

  constructor(private readonly deps: CatalogDeps) {
    this.kept = deps.remembered?.load() ?? {};
  }

  /**
   * The profile's listing, asked for when what it last said is older than an hour — a minute, when it could not be
   * read. Never throws: null is a listing that cannot be read now, or a profile that cannot be reached.
   */
  async listing(profile: string): Promise<Map<string, ListedModel> | null> {
    const cached = this.fresh(profile);
    if (cached !== undefined) return cached;
    return await this.ask(profile);
  }

  /**
   * The context window the profile's endpoint states for `model`, from what it last said — never waiting for it, and
   * from before this boot where this boot has nothing yet (`windowIn` for a bare id). Null when it has said nothing
   * about that model; a stale or missing answer is asked for in the background, for the next turn.
   */
  windowNow(profile: string, model: string): number | null {
    const entry = this.entries.get(profile);
    if (!entry || this.now() - entry.at >= ttlOf(entry)) void this.ask(profile);
    const models = entry?.models;
    if (models) return windowIn(new Map([...models].map(([name, listed]) => [name, listed.contextWindow ?? null])), model);
    // Nothing read yet this boot, or a listing that cannot be read now: what the endpoint said before, where it is still
    // the same endpoint. A profile moved to another address is forgotten (`forget`); this also checks the address.
    const kept = this.kept[profile];
    if (!kept || kept.address !== this.addressOf(profile)) return null;
    return windowIn(new Map(Object.entries(kept.windows)), model);
  }

  /** Drop what a profile's endpoint said: its URL or credential changed, and the old answer is not about the new one. */
  forget(profile: string): void {
    this.entries.delete(profile);
    if (this.kept[profile]) {
      delete this.kept[profile];
      this.deps.remembered?.save(this.kept);
    }
  }

  /** The cached listing while it is believed; `undefined` when it is not, or there is none. */
  private fresh(profile: string): Map<string, ListedModel> | null | undefined {
    const entry = this.entries.get(profile);
    return entry && this.now() - entry.at < ttlOf(entry) ? entry.models : undefined;
  }

  private ask(profile: string): Promise<Map<string, ListedModel> | null> {
    const pending = this.asking.get(profile);
    if (pending) return pending;
    const request = this.fetch(profile)
      .catch(() => null)
      .then((models) => {
        this.entries.set(profile, { at: this.now(), models });
        if (models) this.keep(profile, models);
        return models;
      })
      .finally(() => this.asking.delete(profile));
    this.asking.set(profile, request);
    return request;
  }

  /** The endpoint's listing, asked the way its format asks (`listModels`). Never throws. */
  private async fetch(profile: string): Promise<Map<string, ListedModel> | null> {
    let endpoint: Endpoint;
    try {
      endpoint = this.deps.endpointFor(profile);
    } catch {
      // A missing profile or credential fails the turn elsewhere, with a better message than this could give.
      return null;
    }
    try {
      const listing = await listModels({ ...endpoint, timeoutMs: LISTING_TIMEOUT_MS, ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}) });
      if (!listing.ok) {
        log.warn("model listing could not be read", { profile, reason: listing.reason, ...(listing.status ? { status: listing.status } : {}) });
        return null;
      }
      return byName(listing.models);
    } catch (err) {
      log.warn("model listing could not be read", { profile, error: String(err) });
      return null;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The profile's address as it is now, or null where it cannot be had. */
  private addressOf(profile: string): string | null {
    try {
      return this.deps.endpointFor(profile).baseUrl;
    } catch {
      return null;
    }
  }

  /** What a listing said of each model's window, kept for the next boot: written only when it changed. */
  private keep(profile: string, models: Map<string, ListedModel>): void {
    const address = this.addressOf(profile);
    if (!this.deps.remembered || address === null) return;
    const windows = Object.fromEntries([...models].map(([name, listed]) => [name, listed.contextWindow ?? null]));
    const before = this.kept[profile];
    if (before && before.address === address && sameWindows(before.windows, windows)) return;
    this.kept[profile] = { address, windows };
    this.deps.remembered.save(this.kept);
  }
}

/**
 * A model's window among what an endpoint said, by every name it answers to. A bare id (`claude-opus-5.5`) on a gateway
 * that lists ids with a provider (`kiro:claude-opus-5.5`) can go to any provider that serves it, and which one is the
 * gateway's choice per request. So it is the smallest window among them, and only when every one of them states one:
 * a route that says nothing could be the 32k one.
 */
function windowIn(windows: Map<string, number | null>, model: string): number | null {
  const exact = windows.get(model);
  if (exact !== undefined || model.includes(":")) return exact ?? null;
  const routes = [...windows.entries()].filter(([id]) => id.endsWith(`:${model}`)).map(([, window]) => window);
  if (routes.length === 0 || routes.some((window) => window === null)) return null;
  return Math.min(...(routes as number[]));
}

function sameWindows(a: Record<string, number | null>, b: Record<string, number | null>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && a[key] === b[key]);
}

function ttlOf(entry: Entry): number {
  return entry.models ? LISTING_TTL_MS : LISTING_FAILURE_TTL_MS;
}

/** The listing, keyed by every name a model answers to: an agent config may name a renamed model by either. */
function byName(models: readonly ListedModel[]): Map<string, ListedModel> {
  const out = new Map<string, ListedModel>();
  for (const model of models) {
    for (const name of [model.id, model.legacyId]) if (name) out.set(name, model);
  }
  return out;
}
