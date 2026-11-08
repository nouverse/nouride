/**
 * HTML → Markdown.
 *
 * The tests that matter here are not "does it emit a `#`". They are the two failures the old
 * flattener had and this exists to fix: spending the byte budget on furniture, and destroying the
 * structure that tells a model what it is reading. So most of what follows is about what gets
 * *dropped*, what gets *chosen*, and the malformed markup real pages are full of.
 */

import { describe, expect, test } from "bun:test";
import { decodeEntities, htmlToMarkdown, parseHtml } from "@/modules/tools/builtins/html/index.ts";

/** A page shaped like every docs site: chrome around one article. */
const page = (article: string, extra = "") => `
<!doctype html>
<html><head><title>Rate limits — Example Docs</title></head>
<body>
  <nav class="navbar"><a href="/">Home</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a></nav>
  <div class="sidebar"><ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul></div>
  <main>${article}</main>
  <footer><p>© 2026 Example. All rights reserved.</p></footer>
  <script>const analytics = {track(){for(let i=0;i<10;i++){console.log("<div>")}}}</script>
  ${extra}
</body></html>`;

describe("what it throws away", () => {
  test("script bodies never reach the output", () => {
    // The old flattener kept them, and on a minified page they were the largest single thing in it —
    // the fetch cap then truncated the answer to make room for JavaScript.
    const md = htmlToMarkdown(page("<p>Requests are capped at 100 per minute.</p>"));

    expect(md).not.toContain("analytics");
    expect(md).not.toContain("console.log");
    expect(md).toContain("capped at 100 per minute");
  });

  test("a `<` inside a script does not derail the parse", () => {
    // `for(let i=0;i<10;i++)` looks like an open tag to anything scanning for `<`.
    const md = htmlToMarkdown(page("<p>Still here.</p>"));

    expect(md).toContain("Still here.");
  });

  test("navigation, sidebar and footer are dropped", () => {
    const md = htmlToMarkdown(page("<p>Requests are capped at 100 per minute, per key.</p>"));

    expect(md).not.toContain("Pricing");
    expect(md).not.toContain("Alpha");
    expect(md).not.toContain("All rights reserved");
  });

  test("furniture is recognised by class name, not only by tag", () => {
    const md = htmlToMarkdown(
      page(
        "<p>The documented answer, which is long enough to be scored as a real paragraph.</p>",
        '<div class="cookie-consent"><p>We value your privacy and use cookies.</p></div>',
      ),
    );

    expect(md).toContain("The documented answer");
    expect(md).not.toContain("value your privacy");
  });

  test("a comment thread is kept — on a forge it is the content", () => {
    // `comment` used to be in the noise list. It caught a blog's comment section and it also caught
    // the discussion on a GitHub issue, which is the thing an agent was sent to read.
    const md = htmlToMarkdown(
      page('<div class="comment-body"><p>The fix landed in v1.2 — see the linked PR for details.</p></div>'),
    );

    expect(md).toContain("The fix landed in v1.2");
  });

  test("hidden and aria-hidden content is dropped", () => {
    const md = htmlToMarkdown(
      page('<p>Visible.</p><div aria-hidden="true"><p>Decorative.</p></div><div hidden><p>Collapsed.</p></div>'),
    );

    expect(md).toContain("Visible.");
    expect(md).not.toContain("Decorative.");
    expect(md).not.toContain("Collapsed.");
  });
});

describe("which part of the page it picks", () => {
  test("`<main>` wins over a bigger sidebar", () => {
    // By raw character count the link column can easily beat the article. That is why the score
    // penalises anchor text instead of measuring size.
    const md = htmlToMarkdown(page("<p>The one paragraph that matters, long enough to count.</p>"));

    expect(md).toContain("The one paragraph that matters");
    expect(md).not.toContain("Beta");
  });

  test("with no <main>, the container holding the paragraphs wins", () => {
    const md = htmlToMarkdown(`<html><body>
      <div class="col"><a href="/1">One</a><a href="/2">Two</a><a href="/3">Three</a></div>
      <div class="post"><p>${"Real prose. ".repeat(20)}</p><p>${"More prose. ".repeat(20)}</p></div>
    </body></html>`);

    expect(md).toContain("Real prose.");
    expect(md).not.toContain("Three");
  });

  test("when extraction would return almost nothing, the whole body is used", () => {
    // The failure this catches: a confidently-chosen wrong container. Handing back everything is
    // worse output and a better outcome, because nothing in the text would say it picked wrong.
    const md = htmlToMarkdown("<html><body><div><span>Terse but the only thing here.</span></div></body></html>");

    expect(md).toContain("Terse but the only thing here.");
  });
});

describe("the structure it keeps", () => {
  test("headings become headings", () => {
    const md = htmlToMarkdown(page("<h2>Rate limits</h2><p>One hundred per minute.</p>"));

    expect(md).toContain("## Rate limits");
  });

  test("the page gets a title from its h1", () => {
    // `<title>` usually carries the site name too. The h1 is the part that says what this page is.
    const md = htmlToMarkdown(page("<h1>Rate limits</h1><p>One hundred per minute.</p>"));

    expect(md.startsWith("# Rate limits")).toBe(true);
    expect(md).not.toContain("Example Docs");
  });

  test("lists keep their markers and their nesting", () => {
    const md = htmlToMarkdown(
      page("<ul><li>First<ul><li>Nested</li></ul></li><li>Second</li></ul>"),
    );

    expect(md).toContain("- First");
    expect(md).toContain("  - Nested");
    expect(md).toContain("- Second");
  });

  test("an ordered list numbers from its start attribute", () => {
    const md = htmlToMarkdown(page('<ol start="3"><li>Third</li><li>Fourth</li></ol>'));

    expect(md).toContain("3. Third");
    expect(md).toContain("4. Fourth");
  });

  test("code blocks are fenced and keep their language and whitespace", () => {
    const md = htmlToMarkdown(
      page('<pre><code class="language-ts">const x = 1;\n  const y = 2;</code></pre>'),
    );

    expect(md).toContain("```ts");
    // Indentation inside `<pre>` is content. Collapsing it is how code stops being runnable.
    expect(md).toContain("  const y = 2;");
  });

  test("inline code with a backtick in it gets a longer fence", () => {
    const md = htmlToMarkdown(page("<p>Type <code>a`b</code> to continue.</p>"));

    expect(md).toContain("``a`b``");
  });

  test("links keep their target", () => {
    const md = htmlToMarkdown(page('<p>See <a href="https://example.com/docs">the docs</a> for more.</p>'));

    expect(md).toContain("[the docs](https://example.com/docs)");
  });

  test("in-page and javascript links keep the text and lose the target", () => {
    const md = htmlToMarkdown(
      page('<p>Jump to <a href="#top">the top</a> or <a href="javascript:void(0)">click</a>.</p>'),
    );

    expect(md).toContain("the top");
    expect(md).not.toContain("(#top)");
    expect(md).not.toContain("javascript:");
  });

  test("tables become pipe tables", () => {
    const md = htmlToMarkdown(
      page("<table><tr><th>Plan</th><th>Limit</th></tr><tr><td>Free</td><td>100</td></tr></table>"),
    );

    expect(md).toContain("| Plan | Limit |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Free | 100 |");
  });

  test("a pipe inside a cell is escaped rather than breaking the row", () => {
    const md = htmlToMarkdown(page("<table><tr><td>a|b</td><td>c</td></tr></table>"));

    expect(md).toContain("a\\|b");
  });

  test("an image keeps its alt text and drops a data URI", () => {
    // A data: URI is tens of kilobytes of base64 that says nothing a model can use.
    const md = htmlToMarkdown(
      page('<p><img alt="A latency graph" src="data:image/png;base64,iVBORw0KGgoAAAA"></p>'),
    );

    expect(md).toContain("![A latency graph]");
    expect(md).not.toContain("base64");
  });

  test("blockquotes are quoted", () => {
    const md = htmlToMarkdown(page("<blockquote><p>Deprecated in v3.</p></blockquote>"));

    expect(md).toContain("> Deprecated in v3.");
  });
});

describe("the markup real pages actually ship", () => {
  test("unclosed paragraphs do not swallow the rest of the document", () => {
    const md = htmlToMarkdown("<body><div><p>First<p>Second<p>Third</div></body>");

    expect(md).toContain("First");
    expect(md).toContain("Second");
    expect(md).toContain("Third");
  });

  test("unclosed list items stay separate items", () => {
    const md = htmlToMarkdown("<body><div><ul><li>One<li>Two<li>Three</ul></div></body>");

    expect(md).toContain("- One");
    expect(md).toContain("- Two");
    expect(md).toContain("- Three");
  });

  test("a stray close tag does not reparent the page", () => {
    // Extremely common, and the reason an unmatched `</div>` pops to a matching open or not at all.
    const md = htmlToMarkdown("<body><div><p>Before</p></div></div></section><p>After</p></body>");

    expect(md).toContain("Before");
    expect(md).toContain("After");
  });

  test("a `>` inside an attribute value does not end the tag early", () => {
    const md = htmlToMarkdown('<body><div><p title="a > b">Visible text</p></div></body>');

    expect(md).toContain("Visible text");
    expect(md).not.toContain("b\"");
  });

  test("an unterminated tag at the end of a truncated page does not throw", () => {
    // `web_fetch` slices at a byte cap, so the last tag is regularly cut in half.
    expect(() => htmlToMarkdown("<body><div><p>Cut off here</p><div class=\"unclosed")).not.toThrow();
  });

  test("uppercase tags and attributes are handled", () => {
    const md = htmlToMarkdown('<BODY><DIV><H2>Heading</H2><A HREF="/x">Link</A></DIV></BODY>');

    expect(md).toContain("## Heading");
    expect(md).toContain("[Link](/x)");
  });
});

describe("entities", () => {
  test("the common named ones decode", () => {
    expect(decodeEntities("a &amp; b &lt; c &gt; d &quot;e&quot; &nbsp;f&hellip;")).toBe(
      'a & b < c > d "e"  f…',
    );
  });

  test("numeric and hex references decode", () => {
    expect(decodeEntities("&#65;&#x42;&#8212;")).toBe("AB—");
  });

  test("something that is not an entity is left alone", () => {
    // A query string full of `&` is not markup, and mangling it would corrupt a URL the agent needs.
    expect(decodeEntities("?a=1&b=2&notanentity;")).toBe("?a=1&b=2&notanentity;");
  });

  test("an out-of-range code point is left as written rather than replaced", () => {
    expect(decodeEntities("&#x110000;")).toBe("&#x110000;");
  });
});

describe("the parser itself", () => {
  test("void elements do not nest what follows them", () => {
    const root = parseHtml("<div><br><span>after</span></div>");
    const div = root.children[0];

    expect(div?.type === "element" && div.children).toHaveLength(2);
  });

  test("attributes survive quoting styles and bare values", () => {
    const root = parseHtml(`<a href="/a" title='b c' target=_blank>x</a>`);
    const a = root.children[0];

    expect(a?.type === "element" && a.attrs).toMatchObject({
      href: "/a",
      title: "b c",
      target: "_blank",
    });
  });
});

describe("what it costs", () => {
  test("a realistic page comes back far smaller than its source", () => {
    // The claim the whole module rests on. Not a benchmark — a floor, so a regression that quietly
    // stops dropping furniture fails here rather than on the next invoice.
    const html = page(
      `<h1>Rate limits</h1>${"<p>Requests are capped per key and per minute.</p>".repeat(20)}`,
    );
    const md = htmlToMarkdown(html);

    expect(md.length).toBeLessThan(html.length * 0.75);
    expect(md).toContain("# Rate limits");
  });
});

/**
 * The `#` docs generators hang off every heading. Its own block because it is the single most
 * visible thing the converter got wrong against real pages, and it was invisible against handmade
 * fixtures — nobody writes a permalink anchor by hand.
 */
describe("heading permalinks", () => {
  test("an anchor marked by class is dropped", () => {
    const md = htmlToMarkdown(
      page('<h2 id="setup">Basic Setup<a href="#setup" class="anchor">#</a></h2><p>Words follow.</p>'),
    );

    expect(md).toContain("## Basic Setup");
    expect(md).not.toContain("Basic Setup#");
  });

  test("a pilcrow permalink is dropped too", () => {
    const md = htmlToMarkdown(
      page('<h2 id="x">Config<a href="#x" aria-label="Permalink">¶</a></h2><p>Words follow.</p>'),
    );

    expect(md).toContain("## Config");
    expect(md).not.toContain("¶");
  });

  test("a heading whose whole text is the anchor keeps its text", () => {
    // MDN's shape, and the regression that killed every heading on the page when this was judged by
    // class name instead of by the glyph.
    const md = htmlToMarkdown(
      page('<h2 id="status"><a href="#status" class="anchor-link">Status</a></h2><p>Words follow.</p>'),
    );

    expect(md).toContain("## Status");
  });

  test("an anchor with nothing but the glyph is dropped", () => {
    const md = htmlToMarkdown(page('<h2>Limits<a href="#limits">#</a></h2><p>Words follow.</p>'));

    expect(md).toContain("## Limits");
    expect(md).not.toContain("Limits#");
  });

  test("a real in-page link keeps its text", () => {
    // The rule is about decoration, not about in-page links — `[see below](#details)` still has
    // something to say even though the target is dropped.
    const md = htmlToMarkdown(page('<p>See <a href="#details">the details below</a> for more.</p>'));

    expect(md).toContain("the details below");
  });

  test("a language declared by attribute is used", () => {
    const md = htmlToMarkdown(page('<pre data-language="python"><code>x = 1</code></pre>'));

    expect(md).toContain("```python");
  });
});

/**
 * The links and images in the body, which are how a reader gets anywhere else.
 *
 * A browser resolves `/docs/limits` against the address bar and nobody notices. A model reading this
 * Markdown has no address bar, so a relative href is a string it cannot open and cannot ask about —
 * and it looks exactly like a working one, which is the shape of failure this repo keeps finding.
 */
describe("URLs a reader can actually follow", () => {
  const BASE = "https://example.com/docs/v2/limits";

  test("a relative link becomes absolute when the fetch URL is known", () => {
    const md = htmlToMarkdown(page('<p>See <a href="/docs/limits">the docs</a>.</p>'), { baseUrl: BASE });

    expect(md).toContain("[the docs](https://example.com/docs/limits)");
  });

  test("with no base URL it stays as the page wrote it", () => {
    // The library default. `web_fetch` always knows the URL; a caller that does not gets the page's
    // own text rather than a guess.
    const md = htmlToMarkdown(page('<p>See <a href="/docs/limits">the docs</a>.</p>'));

    expect(md).toContain("[the docs](/docs/limits)");
  });

  test("a relative image src survives instead of being thrown away", () => {
    // It used to be dropped outright — anything not starting with `http` failed the test — so a site
    // that serves its own diagrams came back as a page with alt text and no pictures.
    const md = htmlToMarkdown(page('<p><img alt="A diagram" src="../img/flow.png"></p>'), { baseUrl: BASE });

    expect(md).toContain("![A diagram](https://example.com/docs/img/flow.png)");
  });

  test("a lazy-loaded image is found where the page actually put it", () => {
    // `src=""` with the real URL in `data-src` is the standard lazy-loading shape. Reading only
    // `src` reports a page full of diagrams as a page with no images at all.
    const lazy = htmlToMarkdown(page('<p><img alt="Chart" src="" data-src="/media/chart.png"></p>'), { baseUrl: BASE });
    const responsive = htmlToMarkdown(
      page('<p><img alt="Card" srcset="/media/card-480.png 480w, /media/card-1200.png 1200w"></p>'),
      { baseUrl: BASE },
    );

    expect(lazy).toContain("![Chart](https://example.com/media/chart.png)");
    expect(responsive).toContain("![Card](https://example.com/media/card-480.png)");
  });

  test("an image proxied through a resizer comes back as the original", () => {
    // `/_next/image?url=…` is a link to a resizing endpoint on the site being read: it works today,
    // says nothing about where the image lives, and dies with the deployment.
    const md = htmlToMarkdown(
      page('<p><img alt="Flow" src="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fflow.png&w=1200"></p>'),
      { baseUrl: BASE },
    );

    expect(md).toContain("![Flow](https://cdn.example.com/flow.png)");
    expect(md).not.toContain("_next/image");
  });

  test("a 1×1 tracking pixel is not an image", () => {
    const md = htmlToMarkdown(
      page('<p>Words enough to keep this paragraph.</p><img src="https://an.example.com/p.gif" width="1" height="1" alt="">'),
      { baseUrl: BASE },
    );

    expect(md).not.toContain("p.gif");
    expect(md).toContain("Words enough");
  });
});

/**
 * Two things a handmade fixture never produces, both found by fetching a personal blog through the real
 * tool. Fixtures are written by whoever holds the assumption; a real page is not.
 */
describe("what a real page does that a fixture does not", () => {
  const BASE = "https://example.com/blog";

  test("a blur-up placeholder does not become a second copy of the picture", () => {
    // The shape: a 5%-scale blurred copy that paints immediately, then the real file, as siblings
    // with the same alt inside one wrapper. Both survived, so every picture appeared twice.
    const md = htmlToMarkdown(
      page(`<p>Prose long enough that this container is chosen as the content.</p>
        <div class="lazy-image-wrapper">
          <img src="/cdn/blur/diagram.png" alt="A flow diagram" class="lazy-image-placeholder lazy-image-blur-placeholder">
          <img src="/media/diagram.png" alt="A flow diagram" class="lazy-image lazy-image-blur" loading="lazy">
        </div>`),
      { baseUrl: BASE },
    );

    expect(md).toContain("![A flow diagram](https://example.com/media/diagram.png)");
    expect(md).not.toContain("blur/diagram.png");
    // Judged by the repeated alt, not by the class: the *real* image here is `lazy-image-blur`, so a
    // rule that matched "blur" in a class name would delete the picture and keep the thumbnail.
    expect(md.match(/A flow diagram/g)).toHaveLength(1);
  });

  test("a gallery of unlabelled thumbnails is many images, not one repeated", () => {
    // An empty alt is not a match. Otherwise a page of `alt=""` thumbnails collapses to its last one.
    const md = htmlToMarkdown(
      page(`<p>Prose long enough that this container is chosen as the content.</p>
        <div><img src="/g/1.png" alt=""><img src="/g/2.png" alt=""><img src="/g/3.png" alt=""></div>`),
      { baseUrl: BASE },
    );

    expect(md).toContain("/g/1.png");
    expect(md).toContain("/g/2.png");
    expect(md).toContain("/g/3.png");
  });

  test("a card link stays one link instead of breaking in half", () => {
    // `<a>` around a `<div>` and an `<h2>` rendered literally is `[![alt](img)\n\n## Title](url)`,
    // which is not a link: Markdown closes `[` on the same block, so the brackets become characters
    // and the URL attaches to nothing. Every card on every blog index had this shape.
    const md = htmlToMarkdown(
      page(`<p>Prose long enough that this container is chosen as the content.</p>
        <a href="/blog/agent-memory"><div><img src="/media/card.png" alt="Card"></div><h2>Agent Memory</h2></a>`),
      { baseUrl: BASE },
    );

    expect(md).toContain(
      "[![Card](https://example.com/media/card.png) Agent Memory](https://example.com/blog/agent-memory)",
    );
    expect(md).not.toContain("## Agent Memory");
  });
});
