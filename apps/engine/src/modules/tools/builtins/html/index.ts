/**
 * HTML → Markdown, for a model that has to read a web page.
 *
 * The tool this replaces flattened tags to spaces. That is cheap and it works for one thing: prose
 * in a page that is mostly prose. It fails on everything the agent actually fetches — a docs page, a
 * GitHub issue, an API reference — in two expensive ways: it spent the byte budget on furniture
 * (`extract.ts`), and it threw away the structure that says what things are (`markdown.ts`).
 *
 * There is a parser here, and not a pile of regexes, because extraction needs nesting: "which
 * container holds the article" is a question about the tree. So: tokenizer, a forgiving tree, a
 * scorer, a serializer, and a reader for `<head>` — one file each, this one composing them.
 */

import { findContent } from "@/modules/tools/builtins/html/extract.ts";
import { pageHeading, renderMarkdown } from "@/modules/tools/builtins/html/markdown.ts";
import { extractMetadata, renderFrontmatter } from "@/modules/tools/builtins/html/metadata.ts";
import { parseHtml } from "@/modules/tools/builtins/html/parse.ts";

export { decodeEntities } from "@/modules/tools/builtins/html/entities.ts";
export { extractMetadata, renderFrontmatter, type MetadataField } from "@/modules/tools/builtins/html/metadata.ts";
export { parseHtml } from "@/modules/tools/builtins/html/parse.ts";

export interface MarkdownOptions {
  /**
   * Prepend the page's `<head>` metadata as YAML frontmatter.
   *
   * Off by default, and on for `web_fetch`'s `markdown` format. The two callers want opposite
   * things: an agent reading a page wants to know who wrote it and when, while `format: "text"`
   * exists precisely to hand back prose with no syntax in it, and a `---` block is syntax.
   */
  frontmatter?: boolean;
  /**
   * The URL the page was fetched from.
   *
   * Used for every URL in the output, not only the ones in `<head>`: the links and images in the
   * body are what an agent navigates by, and a relative one is a dead string to a reader with no
   * address bar. Without it they come back exactly as the page wrote them.
   */
  baseUrl?: string;
  /**
   * A sitemap URL the caller discovered outside the markup.
   *
   * Nothing in `html/` makes a request, and the place a site really publishes its sitemap is
   * `robots.txt`. `web_fetch` reads that for a root page and hands the answer in; a
   * `<link rel="sitemap">` in the document still wins.
   */
  sitemap?: string;
}

export function htmlToMarkdown(html: string, options: MarkdownOptions = {}): string {
  const root = parseHtml(html);
  const content = findContent(root);

  const body = renderMarkdown(content, options.baseUrl);
  const heading = pageHeading(root);
  const document = heading && !body.startsWith(`# ${heading}`) ? `# ${heading}\n\n${body}` : body;

  if (!options.frontmatter) return document;

  const front = renderFrontmatter(
    extractMetadata(root, { baseUrl: options.baseUrl, content, sitemap: options.sitemap }),
  );
  return front ? `${front}\n\n${document}` : document;
}
