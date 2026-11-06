/**
 * Routes that lose the provider's cache (TOKEN_SAVINGS §3.1, 0.8.13): the same model through two profiles can cache
 * very differently — on the live box Gemini Flash through one wire cached 1 % of its input at $0.77 a million, through
 * the other 94 % at $0.15, and the poor pairs were half the spend. Found from the usage rows alone: a route is the
 * profile and the model as recorded, compared with another route of the same model — never a provider named here.
 */

/** One profile and model over a window, as `UsageLedger.routes` adds them up. */
export interface UsageRoute {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  /** Input served from the cache, of the requests that said — a provider that reports nothing is not a 0 % route. */
  cachedInputTokens: number;
  /** Input of the requests that reported their cache at all: what `cachedInputTokens` is a share of. */
  reportedInputTokens: number;
  /** Null when no request of it was priced. */
  usd: number | null;
}

export interface CacheWarning {
  model: string;
  poor: { provider: string; cachedShare: number; usdPerMillion: number | null };
  better: { provider: string; cachedShare: number; usdPerMillion: number | null };
  said: string;
}

/** Requests a route needs before its share means something — a starting value: a first day's few calls cache little. */
export const ENOUGH_REQUESTS = 20;
/** Far below: under this fraction of the other route's share — a starting value, measured again after the change. */
const FAR_BELOW = 0.5;

export function cachedShare(route: UsageRoute): number | null {
  return route.reportedInputTokens > 0 ? route.cachedInputTokens / route.reportedInputTokens : null;
}

export function usdPerMillion(route: UsageRoute): number | null {
  return route.usd !== null && route.inputTokens > 0 ? route.usd / (route.inputTokens / 1_000_000) : null;
}

/** Each route of a model that caches far below the best route of the same model — both with enough requests to judge. */
export function cacheWarnings(routes: readonly UsageRoute[]): CacheWarning[] {
  const judged = routes.filter((route) => route.requests >= ENOUGH_REQUESTS && cachedShare(route) !== null);
  const warnings: CacheWarning[] = [];
  for (const model of new Set(judged.map((route) => route.model))) {
    const same = judged.filter((route) => route.model === model).sort((a, b) => cachedShare(b)! - cachedShare(a)!);
    const best = same[0]!;
    for (const route of same.slice(1)) {
      if (route.provider === best.provider || cachedShare(route)! >= cachedShare(best)! * FAR_BELOW) continue;
      const poor = { provider: route.provider, cachedShare: cachedShare(route)!, usdPerMillion: usdPerMillion(route) };
      const better = { provider: best.provider, cachedShare: cachedShare(best)!, usdPerMillion: usdPerMillion(best) };
      const cost = (one: { usdPerMillion: number | null }) => (one.usdPerMillion === null ? "" : ` at $${one.usdPerMillion.toFixed(2)} a million input`);
      warnings.push({
        model,
        poor,
        better,
        said:
          `${model} through ${route.provider} cached ${percent(poor.cachedShare)} of its input${cost(poor)}; through ` +
          `${best.provider}, ${percent(better.cachedShare)}${cost(better)}. The agents on ${route.provider} pay that difference ` +
          `on every request: give them ${best.provider} for ${model}.`,
      });
    }
  }
  return warnings;
}

const percent = (share: number) => `${Math.round(share * 100)} %`;
