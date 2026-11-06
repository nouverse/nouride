/**
 * Which edition of a source answers in which language. Kept as tables of what was probed rather than
 * derived from the language tag, because the services do not derive them either.
 */

/** Wikipedia's subdomain for a language: its primary subtag, but for the few that differ. */
export function wikipediaEdition(lang: string): string {
  const primary = lang.toLowerCase().split("-")[0] ?? "en";
  return ({ fil: "tl", nb: "no", nn: "no" } as Record<string, string>)[primary] ?? primary;
}

/**
 * Google News editions, probed live on 2026-10-06 — each answered a query with results. Its
 * parameters do not follow from the language tag (`BR:pt-419`, `CN:zh-Hans`; `ceid=BR:pt` answers a
 * redirect and nothing), which is why this is a table and not a formula. Malay and Filipino had no
 * edition that answered and fall back to English, like any language not listed.
 */
const NEWS_EDITIONS: Record<string, [hl: string, gl: string, ceid: string]> = {
  "en-US": ["en-US", "US", "US:en"],
  "en-GB": ["en-GB", "GB", "GB:en"],
  "en-IN": ["en-IN", "IN", "IN:en"],
  "en-AU": ["en-AU", "AU", "AU:en"],
  "en-CA": ["en-CA", "CA", "CA:en"],
  id: ["id", "ID", "ID:id"],
  ja: ["ja", "JP", "JP:ja"],
  ko: ["ko", "KR", "KR:ko"],
  "zh-CN": ["zh-CN", "CN", "CN:zh-Hans"],
  "zh-TW": ["zh-TW", "TW", "TW:zh-Hant"],
  "zh-HK": ["zh-HK", "HK", "HK:zh-Hant"],
  de: ["de", "DE", "DE:de"],
  fr: ["fr", "FR", "FR:fr"],
  es: ["es", "ES", "ES:es"],
  "es-419": ["es-419", "MX", "MX:es-419"],
  "pt-BR": ["pt-BR", "BR", "BR:pt-419"],
  "pt-PT": ["pt-PT", "PT", "PT:pt-150"],
  it: ["it", "IT", "IT:it"],
  nl: ["nl", "NL", "NL:nl"],
  ru: ["ru", "RU", "RU:ru"],
  tr: ["tr", "TR", "TR:tr"],
  ar: ["ar", "EG", "EG:ar"],
  hi: ["hi", "IN", "IN:hi"],
  vi: ["vi", "VN", "VN:vi"],
  th: ["th", "TH", "TH:th"],
  pl: ["pl", "PL", "PL:pl"],
  uk: ["uk", "UA", "UA:uk"],
  sv: ["sv", "SE", "SE:sv"],
  he: ["he", "IL", "IL:he"],
  bn: ["bn", "BD", "BD:bn"],
};

/** The edition for a language: the exact tag, then the language's usual one, then English. */
export function newsEdition(lang: string): { hl: string; gl: string; ceid: string } {
  const [primary = "en", region] = lang.split("-");
  const language = primary.toLowerCase();
  const tag = region ? `${language}-${region.toUpperCase()}` : language;
  const usual: Record<string, string> = { en: "en-US", zh: "zh-CN", pt: "pt-BR", iw: "he", in: "id" };
  const latinAmericanSpanish = language === "es" && region && !["ES"].includes(region.toUpperCase()) ? "es-419" : undefined;
  const edition =
    NEWS_EDITIONS[tag] ??
    (latinAmericanSpanish && NEWS_EDITIONS[latinAmericanSpanish]) ??
    NEWS_EDITIONS[usual[language] ?? language] ??
    NEWS_EDITIONS["en-US"]!;
  const [hl, gl, ceid] = edition;
  return { hl, gl, ceid };
}
