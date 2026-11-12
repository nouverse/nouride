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
import { imageSize, looksLikeHtml, sniffImageMime } from "../src/media.ts";
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

describe("how large a picture is, from its header", () => {
  const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "hex"));

  /**
   * The first bytes of real files, each 300 pixels wide and 200 high: a PNG and a GIF, a JPEG written by a phone
   * maker's encoder (three segments of metadata before its frame header), and WebP's three kinds from `cwebp`.
   */
  const REAL: Record<string, string> = {
    png: "89504e470d0a1a0a0000000d494844520000012c000000c80802000000ddbd4b02",
    gif: "4749463837612c01c800d50000",
    jpeg:
      "ffd8ffe000104a46494600010100004800480000ffe1004c4578696600004d4d002a00000008000187690004000000010000001a000000000003a00100030000000100010000" +
      "a0020004000000010000012ca003000400000001000000c800000000ffed003850686f746f73686f7020332e30003842494d04040000000000003842494d0425000000000010" +
      "d41d8cd98f00b204e9800998ecf8427effc000110800c8012c03012200021101031101",
    "webp, lossy": "52494646a2020000574542505650382096020000b020009d012a2c01c800",
    "webp, lossless": "5249464646000000574542505650384c3a0000002f2bc13100b98ce87fec",
    "webp, with transparency": "52494646ce02000057454250565038580a000000100000002b0100c70000",
  };

  for (const [format, header] of Object.entries(REAL)) {
    test(`${format}: 300 by 200`, () => {
      expect(imageSize(hex(header))).toEqual({ width: 300, height: 200 });
    });
  }

  test("a tall screenshot is as tall as its header says, far past two bytes", () => {
    // A PNG's sizes are four bytes each: a chat exported as one picture is tens of thousands of pixels high.
    expect(imageSize(hex("89504e470d0a1a0a0000000d49484452 00000500 00011170 0802000000"))).toEqual({ width: 1280, height: 70_000 });
  });

  test("a JPEG's size is its own frame header's, not the one inside a thumbnail", () => {
    // An Exif segment that carries a whole small JPEG, frame header and all, then a table, fill bytes, and the
    // picture's own header, progressive. Searched for the bytes of a frame header, the thumbnail's would be found.
    const thumbnail = "ffd8ffc0001108007800a003012200021101031101ffd9";
    const exif = `ffe1${(2 + thumbnail.length / 2).toString(16).padStart(4, "0")}${thumbnail}`;
    const table = "ffdb0005000102";
    // Three markers that sit among the frame headers' numbers and are tables or an extension, each before the frame.
    const notFrames = "ffc40005000102" + "ffc800040000" + "ffcc00040000";
    const frame = "ffffffc200110810001800030122000211010311 01";
    expect(imageSize(hex(`ffd8${exif}${table}${notFrames}${frame}`))).toEqual({ width: 6144, height: 4096 });
  });

  test("nothing after a JPEG's picture data is read as its header", () => {
    // The scan's own header, then bytes shaped like a frame header where the picture's data is: no size, not that one.
    expect(imageSize(hex("ffd8ffe000104a46494600010100004800480000" + "ffda000c03010002110311003f00" + "ffc000110800010001030122000211010311 01"))).toBeNull();
    // And nothing after its end, read as a segment or not.
    expect(imageSize(hex("ffd8" + "ffd9" + "00040000" + "ffc000110800010001030122000211010311 01"))).toBeNull();
  });

  test("a header cut short, or one that is not as its format says, has no size: unknown, not zero", () => {
    expect(imageSize(hex(REAL.png!).subarray(0, 20))).toBeNull();
    expect(imageSize(hex(REAL.gif!).subarray(0, 8))).toBeNull();
    expect(imageSize(hex(REAL.jpeg!).subarray(0, 160))).toBeNull();
    expect(imageSize(hex(REAL["webp, lossy"]!).subarray(0, 26))).toBeNull();
    // A PNG whose first chunk is not its header, a lossy WebP without its start code, a lossless one without its mark.
    expect(imageSize(hex(REAL.png!.replace("49484452", "74455874")))).toBeNull();
    expect(imageSize(hex(REAL["webp, lossy"]!.replace("9d012a", "000000")))).toBeNull();
    expect(imageSize(hex(REAL["webp, lossless"]!.replace("2f2bc1", "002bc1")))).toBeNull();
    // A JPEG that reaches its picture data, or a segment with no length, before any frame header.
    expect(imageSize(hex("ffd8ffe000104a46494600010100004800480000ffda000c03010002110311003f00"))).toBeNull();
    expect(imageSize(hex("ffd8ffe00000ffc000110800c8012c03012200021101031101"))).toBeNull();
    // Sizes of nothing.
    expect(imageSize(hex("89504e470d0a1a0a0000000d4948445200000000000000c80802000000ddbd4b02"))).toBeNull();
  });

  test("a file that is not one of the four has no size", () => {
    expect(imageSize(new Uint8Array(HEADERS["image/bmp"]!))).toBeNull();
    expect(imageSize(new Uint8Array(HEADERS["image/heic"]!))).toBeNull();
    expect(imageSize(new TextEncoder().encode("<!DOCTYPE html><title>Just a moment...</title>"))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
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
