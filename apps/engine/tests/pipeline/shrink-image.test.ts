/**
 * A smaller copy of a picture too large on a side for a model (`modules/attachments/shrink-image.ts`).
 *
 * Two halves. What the shrinker does around ffmpeg — what it asks for, what it keeps, what it refuses to hand on — is
 * tested with a stand-in that writes a file where ffmpeg would. What ffmpeg makes of the request is tested against a
 * real one, as the video split is: `NOURIDE_TEST_FFMPEG` names one, otherwise the one on PATH if it runs, and with
 * neither those cases are skipped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { runCommand, whichBinary } from "@nouride/runtime";
import { imageSize, sniffImageMime } from "@nouride/shared";
import { ImageShrinker } from "@/modules/attachments/shrink-image.ts";

const candidate = process.env.NOURIDE_TEST_FFMPEG ?? whichBinary("ffmpeg");
const works =
  candidate !== null &&
  (await runCommand([candidate, "-version"], { cwd: tmpdir(), timeoutMs: 5000, maxOutputBytes: 4096, env: {} })).exitCode === 0;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shrink-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A real PNG, `width` by `height`, of bands of colour: one a decoder reads, small on disk because it repeats. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.from(row);
    line.fill(Math.floor(y / 40) % 2 === 0 ? 0x30 : 0xd0, 1);
    rows.push(line);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

function file(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

/** Stands in for ffmpeg: writes `made` where the last argument says, and keeps what it was asked. */
function standIn(made: Buffer | null) {
  const runs: { input: string; args: string[] }[] = [];
  const run = async (_ffmpeg: string, input: string, args: string[]) => {
    runs.push({ input, args });
    if (made) writeFileSync(args.at(-1)!, made);
    return { ok: made !== null, stderr: "" };
  };
  return { runs, run };
}

describe("around ffmpeg", () => {
  const which = () => "/usr/bin/ffmpeg";

  test("asks for the picture to fit the bound on both sides, its shape kept, and hands back what was made", async () => {
    const { runs, run } = standIn(png(550, 2576));
    const path = file("chat.png", png(1280, 6000));
    const copy = await new ImageShrinker({ which, run }).shrink(path, 2576);

    expect(copy?.mimeType).toBe("image/png");
    expect(imageSize(copy!.bytes)).toEqual({ width: 550, height: 2576 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.input).toBe(path);
    const args = runs[0]!.args;
    expect(args[args.indexOf("-vf") + 1]).toBe("scale='min(2576,iw)':'min(2576,ih)':force_original_aspect_ratio=decrease");
    // One picture out of a file that may hold several: an animation's first.
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    // A screenshot stays lossless.
    expect(args.at(-1)).toEndWith("smaller.png");
    expect(args).not.toContain("-q:v");
  });

  test("a photograph stays a JPEG, and anything else becomes a PNG", async () => {
    const { runs, run } = standIn(png(10, 10));
    const shrinker = new ImageShrinker({ which, run });
    await shrinker.shrink(file("photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2])), 2576);
    await shrinker.shrink(file("sticker.gif", Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1")), 2576);
    expect(runs[0]!.args.at(-1)).toEndWith("smaller.jpg");
    expect(runs[0]!.args[runs[0]!.args.indexOf("-q:v") + 1]).toBe("3");
    expect(runs[1]!.args.at(-1)).toEndWith("smaller.png");
  });

  test("the copy is written outside the picture's folder and nothing of it is left on disk", async () => {
    const { runs, run } = standIn(png(550, 2576));
    const path = file("chat.png", png(1280, 6000));
    await new ImageShrinker({ which, run }).shrink(path, 2576);
    // An agent's workspace is where a picture it opened lives: a copy beside it would be a file in its repository.
    expect(readdirSync(dir)).toEqual(["chat.png"]);
    expect(dirname(runs[0]!.args.at(-1)!)).not.toBe(dir);
    expect(existsSync(dirname(runs[0]!.args.at(-1)!))).toBe(false);
  });

  test("made once: the next request is handed the same copy without another run", async () => {
    const { runs, run } = standIn(png(550, 2576));
    const shrinker = new ImageShrinker({ which, run });
    const path = file("chat.png", png(1280, 6000));
    const first = await shrinker.shrink(path, 2576);
    const second = await shrinker.shrink(path, 2576);
    expect(runs).toHaveLength(1);
    expect(second).toBe(first);
  });

  test("a file written again under the same name, or another bound, is another picture", async () => {
    const { runs, run } = standIn(png(100, 100));
    const shrinker = new ImageShrinker({ which, run });
    const path = file("shot.png", png(3000, 100));
    await shrinker.shrink(path, 2576);
    writeFileSync(path, png(3200, 100));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await shrinker.shrink(path, 2576);
    await shrinker.shrink(path, 1568);
    expect(runs).toHaveLength(3);
    expect(runs[2]!.args[runs[2]!.args.indexOf("-vf") + 1]).toContain("min(1568,iw)");
  });

  test("a copy that came out still too large, or as no picture, is not handed on", async () => {
    const path = file("chat.png", png(1280, 6000));
    expect(await new ImageShrinker({ which, run: standIn(png(1280, 6000)).run }).shrink(path, 2576)).toBeNull();
    expect(await new ImageShrinker({ which, run: standIn(Buffer.from("not a picture at all")).run }).shrink(path, 2576)).toBeNull();
  });

  test("a file ffmpeg cannot read is asked about once, not on every request", async () => {
    const { runs, run } = standIn(null);
    const shrinker = new ImageShrinker({ which, run });
    const path = file("broken.png", png(1280, 6000));
    expect(await shrinker.shrink(path, 2576)).toBeNull();
    expect(await shrinker.shrink(path, 2576)).toBeNull();
    expect(runs).toHaveLength(1);
  });

  test("no ffmpeg on this machine: no copy, and one installed later is found by the next request", async () => {
    const { runs, run } = standIn(png(550, 2576));
    let installed: string | null = null;
    const shrinker = new ImageShrinker({ which: () => installed, run });
    const path = file("chat.png", png(1280, 6000));
    expect(await shrinker.shrink(path, 2576)).toBeNull();
    expect(runs).toHaveLength(0);
    installed = "/usr/bin/ffmpeg";
    expect((await shrinker.shrink(path, 2576))?.mimeType).toBe("image/png");
    expect(runs).toHaveLength(1);
  });

  test("a file that is gone has no copy, and nothing is thrown", async () => {
    const { runs, run } = standIn(png(10, 10));
    expect(await new ImageShrinker({ which, run }).shrink(join(dir, "nowhere.png"), 2576)).toBeNull();
    expect(runs).toHaveLength(0);
  });

  test("what is kept has a ceiling: past it the copy longest unused is made again", async () => {
    const copy = png(200, 200);
    const { runs, run } = standIn(copy);
    // Room for two copies and not three.
    const shrinker = new ImageShrinker({ which, run, keptBytes: copy.length * 2 + 10 });
    const [a, b, c] = ["a.png", "b.png", "c.png"].map((name, index) => file(name, png(3000 + index, 10)));
    await shrinker.shrink(a!, 2576);
    await shrinker.shrink(b!, 2576);
    // Used again, so it is `b` that has waited longest.
    await shrinker.shrink(a!, 2576);
    await shrinker.shrink(c!, 2576);
    expect(runs).toHaveLength(3);
    await shrinker.shrink(a!, 2576);
    await shrinker.shrink(c!, 2576);
    expect(runs).toHaveLength(3);
    await shrinker.shrink(b!, 2576);
    expect(runs).toHaveLength(4);
  });
});

describe("with a real ffmpeg", () => {
  const ffmpeg = { which: () => candidate };

  test.skipIf(!works)("a long screenshot comes out inside the bound, its shape kept, still a PNG", async () => {
    const copy = await new ImageShrinker(ffmpeg).shrink(file("chat.png", png(1280, 6000)), 2576);
    if (!copy) throw new Error("no copy was made");
    expect(copy.mimeType).toBe("image/png");
    expect(sniffImageMime(copy.bytes)).toBe("image/png");
    const size = imageSize(copy.bytes)!;
    expect(size.height).toBe(2576);
    // 1280 x 2576 / 6000, to the pixel ffmpeg rounds to.
    expect(Math.abs(size.width - 550)).toBeLessThanOrEqual(1);
  });

  test.skipIf(!works)("a wide photograph comes out a JPEG inside the bound", async () => {
    // A JPEG made by the same ffmpeg from a PNG, so the test carries no picture of its own.
    const source = file("wide.png", png(4000, 1500));
    const photo = join(dir, "wide.jpg");
    await runCommand([candidate!, "-nostdin", "-loglevel", "error", "-y", "-i", source, photo], { cwd: dir, timeoutMs: 30_000, maxOutputBytes: 4096, env: {} });
    const copy = await new ImageShrinker(ffmpeg).shrink(photo, 2576);
    if (!copy) throw new Error("no copy was made");
    expect(copy.mimeType).toBe("image/jpeg");
    expect(imageSize(copy.bytes)).toEqual({ width: 2576, height: 966 });
  });

  test.skipIf(!works)("a file that is no picture has no copy", async () => {
    expect(await new ImageShrinker(ffmpeg).shrink(file("page.png", Buffer.from("<!DOCTYPE html><title>Just a moment...</title>")), 2576)).toBeNull();
  });
});
