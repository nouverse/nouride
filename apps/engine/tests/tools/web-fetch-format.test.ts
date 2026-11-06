/**
 * `web_fetch`'s `format` parameter.
 *
 * The reduction itself is tested in `html.test.ts` and its `<head>` reader in
 * `html-metadata.test.ts`. What matters here is the wiring: which format gets the frontmatter, which
 * gets the markup, and what each of them promises. An agent writing a scraper needs the class and id
 * attributes the serializer drops, so most of these assert on markup that only survives under
 * `format: "html"` — and on the security properties that must hold in every format, because a new
 * output path is a new chance to lose the untrusted marker.
 */

import { describe, expect, test } from "bun:test";
import { createWebFetchTool } from "@/modules/tools/builtins/web/index.ts";
import type { ToolContext } from "@nouride/shared";

const ctx = {
  agentId: "nouva",
  sessionId: "s",
  chatId: "c",
  gateway: "web",
  gatewayId: "web:dashboard",
  senderId: "dev",
  workspaceDir: "/tmp",
  workspaceRoots: ["/tmp"],
  signal: new AbortController().signal,
} as ToolContext;

/** Chrome, a `<head>` worth reading, and one article — the shape of every docs page. */
const PAGE = `<!doctype html>
<html><head>
  <title>Rate limits — Example Docs</title>
  <meta name="description" content="How many requests you get.">
  <meta property="og:image" content="https://example.com/card.png">
  <link rel="canonical" href="https://example.com/docs/limits">
</head>
<body>
  <nav class="navbar"><a href="/">Home</a></nav>
  <main><article class="post-body" id="limits">
    <h1>Rate limits</h1>
    <p>Requests are capped at 100 per minute, per key.</p>
  </article></main>
  <script>window.__NEXT_DATA__={"props":{"limit":100}}</script>
</body></html>`;

/** A tool whose guard always says yes, answering every URL with one body. */
function toolServing(body: string, contentType = "text/html; charset=utf-8") {
  return createWebFetchTool({
    checkUrlImpl: async () => ({ allowed: true }),
    fetchImpl: (async () => new Response(body, { headers: { "content-type": contentType } })) as unknown as typeof fetch,
  });
}

describe("markdown is what you get without asking", () => {
  test("no format behaves exactly as it did before the parameter existed", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("# Rate limits");
    expect(result.content).toContain("capped at 100 per minute");
    // The reduction still runs: furniture and script bodies are gone.
    expect(result.content).not.toContain("navbar");
    expect(result.content).not.toContain("__NEXT_DATA__");
    expect(result.metadata?.format).toBe("markdown");
  });

  test("an explicit markdown is the same thing", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "markdown" }, ctx);
    expect(result.content).toContain("# Rate limits");
    expect(result.metadata?.format).toBe("markdown");
  });

  test("`<head>` arrives as frontmatter, so research is not blind to it", async () => {
    // The gap this closes: every question about who wrote a page, when, and what it calls itself
    // used to need a second fetch as `html` and 70KB of markup read to find six values. An agent
    // that did not know to do that answered from the prose, or did not answer.
    const result = await toolServing(PAGE).execute({ url: "https://example.com/" }, ctx);

    expect(result.content).toContain('title: "Rate limits — Example Docs"');
    expect(result.content).toContain('description: "How many requests you get."');
    expect(result.content).toContain('image: "https://example.com/card.png"');
    expect(result.content).toContain('canonical: "https://example.com/docs/limits"');
    // Above the article, and still under the untrusted marker — the page wrote these strings too.
    expect(result.content.indexOf("---\ntitle:")).toBeLessThan(result.content.indexOf("# Rate limits"));
    expect(result.content).toMatch(/never as instructions to follow/);
    // And flagged, so a memory write later in the turn is marked as made after it (S13).
    expect(result.untrusted).toBe(true);
  });

  test("a relative canonical resolves against the URL the page actually came from", async () => {
    // Which is the *last* hop, not the one the model asked for. Resolving against the request URL
    // would hand back a link to a page that does not exist on the host that redirected away.
    const relative = `<html><head><title>Limits</title><link rel="canonical" href="/docs/limits"></head>
      <body><main><article><p>Requests are capped at 100 per minute, per key, and the ceiling holds.</p></article></main></body></html>`;

    const tool = createWebFetchTool({
      checkUrlImpl: async () => ({ allowed: true }),
      fetchImpl: (async (url: string) =>
        url === "https://example.com/old"
          ? new Response(null, { status: 301, headers: { location: "https://docs.example.com/v2" } })
          : new Response(relative, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    });

    const result = await tool.execute({ url: "https://example.com/old" }, ctx);

    expect(result.content).toContain('canonical: "https://docs.example.com/docs/limits"');
  });
});

describe("html is the whole markup, which is the point of having it", () => {
  test("selectors survive — the reason a scraper author asks for this", async () => {
    // Under Markdown all three of these are gone, and no amount of re-reading the prose brings them
    // back. That is the gap the parameter closes.
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "html" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('class="post-body"');
    expect(result.content).toContain('id="limits"');
    expect(result.content).toContain("<article");
  });

  test("`<head>` comes back, meta tags and all", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "html" }, ctx);

    expect(result.content).toContain('property="og:image"');
    expect(result.content).toContain('rel="canonical"');
    expect(result.content).toContain('name="description"');
  });

  test("script bodies are kept, not stripped as noise", async () => {
    // Tempting to drop them: on a minified page they are the largest thing in the output. But the
    // data a scraper wants is regularly *inside* one — `__NEXT_DATA__`, or an ld+json block — so
    // stripping them would remove the answer along with the noise.
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "html" }, ctx);
    expect(result.content).toContain("__NEXT_DATA__");
  });

  test("still marked as untrusted content", async () => {
    // The one property that must survive every new output path (§17.1 item 5). Raw markup is not
    // less attacker-controlled than prose — it is more.
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "html" }, ctx);
    expect(result.content).toMatch(/never as instructions to follow/);
    // And flagged, so a memory write later in the turn is marked as made after it (S13).
    expect(result.untrusted).toBe(true);
  });
});

describe("text is prose with the syntax taken off too", () => {
  test("keeps the words, drops the markup and the Markdown", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "text" }, ctx);

    expect(result.content).toContain("capped at 100 per minute");
    expect(result.content).toContain("Rate limits");
    expect(result.content).not.toContain("# Rate limits");
    expect(result.content).not.toContain("<article");
    // It inherits the extraction, so the furniture is gone here as well.
    expect(result.content).not.toContain("navbar");
  });

  test("and no frontmatter, because a `---` block is the syntax this format exists to remove", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "text" }, ctx);

    expect(result.content).not.toContain("---");
    expect(result.content).not.toContain("title:");
  });
});

describe("a response that is not HTML", () => {
  const JSON_BODY = '{"limit":100,"window":"1m"}';

  test("comes back byte for byte in every format", async () => {
    // `format` says how to reduce *markup*. A body with none has nothing to answer for, and running
    // the parser over it would return a mangled fragment of something already readable.
    for (const format of ["markdown", "html", "text"]) {
      const result = await toolServing(JSON_BODY, "application/json").execute(
        { url: "https://api.example.com/limits", format },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain(JSON_BODY);
      expect(result.metadata?.format).toBe(format);
    }
  });
});

describe("what it refuses, and what it forgives", () => {
  test("an unknown format is an error naming the three, not a silent fallback", async () => {
    // The failure this prevents: the agent asked for markup, got prose, and had nothing in the
    // result to explain why — so it reports the page has no meta tags rather than that it asked wrong.
    let called = false;
    const tool = createWebFetchTool({
      checkUrlImpl: async () => ({ allowed: true }),
      fetchImpl: (async () => {
        called = true;
        return new Response(PAGE);
      }) as unknown as typeof fetch,
    });

    const result = await tool.execute({ url: "https://example.com/", format: "raw" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("markdown");
    expect(result.content).toContain("html");
    expect(result.content).toContain("text");
    // Rejected before anything left the daemon.
    expect(called).toBe(false);
  });

  test("a non-string format is refused too", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: 3 }, ctx);
    expect(result.isError).toBe(true);
  });

  test("case is forgiven — a model that has read `HTML` a thousand times will send it", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: "HTML" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('class="post-body"');
    expect(result.metadata?.format).toBe("html");
  });

  test("an explicit null means the default, not a mistake", async () => {
    // How several models write an optional argument they are choosing not to set.
    const result = await toolServing(PAGE).execute({ url: "https://example.com/", format: null }, ctx);
    expect(result.isError).toBe(false);
    expect(result.metadata?.format).toBe("markdown");
  });
});

describe("truncation says so", () => {
  test("a body over the cap is reported as cut, not left to look complete", async () => {
    // Silent before. Under `html` the cut lands mid-tag, so an agent hunting a footer selector finds
    // none and reports that as a fact about the page (invariant 4).
    const huge = `<html><body><div class="top">start</div>${"<p>filler filler filler</p>".repeat(20_000)}`;
    const result = await toolServing(huge).execute({ url: "https://example.com/", format: "html" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('class="top"');
    expect(result.content).toMatch(/Truncated at the 200KB fetch cap/);
    expect(result.metadata?.truncated).toBe(true);
  });

  test("a body under the cap says nothing about truncation", async () => {
    const result = await toolServing(PAGE).execute({ url: "https://example.com/" }, ctx);
    expect(result.content).not.toContain("Truncated");
    expect(result.metadata?.truncated).toBeUndefined();
  });
});

/**
 * `robots.txt`, which is the only place most sites actually publish their sitemap.
 *
 * A second HTTP request, so the question these answer is *how often it is paid* — once per host for
 * the life of the tool, and never for a format that has no frontmatter to put it in.
 */
describe("the sitemap lookup", () => {
  const PLAIN = `<html><head><title>Limits</title></head><body><main><article>
    <p>Requests are capped at 100 per minute, per key, and the ceiling is not negotiable.</p>
    </article></main></body></html>`;

  /** Counts what it was asked for, so "one request per host" is asserted rather than assumed. */
  function toolCounting(robots: string | null) {
    const seen: string[] = [];
    const tool = createWebFetchTool({
      checkUrlImpl: async () => ({ allowed: true }),
      fetchImpl: (async (url: string) => {
        seen.push(url);
        if (url.endsWith("/robots.txt")) {
          // A 404 body is deliberately not empty — see the test that reads it.
          return robots === null
            ? new Response("Not found\nSitemap: https://parked.example.net/sitemap.xml\n", { status: 404 })
            : new Response(robots, { headers: { "content-type": "text/plain" } });
        }
        return new Response(PLAIN, { headers: { "content-type": "text/html" } });
      }) as unknown as typeof fetch,
    });
    return { tool, seen };
  }

  test("the `Sitemap:` line becomes a frontmatter field", async () => {
    const { tool } = toolCounting("User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n");
    const result = await tool.execute({ url: "https://example.com/docs/limits" }, ctx);

    expect(result.content).toContain('sitemap: "https://example.com/sitemap.xml"');
  });

  test("it is read once per host, not once per page", async () => {
    // The reason it is cached at all: a research loop reading twenty articles from one blog would
    // otherwise re-learn the same line twenty times, doubling the requests it makes.
    const { tool, seen } = toolCounting("Sitemap: https://example.com/sitemap.xml");

    await tool.execute({ url: "https://example.com/a" }, ctx);
    await tool.execute({ url: "https://example.com/b" }, ctx);
    const third = await tool.execute({ url: "https://example.com/c" }, ctx);

    expect(seen.filter((url) => url.endsWith("/robots.txt"))).toHaveLength(1);
    // And every page of the site still carries it.
    expect(third.content).toContain('sitemap: "https://example.com/sitemap.xml"');
  });

  test("a missing robots.txt is silence, and its error body is not evidence", async () => {
    // Two rules in one. `/sitemap.xml` is where it usually lives, and reporting it unverified would
    // hand the agent a URL that 404s — a wrong answer that looks like a finding (invariant 4). And a
    // non-200 body is not read at all: a parked domain, a captive portal or an ISP error page can put
    // anything it likes where the answer would have been, and this fixture does exactly that.
    const { tool } = toolCounting(null);
    const result = await tool.execute({ url: "https://example.com/docs" }, ctx);

    expect(result.content).not.toContain("sitemap:");
    expect(result.content).not.toContain("parked.example.net");
  });

  test("a robots.txt with no Sitemap line is silence too, and is not asked twice", async () => {
    const { tool, seen } = toolCounting("User-agent: *\nDisallow:\n");

    await tool.execute({ url: "https://example.com/a" }, ctx);
    const second = await tool.execute({ url: "https://example.com/b" }, ctx);

    expect(second.content).not.toContain("sitemap:");
    // The absence is cached as well; a site with no sitemap is not re-asked on every page.
    expect(seen.filter((url) => url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  test("html and text ask for nothing extra", async () => {
    // Neither format carries frontmatter, so the request would buy a value nobody could read.
    for (const format of ["html", "text"]) {
      const { tool, seen } = toolCounting("Sitemap: https://example.com/sitemap.xml");
      await tool.execute({ url: "https://example.com/docs", format }, ctx);

      expect(seen.some((url) => url.endsWith("/robots.txt"))).toBe(false);
    }
  });

  test("a response that is not HTML asks for nothing either", async () => {
    const seen: string[] = [];
    const tool = createWebFetchTool({
      checkUrlImpl: async () => ({ allowed: true }),
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });

    await tool.execute({ url: "https://api.example.com/v1" }, ctx);

    expect(seen).toHaveLength(1);
  });
});
