/**
 * The line under a file sent to a chat that opens it as a page in the dashboard.
 *
 * A markdown file arrives in a chat app as a file to download and read as its source. The dashboard draws it: its
 * headings, its tables, a diagram. So the file still goes, and its caption carries the link, written here by the
 * daemon and never asked of the agent, which has no way to know the address or who may open it.
 */

/** A file written to be read as a page, by its name. */
export function readsAsPage(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

/** A caption this long may be cut by the platform it goes to: a choice, well under the shortest any of them takes. */
const LONG_CAPTION = 600;

/**
 * The caption with the link's line: under the agent's own words, or alone where it gave none. Over a long caption
 * instead: a platform that cuts a caption cuts its end, and would take the link with it.
 */
export function captionWithPage(caption: string | undefined, link: string | null): string | undefined {
  if (!link) return caption;
  const line = `Open it as a page: ${link}`;
  if (!caption) return line;
  return caption.length > LONG_CAPTION ? `${line}\n\n${caption}` : `${caption}\n\n${line}`;
}
