/**
 * What the dashboard's build does to what it ships.
 *
 * Read from the real `vite.config.ts`, by the plugins it hands Vite, so a refactor of the file that
 * keeps the behaviour keeps the test green and one that drops it does not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { Plugin, UserConfig } from "vite";
import { precompressAssets } from "../scripts/precompress";

const ROOT = join(dirname(import.meta.path), "..");

async function plugins(): Promise<Plugin[]> {
  const module = (await import(join(ROOT, "vite.config.ts"))) as { default: (env: { mode: string; command: string }) => UserConfig };
  const config = module.default({ mode: "production", command: "build" });
  return (config.plugins ?? []).flat(Infinity as 1).filter((plugin): plugin is Plugin => typeof plugin === "object" && plugin !== null && "name" in plugin);
}

describe("the dashboard build", () => {
  test("splits each route's page into a chunk of its own", async () => {
    // It was one 958 KB script holding all 38 pages, parsed on the first load of any of them. The
    // router plugin's code splitter is what moves a route's component out of the main chunk.
    const names = (await plugins()).map((plugin) => plugin.name);
    expect(names).toContain("tanstack:router-generator");
    expect(names.some((name) => name.startsWith("tanstack-router:code-splitter"))).toBe(true);
  });

  test("writes brotli and gzip copies of each script and stylesheet", async () => {
    // The daemon served them raw; it now sends the copy a browser accepts (`dashboard-files.ts`).
    expect((await plugins()).map((plugin) => plugin.name)).toContain("nouride:precompress");

    const out = mkdtempSync(join(tmpdir(), "nouride-precompress-"));
    try {
      mkdirSync(join(out, "assets"));
      const script = "export const page = 1;\n".repeat(200);
      writeFileSync(join(out, "assets", "index-abc.js"), script);
      writeFileSync(join(out, "assets", "index-abc.css"), ".btn{color:red}\n".repeat(100));
      writeFileSync(join(out, "assets", "tiny-abc.js"), "export{}");
      writeFileSync(join(out, "assets", "cat-abc.webp"), new Uint8Array(4096));
      writeFileSync(join(out, "index.html"), "<!doctype html>".repeat(100));
      precompressAssets(out);

      expect(readdirSync(join(out, "assets")).filter((name) => /\.(br|gz)$/.test(name)).sort()).toEqual([
        "index-abc.css.br",
        "index-abc.css.gz",
        "index-abc.js.br",
        "index-abc.js.gz",
      ]);
      expect(brotliDecompressSync(readFileSync(join(out, "assets", "index-abc.js.br"))).toString()).toBe(script);
      expect(gunzipSync(readFileSync(join(out, "assets", "index-abc.js.gz"))).toString()).toBe(script);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("no route splits itself by hand any more", () => {
    // `lazy()` in a route file was the one manual split; under autoCodeSplitting it is a second
    // boundary inside the first, with a fallback of its own that the router's pending state already is.
    const routes = join(ROOT, "src", "routes");
    const manual = readdirSync(routes).filter((name) => /import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*["']react["']/.test(readFileSync(join(routes, name), "utf8")));
    expect(manual).toEqual([]);
  });
});

/** One real build, which the tests below read: what only the bundler's own output can show. */
describe("a real build", () => {
  let out = "";
  let built: { status: number | null; stderr: string } = { status: null, stderr: "" };

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "nouride-dashboard-build-"));
    const build = spawnSync("bun", ["x", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    built = { status: build.status, stderr: build.stderr };
  }, 120_000);

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  test("each copy is the file beside it, compressed", () => {
    // The first version compressed the bundle before Vite had filled in its `__VITE_PRELOAD__`
    // placeholder, so every `.br` held a script that threw on load. Only a real build can show that.
    expect(built.status, built.stderr).toBe(0);
    const assets = readdirSync(join(out, "assets"));
    const copies = assets.filter((name) => /\.(br|gz)$/.test(name));
    expect(copies.some((name) => name.endsWith(".js.br"))).toBe(true);
    const wrong = copies.filter((name) => {
      const original = readFileSync(join(out, "assets", name.replace(/\.(br|gz)$/, "")));
      const bytes = readFileSync(join(out, "assets", name));
      return !(name.endsWith(".br") ? brotliDecompressSync(bytes) : gunzipSync(bytes)).equals(original);
    });
    expect(wrong).toEqual([]);
  });

  test("the faces are files the stylesheet names, the interface one preloaded — never inlined, never fetched elsewhere", () => {
    // The CSP has no `font-src`, so fonts fall to `default-src 'self'`: a `data:` font is refused, and so is
    // another origin. Both fail quietly, as a page in the fallback face.
    expect(built.status, built.stderr).toBe(0);
    const assets = readdirSync(join(out, "assets"));
    const stylesheet = readFileSync(join(out, "assets", assets.find((name) => /^index-.*\.css$/.test(name))!), "utf8");
    const named = [...stylesheet.matchAll(/url\(([^)]+\.woff2)\)/g)].map((m) => m[1]!.replace(/^["']|["']$/g, ""));
    // Manrope and DM Mono's six, and Fredoka's two for the headings (0.8.24).
    expect(named).toHaveLength(8);
    for (const url of named) {
      expect(url).toMatch(/^\/dashboard\/assets\/[\w-]+\.woff2$/);
      expect(assets).toContain(url.replace("/dashboard/assets/", ""));
    }
    expect(stylesheet).not.toMatch(/data:(font|application\/font|application\/x-font)/);
    expect(stylesheet).not.toMatch(/url\(\s*["']?https?:/);

    // Requested beside the stylesheet, not after React has drawn its first text: the one every page uses first.
    const html = readFileSync(join(out, "index.html"), "utf8");
    const preload = /<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin="">/.exec(html)?.[1];
    expect(preload).toMatch(/^\/dashboard\/assets\/manrope-latin-[\w-]{8}\.woff2$/);
    expect(named).toContain(preload!);
  });
});
