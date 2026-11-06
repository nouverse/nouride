/**
 * Recognising a file by its bytes, which is the one thing nothing upstream of it does.
 *
 * The bug that put this here: an agent asked to find a photo of a Shiba Inu searched, picked a URL
 * ending in `.jpg`, and fetched a Cloudflare `Just a moment...` interstitial. `send_file` named the
 * file from the extension and sent 5,430 bytes of HTML as `image/jpeg`. The chat showed a broken
 * image, the operator was told it had been sent, and the next agent to open it got
 * `400 Unable to process input image` from the provider — and reported that its *vision model* could
 * not see the picture. Every layer trusted a claim; two bytes would have caught it.
 *
 * So the assertions worth having are the two directions of getting it wrong: a real image whose name
 * lies must still be recognised, and a web page wearing an image's name must be caught.
 */

import { describe, expect, test } from "bun:test";
import { looksLikeHtml, sniffImageMime } from "../src/media.ts";
import { formatBytes } from "../src/bytes.ts";

/** The real header bytes, since a signature test that invents them tests nothing. */
const HEADERS: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46],
  "image/gif": [...Buffer.from("GIF89a"), 0x01, 0x00],
  "image/webp": [...Buffer.from("RIFF"), 0x24, 0x00, 0x00, 0x00, ...Buffer.from("WEBP")],
  "image/bmp": [0x42, 0x4d, 0x36, 0x00, 0x00, 0x00],
  "image/heic": [0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftyp"), ...Buffer.from("heic")],
  "image/avif": [0x00, 0x00, 0x00, 0x1c, ...Buffer.from("ftyp"), ...Buffer.from("avif")],
};

describe("what an image really is", () => {
  for (const [mimeType, header] of Object.entries(HEADERS)) {
    test(`${mimeType} is recognised from its signature`, () => {
      expect(sniffImageMime(new Uint8Array(header))).toBe(mimeType);
    });
  }

  test("an unknown signature is null, which means fall back rather than refuse", () => {
    // `null` must not read as "not an image": a format this does not know is a reason to trust what
    // the file claims, not a reason to throw the file away.
    expect(sniffImageMime(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });

  test("a RIFF container that is not WEBP is not claimed as one", () => {
    // A WAV starts `RIFF` too, and matching on that alone would report every voice note as an image.
    const wav = new Uint8Array([...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WAVE")]);
    expect(sniffImageMime(wav)).toBeNull();
  });

  test("a truncated header does not match on a prefix", () => {
    // Two bytes of a PNG signature are not a PNG, and reading past the end must not throw either.
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("a web page wearing a file's name", () => {
  test("the actual Cloudflare interstitial is caught", () => {
    const page = new TextEncoder().encode(
      '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>',
    );
    expect(looksLikeHtml(page)).toBe(true);
  });

  test("leading whitespace and a BOM do not hide it", () => {
    expect(looksLikeHtml(new TextEncoder().encode("\n\n  <html><body>nope</body></html>"))).toBe(true);
    expect(looksLikeHtml(new TextEncoder().encode("﻿<!doctype html>"))).toBe(true);
  });

  test("a real image is not mistaken for one", () => {
    // The important negative: this gate refuses a send, so a false positive would block a working
    // photo. Binary bytes that happen to decode into something odd must not trip it.
    for (const header of Object.values(HEADERS)) {
      expect(looksLikeHtml(new Uint8Array(header))).toBe(false);
    }
  });

  test("plain text and JSON are not called HTML", () => {
    // Only the case that actually happens is named. A log or a JSON body is a legitimate attachment
    // and has to keep being sendable.
    expect(looksLikeHtml(new TextEncoder().encode("ECONNREFUSED 5432\n"))).toBe(false);
    expect(looksLikeHtml(new TextEncoder().encode('{"ok":true}'))).toBe(false);
  });
});

describe("one answer per number", () => {
  /**
   * There were seven copies of this function and four stopped at megabytes, so a 2GB file read
   * `2048.0MB` in four places and `2.0 GB` in the CLI. The gigabyte case is the whole reason this
   * has a test: everything below it already agreed.
   */
  test("gigabytes are gigabytes, which is what four copies got wrong", () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0GB");
    expect(formatBytes(1024 ** 3)).toBe("1.0GB");
    // Just under the boundary stays in megabytes rather than rounding into "1.0GB".
    expect(formatBytes(1024 ** 3 - 1)).toBe("1024.0MB");
  });

  test("the spellings already pinned elsewhere are unchanged", () => {
    // `packages/gateways/tests/attachments.test.ts` and the prompt text an agent reads back both
    // assert this compact form, so unifying could not change it.
    expect(formatBytes(500)).toBe("500B");
    expect(formatBytes(2048)).toBe("2KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
    expect(formatBytes(234 * 1024)).toBe("234KB");
  });

  test("nonsense in gives something printable out", () => {
    // A size that arrived as NaN from a platform header used to render "NaNB" into a chat message.
    expect(formatBytes(Number.NaN)).toBe("0B");
    expect(formatBytes(-1)).toBe("0B");
    expect(formatBytes(0)).toBe("0B");
  });
});
