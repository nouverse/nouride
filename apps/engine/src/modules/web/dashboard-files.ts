/**
 * The dashboard's files, and how long a browser may keep each one (E16, 2026-10-15).
 *
 * They were served with no caching headers at all — no `Cache-Control`, no `ETag`, and a conditional
 * request answered 200 — so every visit pulled the whole build again: a 905 KB script, 208 KB of CSS
 * and a 922 KB mascot, over Wi-Fi, from a Pi. Two rules fix it, because the build has two kinds of file:
 *
 * - **`assets/*` is named by its content** (`index-BOaEL47T.js`): a new build is a new name, so a copy
 *   is good forever. `immutable`, and the browser does not even ask.
 * - **Everything else keeps its name across builds** — `index.html` above all, which names the assets.
 *   `no-cache` with an `ETag`: kept, but asked about every time, and the answer is a 304 with no body
 *   unless the file changed. Stale `index.html` is how a browser runs last week's build against today's
 *   API.
 *
 * And a script or stylesheet is sent compressed when the browser accepts it (E16, 0.7.10). The build
 * writes `.br` and `.gz` beside each one (`apps/dashboard/scripts/precompress.ts`), because brotli at its
 * best is too slow to run per request on a Pi; until then the 958 KB script went over the wire raw. A
 * file with copies is answered with `Vary: Accept-Encoding` whichever one is sent, so a cache in front
 * keeps them apart, and each copy has its own `ETag`.
 *
 * Separate from `server.ts` so it can be handed a directory: the real one is found once, from a list of
 * places a build can be, and a test should not depend on whether this checkout has built the dashboard.
 */

import { resolveWithin, serveStaticFile, statFile } from "@nouride/runtime";

/** A year — what a browser treats as forever — for a file whose name changes when its bytes do. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Keep it, but ask first: a 304 costs headers, a changed file costs what it always did. */
const REVALIDATE = "no-cache";

/** The copies the build writes, in the order this server prefers them: brotli is smaller. */
const ENCODINGS = [
  { coding: "br", suffix: ".br" },
  { coding: "gzip", suffix: ".gz" },
] as const;

/** `path` is the request's (`/dashboard/…`); `ifNoneMatch` and `acceptEncoding` are its headers, when it sent them. */
export async function dashboardFile(dist: string, path: string, ifNoneMatch: string | undefined, acceptEncoding?: string): Promise<Response> {
  const relative = path.replace(/^\/dashboard\/?/, "") || "index.html";

  let target: string;
  try {
    target = resolveWithin(dist, relative);
  } catch {
    // A traversal attempt, not a missing page. Nothing to serve and nothing to say.
    return notFound();
  }

  const stat = statFile(target);
  if (stat && !stat.isDirectory) return await send(target, stat, relative.startsWith("assets/"), ifNoneMatch, acceptEncoding);

  /**
   * A build file that is not there is a 404 — never the app shell below.
   *
   * A tab opened before an upgrade asks for the old build's chunk names. Answered with `index.html` and
   * a 200, the browser refuses it as a script — and, with assets now kept for a year, could have kept
   * that HTML under the chunk's name. A 404 fails the import cleanly, which the dashboard reads as a
   * build that moved on and reloads into, once (`apps/dashboard/src/commons/lib/new-build.ts`).
   */
  if (relative.startsWith("assets/")) return notFound();

  // Client-side routes have no file on disk, so anything else unmatched falls back to index.html and
  // lets TanStack Router decide whether it is a real route.
  const index = resolveWithin(dist, "index.html");
  const indexStat = statFile(index);
  return indexStat && !indexStat.isDirectory ? await send(index, indexStat, false, ifNoneMatch, acceptEncoding) : notFound();
}

async function send(
  path: string,
  stat: { size: number; mtimeMs: number },
  hashed: boolean,
  ifNoneMatch: string | undefined,
  acceptEncoding: string | undefined,
): Promise<Response> {
  const copies = ENCODINGS.flatMap(({ coding, suffix }) => {
    const copy = statFile(`${path}${suffix}`);
    return copy && !copy.isDirectory ? [{ coding, path: `${path}${suffix}`, stat: copy }] : [];
  });
  const chosen = pickEncoding(acceptEncoding, copies.map((copy) => copy.coding));
  const sent = copies.find((copy) => copy.coding === chosen);
  const file = sent?.stat ?? stat;
  // Weak, from size and mtime: the file is the build's, and a new build rewrites it. Hashing the bytes
  // would read `index.html` on every request to answer a question its metadata already answers. The
  // coding is part of it, so a validator for one copy never revalidates another.
  const etag = `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}${sent ? `-${sent.coding}` : ""}"`;
  const headers: Record<string, string> = { "Cache-Control": hashed ? IMMUTABLE : REVALIDATE, ETag: etag };
  if (copies.length > 0) headers.Vary = "Accept-Encoding";
  if (sent) headers["Content-Encoding"] = sent.coding;
  if (matches(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return (await (sent ? serveStaticFile(sent.path, headers, path) : serveStaticFile(path, headers))) ?? notFound();
}

/**
 * The coding to send from those on disk, by the request's `Accept-Encoding` (RFC 9110 §12.5.3): the one
 * it rates highest, this server's order breaking a tie, and none when it rates them all `q=0` or sent no
 * header. `*` stands for any coding it did not name.
 */
export function pickEncoding(acceptEncoding: string | undefined, available: readonly string[]): string | null {
  if (!acceptEncoding) return null;
  const rated = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined);
    rated.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  let best: string | null = null;
  let bestQ = 0;
  for (const coding of available) {
    const q = rated.get(coding) ?? rated.get("*") ?? 0;
    if (q > bestQ) [best, bestQ] = [coding, q];
  }
  return best;
}

/** `If-None-Match` compares weakly (RFC 9110 §13.1.2): `W/` on either side does not matter, `*` matches anything. */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
