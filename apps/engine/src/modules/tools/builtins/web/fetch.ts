/**
 * `web_fetch`: one URL in, the page in the shape that was asked for out.
 *
 * Two things here are not incidental. Redirects are walked by hand so every hop is re-validated,
 * because `redirect: "follow"` hides the URL that turns a public link into `169.254.169.254`. And the
 * result carries the untrusted marker whatever the format — raw markup is not less attacker-controlled
 * than prose, it is more.
 */

import type { Tool } from "@nouride/shared";
import { checkUrl, judgedFetch, type JudgedFetch, type UrlPolicy } from "@/modules/tools/url-safety.ts";
import { htmlToMarkdown } from "@/modules/tools/builtins/html/index.ts";
import { log, UNTRUSTED_PREFIX, type WebToolOptions } from "@/modules/tools/builtins/web/shared.ts";
import { combineFetches, MAX_BATCH_URLS, parseTargets, type FetchedPage } from "@/modules/tools/builtins/web/fetch-batch.ts";

const FETCH_TIMEOUT_MS = 20_000;
/** Redirect hops followed, each re-validated. Beyond this it is a loop or a trap. */
const MAX_REDIRECTS = 5;
const MAX_FETCH_BYTES = 200 * 1024;
/** `robots.txt` is a few lines on every site that has one. Past this it is not a `robots.txt`. */
const MAX_ROBOTS_BYTES = 64 * 1024;
/** Hosts remembered for their `robots.txt` answer. Bounded because a long-running daemon is. */
const MAX_SITEMAP_HOSTS = 256;

const USER_AGENT = "Nouride/0.1 (+https://nouverse.tech)";

/**
 * What `web_fetch` hands back, and why there is a choice at all.
 *
 * Markdown is the default because it is what a model reading a page wants: `htmlToMarkdown` throws
 * away navigation and script bodies, which is most of the bytes and none of the answer. That
 * reduction is lossy on purpose, and twice it was the wrong trade — an agent asked to write a
 * scraper needs the class and id attributes the serializer drops, and one asked about a page's
 * `og:image` or `canonical` needed `<meta>` tags that never left `<head>`.
 *
 * The second of those is no longer a reason to leave Markdown. `<head>` is not discarded any more:
 * the tags that say what the document *is* come back as YAML frontmatter above the body, so the
 * common questions — who wrote this, when, what does it claim to be, where is the canonical copy —
 * are answered in the default format for about a hundred tokens. `html` stays the answer for
 * everything else in there, which is most of it by count and none of it by usefulness.
 *
 * The URLs *inside* the page are part of the same problem and are fixed by the same argument. A
 * relative `href` or `src` is a dead string to a reader with no address bar, and it looks exactly
 * like a working one; the fetch URL is known here and nowhere downstream, so every link and image in
 * the body is resolved against it before it leaves.
 *
 * `text` is the shape from before `web_fetch` returned Markdown, kept for the case where Markdown punctuation is itself the noise. It
 * gets no frontmatter: a `---` block is exactly the syntax that format exists to remove.
 */
const FETCH_FORMATS = ["markdown", "html", "text"] as const;
type FetchFormat = (typeof FETCH_FORMATS)[number];

export function createWebFetchTool(options: WebToolOptions = {}): Tool {
  // From the addresses the check judged, never from a second lookup of the name (S12).
  const doFetch = judgedFetch(options.fetchImpl);

  /**
   * `robots.txt` answers per host, kept for the life of this tool.
   *
   * Held here rather than at module scope on purpose: a module-level cache is shared by every tool
   * any test builds, so one test's "this host has no sitemap" becomes another's answer — the same
   * shape of cross-contamination that once cost a day with shared fixture directories, when the suite
   * could not survive being run twice at once.
   */
  const sitemaps = new Map<string, Promise<string | undefined>>();

  const tool: Tool = {
    requiresApproval: false,
    // Fetching a URL cannot interfere with fetching another. Four pages at once is the point.
    parallelSafe: true,
    definition: {
      name: "web_fetch",
      description:
        "Fetch a URL and return its content. By default HTML comes back as Markdown (navigation, " +
        "scripts and footers removed; headings, lists, links, code blocks and tables kept) under a " +
        "YAML frontmatter block of the page's `<head>` metadata: title, description, author, dates, " +
        "canonical, og:image, keywords, the pictures the article shows, and the site's declared " +
        "feeds and sitemap. Set " +
        '`format: "html"` when you need the markup itself rather ' +
        "than the prose: the class and id attributes a scraper selects on, or a `<meta>`, `<link>` " +
        'or `ld+json` the frontmatter does not carry. `format: "text"` is that prose alone, without ' +
        "frontmatter or Markdown syntax. A response that is not HTML (JSON, plain text, CSV) is " +
        "returned as it arrived whatever the format. Only http and https are allowed.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL" },
          urls: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_BATCH_URLS,
            description:
              `Several URLs, fetched at the same time in one call (up to ${MAX_BATCH_URLS}). Prefer this ` +
              "whenever you want more than one page: after a search, read the sources you picked " +
              "together, not one per reply. Use this or `url`, not both.",
          },
          format: {
            type: "string",
            enum: [...FETCH_FORMATS],
            description:
              'Output format, "markdown" by default: the readable page with its `<head>` metadata ' +
              'as frontmatter. "html" is the raw markup: selectors, every meta tag, embedded JSON. ' +
              '"text" is prose with no markup, frontmatter or Markdown syntax.',
          },
        },
      },
    },

    async execute(args, ctx) {
      const targets = parseTargets(args.url, args.urls);
      if (typeof targets === "string") return { content: targets, isError: true };

      const format = parseFormat(args.format);
      if (format === null) {
        return {
          content: `\`format\` must be one of ${FETCH_FORMATS.join(", ")}. Omit it for markdown.`,
          isError: true,
        };
      }

      if (targets.batch) {
        const ms: number[] = [];
        const pages = await Promise.all(
          targets.urls.map(async (url, index) => {
            const startedAt = performance.now();
            const page = await fetchOne(url, format);
            ms[index] = Math.round(performance.now() - startedAt);
            return page;
          }),
        );
        return combineFetches(targets.urls, pages, ctx.resultChars, ms);
      }
      const page = await fetchOne(targets.urls[0]!, format);
      if (!page.ok) return { content: page.error, isError: true };
      return {
        content: `${UNTRUSTED_PREFIX}\n\n${page.text}`,
        untrusted: true,
        isError: false,
        metadata: page.metadata,
      };
    },
  };

  /**
   * One URL, start to finish. Never throws: a batch reports each page's failure beside the others.
   */
  async function fetchOne(url: string, format: FetchFormat): Promise<FetchedPage> {
    const check = options.checkUrlImpl ?? checkUrl;
    const policy = options.urlPolicy ?? { allowPrivate: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      let target = url;
      let res: Response | undefined;

      // Redirects are followed by hand so every hop is validated. `redirect: "follow"` hides the
      // intermediate URLs, which makes a public URL that 302s to 169.254.169.254 indistinguishable
      // from a normal fetch.
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const verdict = await check(target, policy);
        if (!verdict.allowed) {
          return {
            ok: false,
            error:
              hop === 0
                ? `Refused: ${verdict.reason}.`
                : `Refused after ${hop} redirect(s): ${verdict.reason}.`,
          };
        }

        res = await doFetch(
          target,
          {
            signal: controller.signal,
            headers: { "user-agent": USER_AGENT, accept: "text/*, */*" },
            redirect: "manual",
          },
          verdict.addresses ?? [],
        );

        if (res.status < 300 || res.status >= 400) break;

        const location = res.headers.get("location");
        if (!location) break;
        target = new URL(location, target).toString();
        res = undefined;
      }

      if (!res) {
        return { ok: false, error: `Too many redirects (over ${MAX_REDIRECTS}).` };
      }
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} from ${new URL(target).host}` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const truncated = body.length > MAX_FETCH_BYTES;
      const raw = truncated ? body.slice(0, MAX_FETCH_BYTES) : body;

      // One `robots.txt` per host for the life of this tool — see `sitemapForHost`.
      const sitemap =
        format === "markdown" && contentType.includes("html")
          ? await sitemapForHost(sitemaps, target, doFetch, check, policy, controller.signal)
          : undefined;

      const text = renderBody(raw, contentType, format, target, sitemap);

      /**
       * Said out loud, rather than left for the model to notice.
       *
       * The cap has always cut silently, and under Markdown that mostly reads as a page ending
       * early. Under `html` it is worse: the cut lands mid-tag, so an agent looking for a footer
       * selector or a closing `</html>` finds neither and concludes the page does not have one —
       * a wrong answer that looks like a finding (invariant 4).
       */
      const note = truncated
        ? `\n\n[Truncated at the ${MAX_FETCH_BYTES / 1024}KB fetch cap: this is the start of the document, not all of it.]`
        : "";

      return {
        ok: true,
        text: `Source: ${target}\n\n${text}${note}`,
        metadata: { url: target, contentType, bytes: raw.length, format, ...(truncated ? { truncated } : {}) },
      };
    } catch (err) {
      const aborted = controller.signal.aborted;
      log.warn("web_fetch failed", { error: String(err) });
      return {
        ok: false,
        error: aborted ? `Timed out after ${FETCH_TIMEOUT_MS}ms.` : `Fetch failed: ${String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return tool;
}

/**
 * The requested format, or `null` for a value that is not one.
 *
 * Refused rather than guessed. An unrecognised format quietly falling back to Markdown is the worst
 * of the three outcomes: the agent asked for markup, got prose, and has nothing in the result saying
 * why — so it reports that the page has no `<meta>` tags instead of that it asked wrong.
 *
 * Two spellings are accepted anyway, because neither is ambiguous. Case, since a model that has read
 * `"HTML"` in a hundred docs pages will send it; and `null`, which is how several of them write an
 * optional argument they are choosing not to set.
 */
function parseFormat(value: unknown): FetchFormat | null {
  if (value === undefined || value === null) return "markdown";
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (FETCH_FORMATS as readonly string[]).includes(normalized) ? (normalized as FetchFormat) : null;
}

/**
 * The fetched body in the shape that was asked for.
 *
 * Only HTML has anything to reduce, so everything else comes back untouched in all three formats.
 * That is not a shortcut: running the markup parser over JSON or a CSV would find no content
 * container, score nothing, and hand back a mangled fragment of a file that was already readable.
 * `format` says how to *reduce markup*, and a response with no markup has nothing to answer for.
 */
function renderBody(
  raw: string,
  contentType: string,
  format: FetchFormat,
  url: string,
  sitemap?: string,
): string {
  if (format === "html" || !contentType.includes("html")) return raw;
  // The URL is the *final* one, after the redirect walk, which is the only base a relative
  // `canonical` or `og:image` in this document can correctly resolve against.
  return format === "text"
    ? htmlToText(raw)
    : htmlToMarkdown(raw, { frontmatter: true, baseUrl: url, sitemap });
}

/**
 * The host's sitemap, asked for once and remembered.
 *
 * A sitemap is a fact about a **site**, not about a page, and `robots.txt` is a second HTTP request
 * rather than a tag in the document — so the question is how often to pay for it. Per fetch would
 * double the request count of a research loop reading twenty articles from one blog to re-learn the
 * same line twenty times. Only for the front page — which is what this did first — answers nothing
 * for `https://gading.dev/en/`, where the front page of a localised site is one path segment down
 * and the agent lands there.
 *
 * So: once per host, cached with the answer *and* the absence, and the site's pages all carry it
 * afterwards. The cache holds a promise rather than a value so two fetches racing on the same host
 * make one request, not two.
 *
 * It is not invalidated. A site that publishes a sitemap after this daemon started will not show one
 * until it restarts, which is the right trade for a file that changes about never.
 */
function sitemapForHost(
  cache: Map<string, Promise<string | undefined>>,
  target: string,
  doFetch: JudgedFetch,
  check: typeof checkUrl,
  policy: UrlPolicy,
  signal: AbortSignal,
): Promise<string | undefined> {
  let host: string;
  try {
    host = new URL(target).host;
  } catch {
    return Promise.resolve(undefined);
  }

  const known = cache.get(host);
  if (known) return known;

  // Bounded, oldest out first. A daemon that fetches ten thousand hosts should not carry ten
  // thousand strings for the rest of its life; every bounded table in this repo got here the hard way.
  if (cache.size >= MAX_SITEMAP_HOSTS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  const answer = sitemapFromRobots(target, doFetch, check, policy, signal);
  cache.set(host, answer);
  return answer;
}

/**
 * The `Sitemap:` line in `robots.txt`.
 *
 * `<link rel="sitemap">` is valid and almost nobody writes it; `robots.txt` is where sites actually
 * publish the answer.
 *
 * Deliberately unforgiving: one request, no redirect walk, 200 only, and a cap on how much is read.
 * A failure is silence — no field. A sitemap this could not confirm is not worth reporting as one,
 * and a guessed `/sitemap.xml` would be a URL the agent fetches and finds missing (invariant 4).
 */
async function sitemapFromRobots(
  target: string,
  doFetch: JudgedFetch,
  check: typeof checkUrl,
  policy: UrlPolicy,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const robots = new URL("/robots.txt", target).toString();
    // Same host as a URL already allowed, and validated again anyway: the guard is cheap and a
    // second entry point that skips it is how the first one stops being a guard.
    const verdict = await check(robots, policy);
    if (!verdict.allowed) return undefined;

    const res = await doFetch(
      robots,
      { signal, headers: { "user-agent": USER_AGENT, accept: "text/plain, */*" }, redirect: "manual" },
      verdict.addresses ?? [],
    );
    if (res.status !== 200) return undefined;

    const text = (await res.text()).slice(0, MAX_ROBOTS_BYTES);
    const match = /^\s*sitemap\s*:\s*(\S+)\s*$/im.exec(text);
    const declared = match?.[1];
    if (!declared) return undefined;

    // Reported as the file wrote it, resolved against the site. Not fetched — if the agent follows
    // it, that goes through `checkUrl` like any other URL it decides to open.
    return new URL(declared, robots).toString();
  } catch {
    return undefined;
  }
}

/**
 * A page as flat prose: no tags, and none of the Markdown that replaced them.
 *
 * Derived from the Markdown rather than from the HTML, so it inherits the extraction — the
 * navigation and script bodies are already gone before the syntax is stripped. It is what `web_fetch`
 * did before it returned Markdown, and what it does again under `format: "text"`, for the case where the punctuation is
 * itself the noise: feeding the page to something that counts words, or reading prose that has no
 * structure worth keeping.
 */
function htmlToText(html: string): string {
  return htmlToMarkdown(html)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[a-z0-9+#]*\n?/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>|]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
