/**
 * What a file actually is, from its first few bytes.
 *
 * Everything upstream of this trusts a *claim*. A filename's extension, a `content-type` header, a
 * platform's own guess — all three are supplied by somebody else, and one of them is supplied by a
 * model reading search results.
 *
 * The failure that put this here, in full, because every layer behaved reasonably:
 *
 *   An agent was asked to find a picture of a Shiba Inu. It searched, picked a URL ending in `.jpg`,
 *   and fetched it. The host was behind Cloudflare, so what came back was a 5,430-byte
 *   `<!DOCTYPE html><title>Just a moment...</title>` interstitial. `send_file` named it from the
 *   extension and sent it as `image/jpeg`. The chat showed a broken image. Another agent then tried
 *   to read it and the vision provider answered `400 Bad Request: Unable to process input image` —
 *   so the agent told the operator its vision model could not see the picture.
 *
 * Nobody in that chain was wrong about anything except the one fact nobody checked. Two bytes would
 * have caught it, which is the entire argument for this file.
 *
 * Deliberately small. This is not a content-type database: it answers "is this an image, and which
 * one" and "is this actually a web page", because those are the two questions that were being
 * guessed at. Anything else is `null` — unknown, not refused.
 */

/** Image formats worth recognising: what a vision API accepts, plus the two it will refuse politely. */
const IMAGE_SIGNATURES: { mimeType: string; match: (bytes: Uint8Array) => boolean }[] = [
  { mimeType: "image/png", match: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  // Every JPEG variant begins SOI + a marker. The third byte is 0xFF for JFIF, Exif and raw alike.
  { mimeType: "image/jpeg", match: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { mimeType: "image/gif", match: (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a") },
  // RIFF container with a WEBP fourcc at offset 8 — the RIFF header alone is also WAV and AVI.
  { mimeType: "image/webp", match: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") },
  { mimeType: "image/bmp", match: (b) => starts(b, [0x42, 0x4d]) },
  // ISO-BMFF brands. A HEIC and an AVIF are the same box structure with a different brand, and both
  // arrive from phones often enough to be worth naming rather than reporting as unknown binary.
  { mimeType: "image/heic", match: (b) => ascii(b, 4, "ftyp") && brandIn(b, ["heic", "heix", "hevc", "mif1"]) },
  { mimeType: "image/avif", match: (b) => ascii(b, 4, "ftyp") && brandIn(b, ["avif", "avis"]) },
];

/**
 * The image type these bytes really are, or `null`.
 *
 * `null` means "not a format this recognises", never "not an image" — an unknown signature is a
 * reason to fall back to what the file claims, not a reason to refuse it.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.match(bytes)) return signature.mimeType;
  }
  return null;
}

/**
 * Whether these bytes are a web page.
 *
 * The one negative case worth naming, because it is the one that actually happens: a fetch that was
 * meant to return a file returned a challenge page, a login wall or a 404 rendered as HTML. Saying
 * *that* to an agent is actionable — try another URL — while "unsupported image" sends it looking at
 * its own model.
 *
 * Leading whitespace and a BOM are skipped, and only the first bytes are read, so a page whose
 * `<html>` is preceded by a comment or a doctype on line two still matches.
 */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<?xml-stylesheet");
}

function starts(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.byteLength < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** The ISO-BMFF brand, which sits in the four bytes after `ftyp`. */
function brandIn(bytes: Uint8Array, brands: string[]): boolean {
  return brands.some((brand) => ascii(bytes, 8, brand));
}
