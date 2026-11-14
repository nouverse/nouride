/**
 * A file on disk answered to a browser: the name it is saved under, made safe for a header, and its bytes whole or by
 * the range a player asks for. The chat's attachments and System's Files both hand files over, and a `<video>` reads
 * the same headers from each.
 */

import { readFileBody, readFileRange } from "@nouride/runtime";

/**
 * A filename safe to put in a header.
 *
 * A header value cannot carry a quote or a newline without changing what the header means, and the
 * name came from a chat platform or a browser — neither of which promises anything about it.
 */
export function asciiName(name: string): string {
  const cleaned = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return cleaned.trim() || "file";
}

/**
 * The byte window a `Range` header asks for, resolved against the real file size.
 *
 * Returns `null` when there is no usable range and the whole file should be sent — which includes the
 * multi-range form (`bytes=0-99,200-299`). Ignoring a range is explicitly allowed; answering one with
 * a body that is not what it asked for is not, and a media element resyncs from a 200 without
 * complaint. No media element sends a multi-range request anyway.
 *
 * `"unsatisfiable"` is the third outcome and it is separate on purpose: a start past the end of the
 * file is a 416 carrying the true size, not a silent full-body 200 the client will mis-parse as the
 * tail it asked for.
 *
 * Both ends are **inclusive**, as HTTP defines them. Three forms exist and the third is the one that
 * gets forgotten: `bytes=-500` means the *last* 500 bytes, not "from 0 to 500".
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  // A zero-length file can satisfy no range at all, and the arithmetic below would produce -1.
  if (size === 0) return "unsatisfiable";

  let start: number;
  let end: number;

  if (!rawStart) {
    // Suffix form: the last N bytes, clamped to the whole file when N is larger than it.
    const suffix = Number.parseInt(rawEnd!, 10);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    // An absent or oversized end means "to the end of the file" — `bytes=0-` is what Chrome opens with.
    end = rawEnd ? Math.min(Number.parseInt(rawEnd, 10), size - 1) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "unsatisfiable";
  }
  return { start, end };
}

/**
 * `path`'s bytes: all of them, or the range `asked` names (206), or a 416 that carries the true size where the range
 * starts past the file's end, since a client has no other way to correct its request.
 *
 * `accept-ranges` is said whether or not a range was asked for: a `<video>` decides how to load, and on Safari whether
 * to play at all, from this header on the first response. Streamed even when whole: nothing on this path holds a large
 * file in memory, and a request with no `Range` is the one that would hold the largest.
 */
export function fileResponse(path: string, size: number, asked: string | undefined, headers: Record<string, string>): Response {
  const all = { ...headers, "accept-ranges": "bytes" };
  const range = parseRange(asked, size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...all, "content-range": `bytes */${size}` } });
  if (range) {
    return new Response(readFileRange(path, range.start, range.end + 1), {
      status: 206,
      headers: { ...all, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${size}` },
    });
  }
  return new Response(readFileBody(path), { headers: { ...all, "content-length": String(size) } });
}
