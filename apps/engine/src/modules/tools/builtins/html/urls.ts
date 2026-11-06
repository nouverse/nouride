/**
 * Making the URLs in a document usable by something that is not a browser.
 *
 * A browser resolves `/docs/limits` and `../img/card.png` against the address bar without anyone
 * noticing it happened. A model reading the Markdown has no address bar: a relative href is a string
 * it cannot fetch and cannot ask about, and the two ways that failed were both silent — a link the
 * agent reported as a source and nobody could open, and an image dropped entirely because it did not
 * start with `http`.
 *
 * So every URL that leaves this directory is resolved against the URL the page was actually fetched
 * from, and the places a real page hides an image src are looked in rather than assumed absent.
 */

/** Resolved against `baseUrl`, or returned as the page wrote it when there is nothing to resolve against. */
export function absolutize(value: string | undefined, baseUrl?: string): string | undefined {
  if (!value || !baseUrl) return value;
  try {
    return new URL(value.trim(), baseUrl).toString();
  } catch {
    // A malformed href is still worth reporting as the page wrote it: it is evidence about the page.
    return value;
  }
}

/**
 * The URL an `<img>` actually points at.
 *
 * `src` is the answer on a page that has finished loading. It is regularly *not* the answer in the
 * markup a fetch receives: a lazy-loading page ships `src=""` or a 1×1 placeholder and keeps the
 * real URL in `data-src`, and a responsive one may give only `srcset`. Reading just `src` there
 * returns nothing, and nothing is indistinguishable from a page with no images.
 *
 * A `data:` URI is refused wherever it appears — tens of kilobytes of base64 that say nothing a
 * model can use, and the alt text is the part it can read.
 */
export function imageSource(attrs: Record<string, string>): string {
  const candidates = [
    attrs.src,
    attrs["data-src"],
    attrs["data-original"],
    attrs["data-lazy-src"],
    firstFromSrcset(attrs.srcset ?? attrs["data-srcset"]),
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim() ?? "";
    if (!value || value.toLowerCase().startsWith("data:")) continue;
    return value;
  }
  return "";
}

/**
 * The first candidate in a `srcset`, which is the page's own first choice.
 *
 * Not "the largest". That means parsing `480w` / `2x` descriptors, which pages get wrong often
 * enough that the sort is a guess, and the size of the image is not what the reader needs from it —
 * knowing *which* image it is, is.
 */
function firstFromSrcset(srcset: string | undefined): string {
  if (!srcset) return "";
  return srcset.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
}

/**
 * The original image behind an image proxy.
 *
 * Next.js, Vercel, Netlify and several CDNs serve every content image through a resizer that takes
 * the real URL as a query parameter — `/_next/image?url=https%3A%2F%2Fres.cloudinary.com%2F…&w=1200`.
 * Handed back as-is that is a link to a resizing endpoint on the site being read, which works today,
 * says nothing about where the image lives, and dies with the deployment.
 *
 * Judged by shape rather than by host: a `url` parameter whose value is itself an absolute http(s)
 * URL is the proxy pattern wherever it appears, and is not something a page means by accident on an
 * image source. A parameter that is anything else is left alone.
 */
export function unwrapImageProxy(value: string): string {
  if (!value.includes("url=")) return value;
  try {
    const inner = new URL(value).searchParams.get("url")?.trim() ?? "";
    return /^https?:\/\//i.test(inner) ? inner : value;
  } catch {
    return value;
  }
}

/** Below this in either declared dimension it is a spacer or a tracking pixel, not a picture. */
const MIN_IMAGE_PIXELS = 3;

/**
 * A 1×1 gif is analytics wearing an `<img>`.
 *
 * Only a *declared* size counts. An absent width or height says nothing — most real images on most
 * pages leave both off — so the rule fires on what the page asserted about itself and nowhere else.
 */
export function isTrackingPixel(attrs: Record<string, string>): boolean {
  return [attrs.width, attrs.height].some((value) => {
    const pixels = Number.parseInt(value ?? "", 10);
    return Number.isFinite(pixels) && pixels < MIN_IMAGE_PIXELS;
  });
}
