/**
 * Files arriving from a browser, and the boundary that makes their paths trustworthy.
 *
 * The interesting half is not the writing — it is that `/chat/send` takes a *path* from a client. That
 * is safe only because two things hold: a name from a browser cannot escape the directory, and a path
 * from anywhere but that directory is refused. Both are pinned here, because the failure is not a
 * visible bug — it is a dashboard account reading `/etc/shadow` through an agent, quietly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileExistsSync, readFileBytes, removePath } from "@nouride/runtime";
import { parseAttachments } from "@/modules/web/control/payloads.ts";
import { refuseUpload, safeFileName, UploadStore } from "@/modules/web/control/uploads.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let uploads: UploadStore;

beforeEach(() => {
  dir = tempDir("uploads");
  uploads = new UploadStore(join(dir, "uploads"));
});

afterEach(() => removePath(dir));

describe("a filename from a browser", () => {
  test("cannot climb out of the directory", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    // Backslashes too: `basename` does not treat them as separators on Linux, and a multipart part
    // header is just a string — whatever the client felt like sending.
    expect(safeFileName("..\\..\\windows\\system32\\config")).toBe("config");
    expect(safeFileName("/absolute/path/report.pdf")).toBe("report.pdf");
  });

  test("keeps enough of the name to be recognisable", () => {
    expect(safeFileName("Screenshot 2026-09-01 at 19.10.44.png")).toBe(
      "Screenshot 2026-09-01 at 19.10.44.png",
    );
    expect(safeFileName("laporan (final).docx")).toBe("laporan (final).docx");
  });

  test("survives a name made entirely of things it strips", () => {
    // A name is not optional downstream — the prompt says what arrived — so this cannot return "".
    expect(safeFileName("../../")).toBe("file");
    expect(safeFileName("...")).toBe("file");
    expect(safeFileName("")).toBe("file");
  });

  test("has no shell metacharacters left in it", () => {
    // The path reaches the agent, which owns a shell. Nothing here should need quoting to be safe,
    // and a name that does is a name somebody will forget to quote.
    const name = safeFileName("a;rm -rf /`whoami`$(id)&&x|y'z\".png");
    expect(name).not.toMatch(/[;`$&|'"<>*?]/);
  });
});

describe("what is too big", () => {
  const oneMb = 1024 * 1024;

  test("is refused with both numbers in the sentence", () => {
    const refusal = refuseUpload({ name: "video.mp4", size: 30 * oneMb }, 20 * oneMb);
    expect(refusal).toContain("30MB");
    expect(refusal).toContain("20MB");
  });

  test("an empty file is refused too, by name", () => {
    expect(refuseUpload({ name: "notes.txt", size: 0 }, oneMb)).toContain("notes.txt");
  });

  test("and a file within the limit is accepted", () => {
    expect(refuseUpload({ name: "shot.png", size: oneMb }, 20 * oneMb)).toBeNull();
  });
});

describe("the directory boundary", () => {
  test("accepts a path this store wrote", async () => {
    const stored = await uploads.save({
      name: "shot.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(uploads.holds(stored.path)).toBe(true);
    expect(await readFileBytes(stored.path)).toEqual(new Uint8Array([1, 2, 3]));
    // The stored name carries an id *and* the original name: an id alone makes a directory nobody
    // can reason about, and the agent is about to be handed this path.
    expect(stored.path).toContain("shot.png");
    expect(stored.name).toBe("shot.png");
  });

  test("refuses everything else", () => {
    // This is the check that stands between a dashboard account and every file this daemon can read.
    expect(uploads.holds("/etc/shadow")).toBe(false);
    expect(uploads.holds("")).toBe(false);
    expect(uploads.holds(uploads.dir)).toBe(false);
    expect(uploads.holds(`${uploads.dir}/`)).toBe(false);
    // A path that starts with the right prefix but reaches deeper, or sideways.
    expect(uploads.holds(`${uploads.dir}/sub/file.png`)).toBe(false);
    expect(uploads.holds(`${uploads.dir}/../../etc/passwd`)).toBe(false);
    expect(uploads.holds(`${uploads.dir}-elsewhere/file.png`)).toBe(false);
  });

  test("two files with the same name do not collide", async () => {
    const first = await uploads.save({ name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    const second = await uploads.save({ name: "a.png", mimeType: "image/png", bytes: new Uint8Array([2]) });

    expect(first.path).not.toBe(second.path);
    expect(await readFileBytes(first.path)).toEqual(new Uint8Array([1]));
  });
});

describe("an upload as an attachment", () => {
  test("is classified the way every other gateway classifies one", () => {
    // The dashboard sends the stored path back with its message, and `parseAttachments` makes it the
    // attachment the turn reads — with the helper the platform adapters use. A second mapping would be a
    // second answer to "is this an image", and only one of them is the one the vision path follows.
    const [image] = parseAttachments([{ path: "/u/1-a.png", mimeType: "image/png", filename: "a.png" }]);
    expect(image).toMatchObject({ type: "image", url: "/u/1-a.png", filename: "a.png" });

    expect(parseAttachments([{ path: "/u/2-r.pdf", mimeType: "application/pdf" }])[0]?.type).not.toBe("image");
  });
});

describe("the spare copies", () => {
  test("are swept once they are older than the window", async () => {
    const stored = await uploads.save({ name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) });

    // Nothing is old yet.
    expect(uploads.sweep(1)).toBe(0);
    expect(fileExistsSync(stored.path)).toBe(true);
    // A day and a bit later, from the sweep's point of view.
    expect(uploads.sweep(1, Date.now() + 25 * 60 * 60_000)).toBe(1);
    expect(fileExistsSync(stored.path)).toBe(false);
  });

  test("a zero window sweeps nothing, rather than everything", async () => {
    // The same off position every other retention knob uses. A knob whose zero means "delete it all"
    // is a knob that eventually deletes it all.
    await uploads.save({ name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    expect(uploads.sweep(0)).toBe(0);
  });
});
