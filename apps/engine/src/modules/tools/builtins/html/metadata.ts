/**
 * `<head>`, as a few lines of YAML frontmatter instead of as nothing.
 *
 * The Markdown reduction keeps what is inside `<body>` and drops the rest, which is right about
 * scripts and stylesheets and wrong about the twenty or so tags that say what the document *is*:
 * its real title, the summary its author wrote, who wrote it, when it was published, where its
 * canonical copy lives, what its social card shows. An agent doing research needs those and had two
 * ways to get them, both bad — re-fetch the same page as `format: "html"` and read 70KB of markup to
 * find six values, or infer the publication date from the prose and be wrong without knowing it.
 *
 * So they come back as frontmatter above the body. The format is not decoration: `---` at the top of
 * a Markdown document is a convention every model has read ten thousand times, so nothing about it
 * has to be explained, and the whole block costs on the order of a hundred tokens against a page
 * that routinely costs thousands.
 *
 * ## What is deliberately not here
 *
 * **Everything else in `<head>`.** `viewport`, `theme-color`, `robots`, preload hints, the eleven
 * `<link>` tags for favicons — every one of them is bytes the model has to skip, and none of them
 * answers a question about the content. `FIELDS` is what a person reading a search result would
 * want, and it stops there. `format: "html"` remains the answer for anything beyond it.
 *
 * **JSON-LD.** `<script type="application/ld+json">` is richer and often more accurate, and it is
 * also an arbitrarily deep object of unbounded size — flattening one to key/value pairs means either
 * a schema-by-schema mapping or dumping a blob of JSON back into the budget this file exists to
 * protect. It is reachable under `format: "html"`, which is where the script bodies already are.
 *
 * ## The values are attacker-controlled
 *
 * Every one of these strings was written by whoever owns the page. Two consequences, both handled
 * here rather than left to the reader: newlines and control characters are collapsed to spaces, so a
 * `content="…"` cannot close the frontmatter block early and forge fields underneath it; and every
 * value is emitted as a quoted scalar with `\` and `"` escaped, so it cannot terminate its own
 * string. Lengths are capped for the same reason a fetch is capped — a 40KB description is a denial
 * of the budget, not a description. The content is still untrusted after all that: `web_fetch` marks
 * the whole result as such, and this block sits inside that marker.
 */

import { decodeEntities } from "@/modules/tools/builtins/html/entities.ts";
import { contentChildren, isNoise } from "@/modules/tools/builtins/html/extract.ts";
import { collapse, collect, findFirst, rawText, type ElementNode } from "@/modules/tools/builtins/html/parse.ts";
import { absolutize, imageSource, isTrackingPixel, unwrapImageProxy } from "@/modules/tools/builtins/html/urls.ts";

export interface MetadataField {
  key: string;
  /**
   * A scalar, a list of scalars, or a list of small records.
   *
   * The third shape exists for `feeds`, where a bare URL is not enough — a WordPress page publishes
   * the site feed and the comment feed side by side, and telling them apart is the whole reason to
   * list them.
   */
  value: string | string[] | Array<Record<string, string>>;
}

/** Per-field ceilings. A description is allowed a paragraph; a date that long is a payload. */
const LIMITS = {
  title: 200,
  description: 500,
  short: 120,
  url: 400,
  keyword: 60,
} as const;

/** Enough to say what the page is about. Beyond this it is a stuffed list, not a topic. */
const MAX_KEYWORDS = 12;

/**
 * Content images listed in the frontmatter.
 *
 * Eight is a gallery's worth and a long article's worth. An unbounded list is how a page of
 * thumbnails turns a hundred-token block into a thousand-token one, and the body still carries every
 * image inline with its alt text — this list is the index, not the archive.
 */
const MAX_CONTENT_IMAGES = 8;

/**
 * Feeds listed.
 *
 * WordPress declares the site feed, the comments feed and a feed per category from the same `<head>`,
 * and a tag archive adds one more. Four covers a blog that has a real answer; past that the page is
 * enumerating its own taxonomy, which is not what "where do I subscribe" was asking.
 */
const MAX_FEEDS = 4;


/** `og:type` on a page that is not an article. It is the default value and says nothing. */
const UNINFORMATIVE_TYPE = "website";

/**
 * The document's own title, as `<title>` says it.
 *
 * Shared with the serializer, which prefers the `<h1>` for the body heading — "Rate limits" reads
 * better as a heading than "Rate limits — Example Docs". The site-qualified form is not lost by that
 * choice, because this is where it goes.
 */
export function documentTitle(root: ElementNode): string {
  const titleTag = findFirst(root, "title");
  return titleTag ? collapse(decodeEntities(rawText(titleTag))).trim() : "";
}

/**
 * The fields, in the order they are emitted.
 *
 * Ordered by what a reader wants first — what is this, what does it say, who wrote it, when — not by
 * where the tags sit in the source. Each entry names its sources best-first: the dedicated tag, then
 * the Open Graph one, then Twitter's. That is also the order they stop being filled in by a CMS that
 * fills in only some of them.
 */
const FIELDS: Array<{ key: string; sources: string[]; limit: number }> = [
  { key: "description", sources: ["description", "og:description", "twitter:description"], limit: LIMITS.description },
  { key: "site_name", sources: ["og:site_name", "application-name"], limit: LIMITS.short },
  { key: "author", sources: ["author", "article:author", "og:article:author", "citation_author"], limit: LIMITS.short },
  {
    key: "published",
    sources: [
      "article:published_time", "article:published", "datepublished",
      "date", "dc.date", "citation_publication_date",
    ],
    limit: LIMITS.short,
  },
  { key: "modified", sources: ["article:modified_time", "og:updated_time", "datemodified"], limit: LIMITS.short },
  { key: "type", sources: ["og:type"], limit: LIMITS.short },
  {
    key: "image",
    sources: ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"],
    limit: LIMITS.url,
  },
];

export interface MetadataOptions {
  /**
   * The URL the body was finally fetched from.
   *
   * What makes a relative `<link rel="canonical" href="/docs/limits">` usable — resolved here
   * rather than by the model, which would have to be told the base to do it and would not know the
   * redirect chain that changed it.
   */
  baseUrl?: string;
  /**
   * The extracted content container, when the caller has already chosen one.
   *
   * `<head>` describes the document; this is where the document's own pictures are. A research
   * agent asked what a page shows, or asked to carry a diagram into its answer, needs the second
   * one — and `og:image` is not it. That tag is the social card, chosen to look right in a link
   * preview, and on most sites it is the same house image on every page.
   */
  content?: ElementNode;
  /**
   * A sitemap the *caller* found, used only when `<head>` declares none.
   *
   * `<link rel="sitemap">` is valid and rare; the place a site actually publishes its sitemap is the
   * `Sitemap:` line in `robots.txt`, which is a second HTTP request and therefore not this
   * directory's business — nothing in `html/` fetches anything. `web_fetch` looks it up for a root
   * page and passes the answer down. See `web/fetch.ts`.
   */
  sitemap?: string;
}

/** What the document claims about itself: `<head>`, plus the pictures the article actually shows. */
export function extractMetadata(root: ElementNode, options: MetadataOptions = {}): MetadataField[] {
  const { baseUrl, content } = options;
  const meta = metaIndex(root);
  const links = linkIndex(root);
  const fields: MetadataField[] = [];

  const add = (key: string, value: string | undefined, limit: number): void => {
    const cleaned = value ? clean(value, limit) : "";
    if (cleaned) fields.push({ key, value: cleaned });
  };

  add("title", documentTitle(root) || pick(meta, ["og:title", "twitter:title"]), LIMITS.title);

  for (const field of FIELDS) {
    const value = pick(meta, field.sources);
    if (field.key === "type" && value?.trim().toLowerCase() === UNINFORMATIVE_TYPE) continue;
    add(field.key, field.key === "image" ? absolutize(value, baseUrl) : value, field.limit);
  }

  const card = fields.find((field) => field.key === "image")?.value;
  const images = content ? contentImages(content, baseUrl, typeof card === "string" ? card : "") : [];
  if (images.length > 0) fields.push({ key: "images", value: images });

  add("canonical", absolutize(links.canonical ?? meta["og:url"], baseUrl), LIMITS.url);

  // Discovery, not description: how to follow this site rather than what this page says. Both are
  // one `<link>` away in the markup and were being thrown out with the favicons.
  const feeds = feedLinks(root, baseUrl);
  if (feeds.length > 0) fields.push({ key: "feeds", value: feeds });

  add("sitemap", absolutize(links.sitemap, baseUrl) ?? options.sitemap, LIMITS.url);

  const keywords = splitKeywords(meta.keywords ?? meta["article:tag"] ?? meta.news_keywords);
  if (keywords.length > 0) fields.push({ key: "keywords", value: keywords });

  // Worth a line to a researcher reading a page it cannot otherwise place, and to one deciding
  // whether to go looking for the English version. Two characters of it, usually.
  add("lang", findFirst(root, "html")?.attrs.lang ?? meta["og:locale"], LIMITS.short);

  return fields;
}

/** The block, or an empty string when the page said nothing worth a line. */
export function renderFrontmatter(fields: MetadataField[]): string {
  if (fields.length === 0) return "";

  const lines = fields.map(({ key, value }) => {
    if (typeof value === "string") return `${key}: ${quote(value)}`;
    if (isStrings(value)) return `${key}: [${value.map(quote).join(", ")}]`;
    // A block sequence of *flow* mappings: one line per entry rather than one line per property,
    // which is the same YAML at a third of the tokens.
    return [`${key}:`, ...value.map((entry) => `  - { ${pairs(entry)} }`)].join("\n");
  });

  return `---\n${lines.join("\n")}\n---`;
}

/**
 * `name`, `property` and `itemprop` in one index, first occurrence winning.
 *
 * Three attributes because three vocabularies are in use on the same page and none of them won:
 * `name` for the HTML ones, `property` for Open Graph and `article:*`, `itemprop` for schema.org.
 * A page that repeats a key — `og:image` once per image is normal — is answered with the first,
 * which is the one the page put first and the one every social scraper takes.
 */
function metaIndex(root: ElementNode): Record<string, string> {
  const index: Record<string, string> = {};
  for (const tag of collect(root, "meta")) {
    const key = (tag.attrs.name ?? tag.attrs.property ?? tag.attrs.itemprop ?? "").trim().toLowerCase();
    const content = tag.attrs.content ?? "";
    if (!key || !content || index[key] !== undefined) continue;
    index[key] = content;
  }
  return index;
}

/**
 * `<link rel="…" href="…">`, first occurrence winning.
 *
 * Read from the whole tree rather than from `<head>`, like the meta tags above, because a document
 * that omits `<head>` or closes it early is normal enough that the parser has a rule for it — and a
 * `<meta>` the browser hoisted is still a `<meta>` the page wrote.
 */
function linkIndex(root: ElementNode): Record<string, string> {
  const index: Record<string, string> = {};
  for (const tag of collect(root, "link")) {
    const rel = (tag.attrs.rel ?? "").trim().toLowerCase();
    const href = tag.attrs.href ?? "";
    if (!rel || !href || index[rel] !== undefined) continue;
    index[rel] = href;
  }
  return index;
}

function pick(index: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = index[key];
    if (value?.trim()) return value;
  }
  return undefined;
}

/**
 * One line, bounded.
 *
 * Control characters become spaces rather than being deleted: a description written across three
 * indented source lines is three words run together if the newline simply disappears. See the file
 * header — this is also what stops a `content` attribute from forging frontmatter of its own.
 */
function clean(value: string, limit: number): string {
  const flat = collapse(value.replace(/[\u0000-\u001F\u007F]/g, " ")).trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit).trimEnd()}…`;
}

/**
 * The pictures inside the article, absolute and deduplicated.
 *
 * Walked rather than collected with `collect`, because the furniture rules apply here too: an avatar
 * in a sidebar and a logo in a promo box are not what the page is showing, and they are exactly what
 * a naive sweep of every `<img>` returns most of.
 *
 * The social card is excluded when it appears again in the body — it is already a field of its own,
 * and one URL twice in one block is the kind of small waste that is paid on every fetch forever.
 */
function contentImages(content: ElementNode, baseUrl: string | undefined, card: string): string[] {
  const found: string[] = [];
  const seen = new Set(card ? [card] : []);

  const walk = (node: ElementNode): void => {
    for (const child of contentChildren(node)) {
      if (child.type !== "element" || isNoise(child)) continue;
      if (child.name === "img") {
        const source = imageSource(child.attrs);
        const url = source ? unwrapImageProxy(absolutize(source, baseUrl) ?? source) : "";
        if (url && !seen.has(url) && !isTrackingPixel(child.attrs)) {
          seen.add(url);
          found.push(clean(url, LIMITS.url));
        }
      }
      if (found.length >= MAX_CONTENT_IMAGES) return;
      walk(child);
    }
  };

  walk(content);
  return found;
}

function splitKeywords(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const keyword = clean(raw, LIMITS.keyword);
    if (keyword) seen.add(keyword);
    if (seen.size >= MAX_KEYWORDS) break;
  }
  return [...seen];
}

function isStrings(value: string[] | Array<Record<string, string>>): value is string[] {
  return value.every((entry) => typeof entry === "string");
}

function pairs(entry: Record<string, string>): string {
  return Object.entries(entry).map(([key, value]) => `${key}: ${quote(value)}`).join(", ");
}

/**
 * The feeds a site declares, so "where do I subscribe" and "how do I watch this for updates" are
 * answered by reading the page rather than by guessing `/feed`.
 *
 * **`rel="alternate"` alone is not a feed.** It is also how a page declares its translations
 * (`hreflang`), its AMP copy and its print stylesheet, so the `type` is what decides: RSS, Atom, or
 * JSON Feed's own media type. `application/json` is deliberately not accepted — an alternate JSON
 * representation of a page is an API response as often as it is a feed, and a wrong entry here is
 * worse than a missing one, because the agent will go and fetch it.
 */
function feedLinks(root: ElementNode, baseUrl: string | undefined): Array<Record<string, string>> {
  const feeds: Array<Record<string, string>> = [];
  const seen = new Set<string>();

  for (const tag of collect(root, "link")) {
    if (feeds.length >= MAX_FEEDS) break;

    const rel = new Set((tag.attrs.rel ?? "").trim().toLowerCase().split(/\s+/));
    if (!rel.has("alternate") && !rel.has("feed")) continue;

    const kind = FEED_TYPES[(tag.attrs.type ?? "").trim().toLowerCase()];
    if (!kind) continue;

    const href = clean(absolutize(tag.attrs.href, baseUrl) ?? "", LIMITS.url);
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const title = clean(tag.attrs.title ?? "", LIMITS.short);
    feeds.push({ type: kind, ...(isRedundantTitle(title, kind) ? {} : { title }), url: href });
  }

  return feeds;
}

/** The three media types that mean "this is a feed". Keyed exactly; a guess here costs a wrong fetch. */
const FEED_TYPES: Record<string, string> = {
  "application/rss+xml": "rss",
  "application/atom+xml": "atom",
  "application/feed+json": "json",
  "application/rdf+xml": "rss",
};

/**
 * A title that only repeats the type it sits next to.
 *
 * `title="Atom"` beside `type: "atom"` is a word paid for twice. `title="Comments Feed"` is the
 * reason the property exists at all, so anything with a word of its own survives.
 */
function isRedundantTitle(title: string, kind: string): boolean {
  if (!title) return true;
  const words = title.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  return words.every((word) => word === kind || word === "feed" || word === "xml");
}

/**
 * Every value quoted, including the ones that look like they need no quoting.
 *
 * YAML's implicit typing is the reason. `published: 2026-08-27` parses as a date object, `lang: no`
 * parses as the boolean false, a title of `1.20` parses as a number, and any value containing `: `
 * breaks the line into a key nobody asked for. None of that matters to a model reading the block as
 * text, and all of it matters the moment something downstream parses it — so the cheap, uniform,
 * always-correct form wins over the prettier one.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
