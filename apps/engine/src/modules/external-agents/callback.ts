/**
 * A sign-in that returns to a page on the box (0.8.1): the CLI's own sign-in sends the browser back to `127.0.0.1:<port>`
 * — a CLI's browser sign-in generally does — which, from the person's own machine, does not load. They paste the address it ended on; Nouride opens it on the box, where the CLI is waiting for it.
 *
 * Only an address the sign-in itself named as where the browser returns — in a link's `redirect_uri`, or written out —
 * and only on this machine's loopback: a pasted address is never a way to reach anything else.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ADDRESS = /https?:\/\/[^\s"'<>`]+/g;

/** `host:port` of every loopback address the sign-in printed — written out, or as a link's `redirect_uri`. */
function returnsTo(printed: string): Set<string> {
  const seen = new Set<string>();
  for (const found of printed.match(ADDRESS) ?? []) {
    let url: URL;
    try {
      url = new URL(found);
    } catch {
      continue;
    }
    const candidates = [url, ...[...url.searchParams.values()].flatMap((value) => {
      try {
        return [new URL(value)];
      } catch {
        return [];
      }
    })];
    for (const candidate of candidates) if (LOOPBACK.has(candidate.hostname)) seen.add(`${candidate.hostname === "localhost" ? "127.0.0.1" : candidate.hostname}:${candidate.port}`);
  }
  return seen;
}

/** The pasted text as the address to open on the box, or null where it is not one this sign-in returns to. */
export function returnAddress(pasted: string, printed: string): URL | null {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return null;
  }
  if (!LOOPBACK.has(url.hostname) || !["http:", "https:"].includes(url.protocol)) return null;
  const host = `${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port}`;
  return returnsTo(printed).has(host) ? url : null;
}

/** Open it on the box, as the browser would have; what came back, in a line for the sign-in's transcript. */
export async function openOnBox(url: URL, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const answer = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return `Opened the address on this box: ${answer.status}`;
  } catch (err) {
    return `Could not open the address on this box: ${err instanceof Error ? err.message : String(err)}`;
  }
}
