/**
 * Which part of the document is worth reading, and which part is furniture.
 *
 * The flattener this replaced spent the byte budget on the wrong thing. Navigation, cookie banners,
 * sidebars, footers and script bodies are most of a modern page, so a 400KB document truncated at
 * the fetch cap could be three quarters boilerplate — the answer the agent needed cut off to make
 * room for a menu. Roughly what Readability does, minus a dependency the engine's single-binary
 * build would have to carry.
 */

import { collect, findFirst, type ElementNode, type Node } from "@/modules/tools/builtins/html/parse.ts";

/**
 * Dropped outright, with everything inside them.
 *
 * Two groups. `script`/`style`/`svg`/`canvas` are never prose and are frequently the largest thing
 * on the page. `nav`/`header`/`footer`/`aside`/`form` are chrome: they are what surrounds the
 * article rather than the article, and leaving them in is what made the old output mostly menu.
 *
 * `header` is the borderline one — a page whose entire content sits in `<header>` loses it here.
 * That page is rare, and the fallback below catches the case where dropping things left nothing.
 */
const DROPPED_ELEMENTS = new Set([
  "script", "style", "noscript", "svg", "canvas", "iframe", "object", "embed",
  "form", "button", "input", "select", "textarea", "label", "fieldset",
  "nav", "header", "footer", "aside", "dialog", "template", "menu",
]);

/**
 * Class and id fragments that mark furniture.
 *
 * Every entry is a bet, and the two sides of it are not the same size. Missing something leaves a
 * cookie banner in the output; matching something wrongly deletes content the agent was sent to
 * read, with nothing in the result to say it happened. So the list stays on words that are furniture
 * wherever they appear.
 *
 * `comment` is the one that was here and is not any more. It catches a blog's comment section, and
 * it also catches the comment thread on a GitHub or Gitea issue — which is not furniture around the
 * page, it *is* the page, and it is among the most valuable things an agent ever fetches. `disqus`
 * stays because it is only ever the former.
 */
const NOISE_PATTERN =
  /(^|[\s_-])(nav|navbar|menu|sidebar|side-bar|footer|masthead|breadcrumb|cookie|consent|banner|advert|promo|share|social|subscribe|newsletter|disqus|pagination|skip-link|screen-reader|sr-only|visually-hidden)([\s_-]|$)/;

/** A `<p>` shorter than this is a caption, a byline or a button label — not evidence of an article. */
const MIN_SCORING_PARAGRAPH = 25;

/**
 * Below this, extraction is assumed to have gone wrong and the whole body is used instead.
 *
 * The failure it catches: a page that puts its article in an unremarkable `<div>` while a sidebar
 * happens to score higher. Returning the sidebar is worse than returning everything, because the
 * agent cannot tell that it was handed the wrong part.
 */
const MIN_EXTRACTED_CHARS = 200;

/**
 * The part of the document worth reading.
 *
 * `<main>` and `<article>` are believed when present, because a page that says where its content is
 * is a page that knows. Everything else is scored: text that is not inside a link, weighted up for
 * real paragraphs. The link penalty is what separates an article from a list of headlines — a
 * navigation column is nearly all anchor text, and by character count it can easily beat the article
 * it sits next to.
 */
export function findContent(root: ElementNode): ElementNode {
  const main = findFirst(root, "main") ?? largest(collect(root, "article"));
  if (main && textLength(main) >= MIN_EXTRACTED_CHARS) return main;

  const body = findFirst(root, "body") ?? root;

  let best: ElementNode | null = null;
  let bestScore = 0;
  for (const candidate of collect(body, "div", "section", "td")) {
    const score = scoreOf(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // See MIN_EXTRACTED_CHARS: handing back a confidently-chosen sidebar is worse than handing back
  // the whole page, because nothing in the output would say which happened.
  if (!best || textLength(best) < MIN_EXTRACTED_CHARS) return body;
  return best;
}

function scoreOf(element: ElementNode): number {
  const total = textLength(element);
  if (total === 0) return 0;

  const links = collect(element, "a").reduce((sum, a) => sum + textLength(a), 0);
  const paragraphs = collect(element, "p").filter((p) => textLength(p) >= MIN_SCORING_PARAGRAPH);

  // A container that is mostly link text is a menu whatever its size. Returned as zero rather than
  // as a small number so it can never win by being enormous.
  if (links / total > 0.5) return 0;

  return total - links * 3 + paragraphs.length * 100;
}

function largest(elements: ElementNode[]): ElementNode | null {
  let best: ElementNode | null = null;
  for (const element of elements) {
    if (!best || textLength(element) > textLength(best)) best = element;
  }
  return best;
}

function textLength(node: Node): number {
  if (node.type === "text") return node.value.trim().length;
  if (DROPPED_ELEMENTS.has(node.name)) return 0;
  return node.children.reduce((sum, child) => sum + textLength(child), 0);
}

/** Furniture, by tag or by what the page called it. */
export function isNoise(node: ElementNode): boolean {
  if (DROPPED_ELEMENTS.has(node.name)) return true;
  if (node.attrs.hidden !== undefined) return true;
  if (node.attrs["aria-hidden"] === "true") return true;

  const role = node.attrs.role;
  if (role === "navigation" || role === "banner" || role === "contentinfo" || role === "search") {
    return true;
  }

  const label = `${node.attrs.class ?? ""} ${node.attrs.id ?? ""}`.toLowerCase();
  return label.trim() !== "" && NOISE_PATTERN.test(label);
}

/**
 * The children worth reading, with blur-up placeholders removed.
 *
 * Found on a real page and by nothing else — every fixture here renders one `<img>` per image, and
 * a personal blog renders two: a 5%-scale blurred copy that paints immediately, then the real file, as
 * siblings with the same `alt` inside one wrapper. Both survived the reduction, so every picture
 * appeared twice in the prose and the frontmatter list was half placeholder.
 *
 * **Judged structurally, not by class name.** The obvious rule is "drop `class` containing `blur`",
 * and on this exact page the *real* image is `class="lazy-image lazy-image-blur"` — the rule would
 * delete the picture and keep the thumbnail. That is the same mistake `isPermalink` documents, one
 * page later. Identical non-empty alt text on two `<img>` siblings is what the pattern actually is,
 * whatever a site calls its CSS, and the last one is the one meant to be seen: the placeholder is
 * painted first and replaced.
 *
 * An empty alt is not a match — a gallery of `alt=""` thumbnails is many images, not one repeated.
 */
export function contentChildren(node: ElementNode): Node[] {
  const alts = new Map<string, number>();
  for (const child of node.children) {
    if (child.type !== "element" || child.name !== "img") continue;
    const alt = (child.attrs.alt ?? "").trim();
    if (alt) alts.set(alt, (alts.get(alt) ?? 0) + 1);
  }
  if ([...alts.values()].every((count) => count < 2)) return node.children;

  const remaining = new Map(alts);
  return node.children.filter((child) => {
    if (child.type !== "element" || child.name !== "img") return true;
    const alt = (child.attrs.alt ?? "").trim();
    const left = remaining.get(alt);
    if (!alt || left === undefined) return true;
    remaining.set(alt, left - 1);
    return left === 1;
  });
}
