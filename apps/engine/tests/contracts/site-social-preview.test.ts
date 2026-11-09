/**
 * What a link to nouride.com shows where it is shared. X, WhatsApp and Telegram keep a preview by the image's address,
 * so a new og.png at the same `/og.png` kept showing the old picture; and the root page, which only redirects, still
 * named the product by an older tagline, which is what a crawler reads since it never runs the redirect.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "../../../site");
const hash = createHash("sha256").update(readFileSync(join(SITE, "public/og.png"))).digest("hex").slice(0, 12);

describe("the site's social preview", () => {
  test("the image's address carries og.png's own hash", async () => {
    const config = (await import(join(SITE, "astro.config.mjs"))).default as { vite: { define: Record<string, string> } };
    expect(JSON.parse(config.vite.define["import.meta.env.OG_IMAGE"]!)).toBe(`https://nouride.com/og.png?v=${hash}`);
  });

  test("no page names the image without it", () => {
    const config = readFileSync(join(SITE, "astro.config.mjs"), "utf8");
    const layout = readFileSync(join(SITE, "src/layouts/Site.astro"), "utf8");
    // The two shapes the address had without its hash: `${SITE_URL}/og.png` and a page's `'/og.png'`.
    for (const text of [config, layout]) expect(text).not.toMatch(/SITE_URL\}\/og\.png`|['"]\/og\.png['"]/);
    expect(config.match(/content: OG_IMAGE/g)).toHaveLength(3);
    expect(layout).toContain("import.meta.env.OG_IMAGE");
  });

  test("the root page says what the English page says", async () => {
    const root = readFileSync(join(SITE, "src/pages/index.astro"), "utf8");
    expect(root).toContain("title={en.meta.title} description={en.meta.description}");
    const { en } = (await import(join(SITE, "src/i18n/landing.mjs"))) as { en: { meta: { title: string } } };
    expect(en.meta.title).toBe("Nouride: AI agents that live on your box");
    expect(root).not.toContain("Serious Agents");
  });
});
