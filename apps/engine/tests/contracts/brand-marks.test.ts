/**
 * The dashboard and the manual wear different marks.
 *
 * They used to wear the same one — `sync-brand.ts` copied a single favicon to both — and the cost
 * was not aesthetic: the two are open in adjacent tabs all day, and at 16 pixels a tab is its icon.
 * Nothing in a build would notice the day somebody points both entries at one file again, because
 * the copy would still succeed, so the difference is asserted here rather than left to be seen.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const script = readFileSync(join(ROOT, "scripts/sync-brand.ts"), "utf8");

/** Every entry in that script's COPIES, read from the script itself. */
const copies = [...script.matchAll(/from:\s*"([^"]+)",\s*to:\s*"([^"]+)"/g)].map((match) => ({ from: match[1] as string, to: match[2] as string }));
/** The favicons among them: the dashboard's app icons are copies too, and not the mark a tab wears. */
const sources = copies.filter((copy) => copy.to.endsWith("/favicon.png")).map((copy) => copy.from);

describe("brand marks", () => {
  test("every app the script copies to has a source, and there is more than one", () => {
    // Two entries today. The assertion is "not one", so adding a third app does not fail it and
    // collapsing them back to a single shared file does.
    expect(sources.length).toBeGreaterThan(1);
    for (const source of sources) expect(existsSync(join(ROOT, source))).toBe(true);
  });

  test("no two apps are given the same file", () => {
    const bytes = sources.map((source) => readFileSync(join(ROOT, source)).toString("base64"));
    expect(new Set(bytes).size).toBe(bytes.length);
  });

  test("a favicon stays small enough to be one, since it is fetched on every cold load", () => {
    // Pointing an entry straight at a full-size picture would work, and would ship it on every first
    // page view.
    for (const source of sources) {
      expect(readFileSync(join(ROOT, source)).byteLength).toBeLessThan(200_000);
    }
  });

  test("what the script copies is generated, not committed beside its source, and nothing is ignored that it does not copy", () => {
    // A copy that is not ignored gets committed, and then there are two of the file to keep in step. And a line left
    // behind for a copy the script no longer makes hides whatever is put at that path by hand: the site's
    // `logo.png` was one, a copy of a logo no page drew any more.
    expect(copies.length).toBeGreaterThan(sources.length);
    const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");
    for (const copy of copies) expect({ to: copy.to, ignored: ignored.includes(copy.to) }).toEqual({ to: copy.to, ignored: true });
    const made = new Set(copies.map((copy) => copy.to));
    const images = ignored.filter((line) => /^apps\/\w+\/public\/.+\.png$/.test(line));
    expect(images.filter((line) => !made.has(line))).toEqual([]);
  });

  test("and so are the installers the site serves: generated, ignored, and no committed copy", () => {
    // `install-bundle-router.sh` was tracked beside its generated sibling `install.sh`, identical to its source.
    const sync = readFileSync(join(ROOT, "apps/site/scripts/sync-installer.ts"), "utf8");
    const served = [...sync.matchAll(/syncScript\(join\(ROOT, "[^"]+"\), "([^"]+)"\)/g)].map((match) => `apps/site/public/${match[1]}`);
    expect(served).toEqual(["apps/site/public/install.sh", "apps/site/public/install-bundle-router.sh"]);
    const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");
    for (const path of served) expect({ path, ignored: ignored.includes(path) }).toEqual({ path, ignored: true });
  });

  test("the dashboard's tab says which of the two it is", () => {
    // "Nouride" alone was on both, which is the other half of the same confusion.
    const html = readFileSync(join(ROOT, "apps/dashboard/index.html"), "utf8");
    expect(html).toContain("<title>Nouride Dashboard</title>");
  });

  test("the site's loading overlay waits for a small mark", () => {
    // The overlay is removed on `load`, so the image in it is waited for on every first visit. It was
    // `public/logo.png`, 1.4 MB, drawn at 72 px.
    const layout = readFileSync(join(ROOT, "apps/site/src/layouts/Site.astro"), "utf8");
    const loader = /<div id="site-loader"[\s\S]*?<img src=\{(\w+)\.src\}/.exec(layout)?.[1];
    expect(loader).toBeDefined();
    const file = new RegExp(`import ${loader} from '@brand/([^']+)'`).exec(layout)?.[1] ?? "";
    expect(readFileSync(join(ROOT, "packages/shared/assets", file)).byteLength).toBeLessThan(200_000);
  });
});
