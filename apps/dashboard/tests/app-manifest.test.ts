/**
 * The dashboard as an app on a phone's home screen or a desktop's app list: its manifest, its icons, and the lines in
 * `index.html` that name them.
 *
 * There was none of it: no manifest, no large icon, no theme colour, so a phone could only bookmark the page. The icons
 * are the favicon's head, the mascot's own, kept with the brand marks (`packages/shared/assets/app-icons/`) and copied
 * into `public/icons/` at every build (`scripts/sync-brand.ts`): the app on a home screen wears the face the tab does,
 * not the Office's pixel cat. These hold the manifest to those files, each icon to its size and its ground, and the
 * colours to the theme they come from, worked out from `main.css` as the browser mixes them. And that there is no service worker: the browsers install
 * without one, and a cache is how an installed dashboard stays on an old build after an update.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { GROUNDS } from "@/commons/lib/theme";

const ROOT = join(dirname(import.meta.path), "..");
const BRAND = join(ROOT, "..", "..", "packages", "shared", "assets", "app-icons");

/** The icons, as the manifest and `index.html` name them: two to show, one to be masked, and the iPhone's. */
const APP_ICONS = [
  { file: "icons/icon-192.png", size: 192, purpose: "any" },
  { file: "icons/icon-512.png", size: 512, purpose: "any" },
  { file: "icons/icon-maskable-512.png", size: 512, purpose: "maskable" },
  { file: "icons/apple-touch-icon.png", size: 180 },
] as const;
/** The night theme's lavender, behind the head where an icon must reach every edge. */
const LAVENDER = "#a99af0";
const manifest = JSON.parse(readFileSync(join(ROOT, "public", "manifest.webmanifest"), "utf8")) as Record<string, unknown> & { icons: Record<string, string>[] };
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
const css = readFileSync(join(ROOT, "src", "styles", "main.css"), "utf8");
const boot = readFileSync(join(ROOT, "public", "theme-boot.js"), "utf8");

type RGB = [number, number, number];

const themes = Object.fromEntries(
  [...css.matchAll(/@plugin\s+"daisyui\/theme"\s*\{([\s\S]*?)\n\}/g)].map((m) => {
    const block = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
    const name = /\bname:\s*"([^"]+)"/.exec(block)?.[1] ?? "";
    return [name, Object.fromEntries([...block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map((v) => [v[1]!, v[2]!.trim()])) as Record<string, string>];
  }),
);

const rgb = (hex: string): RGB => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as RGB;
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function oklab([r, g, b]: RGB): RGB {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function hex([L, a, b]: RGB): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const out = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${out.map((c) => Math.round(Math.min(1, Math.max(0, gamma(c))) * 255).toString(16).padStart(2, "0")).join("")}`;
}
/** A theme's ground, as `bg-app` mixes it: base-200 halfway into base-100, in OKLab. */
const ground = (theme: string) => {
  const [a, b] = [oklab(rgb(themes[theme]!["color-base-200"]!)), oklab(rgb(themes[theme]!["color-base-100"]!))];
  return hex(a.map((v, i) => (v + b[i]!) / 2) as RGB);
};

/** A PNG's width and height, and its pixels as RGBA (8-bit RGB or RGBA, each row's filter undone): what a browser draws. */
function readPng(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [width, height, depth, colourType] = [view.getUint32(16), view.getUint32(20), bytes[24]!, bytes[25]!];
  expect({ depth, colourType: [2, 6].includes(colourType) }).toEqual({ depth: 8, colourType: true });
  const chunks: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const bpp = colourType === 6 ? 4 : 3;
  const stride = width * bpp;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= bpp ? rows[y * stride + x - bpp]! : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? rows[(y - 1) * stride + x - bpp]! : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predicted = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      rows[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0; at < width * height; at += 1) {
    pixels.set(rows.subarray(at * bpp, at * bpp + 3), at * 4);
    pixels[at * 4 + 3] = bpp === 4 ? rows[at * bpp + 3]! : 255;
  }
  return { width, height, alpha: colourType === 6, pixels };
}

const hexOf = (pixels: Uint8Array, at: number) => `#${[...pixels.subarray(at, at + 3)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

describe("the manifest", () => {
  test("Nouride, opening on Chats, a window of its own, and only the dashboard inside it", () => {
    expect(manifest.name).toBe("Nouride");
    expect(manifest.short_name).toBe("Nouride");
    expect(manifest.start_url).toBe("/dashboard/chat");
    expect(manifest.scope).toBe("/dashboard/");
    expect(String(manifest.start_url).startsWith(String(manifest.scope))).toBe(true);
    expect(manifest.id).toBe("/dashboard/");
    expect(manifest.display).toBe("standalone");
  });

  test("its colours are the night theme's ground, as main.css makes it", () => {
    // The fail-open shape: no theme read would compare nothing.
    expect(Object.keys(themes).sort()).toEqual(["nouride", "nouride-light"]);
    expect(GROUNDS).toEqual({ dark: ground("nouride"), light: ground("nouride-light") });
    expect(manifest.background_color).toBe(GROUNDS.dark);
    expect(manifest.theme_color).toBe(GROUNDS.dark);
  });

  test("its icons: a 192 and a 512 to show, a 512 to be masked", () => {
    const named = APP_ICONS.filter((icon) => "purpose" in icon).map((icon) => ({ src: icon.file, sizes: `${icon.size}x${icon.size}`, type: "image/png", purpose: (icon as { purpose: string }).purpose }));
    expect(manifest.icons).toEqual(named);
    // What a browser asks of an installable app's icons.
    expect(manifest.icons.filter((icon) => icon.purpose === "any").map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
    expect(manifest.icons.filter((icon) => icon.purpose === "maskable").map((icon) => icon.sizes)).toEqual(["512x512"]);
  });
});

describe("the icons", () => {
  const read = (file: string) => readPng(new Uint8Array(readFileSync(join(BRAND, file.replace("icons/", "")))));

  for (const icon of APP_ICONS) {
    const shown = "purpose" in icon && icon.purpose === "any";
    test(`${icon.file}: ${icon.size} pixels square, the favicon's head ${shown ? "clear around it, as the favicon is" : "on lavender to every edge"}`, () => {
      const { width, height, alpha, pixels } = read(icon.file);
      expect({ width, height }).toEqual({ width: icon.size, height: icon.size });
      const at = (x: number, y: number) => (y * icon.size + x) * 4;
      // The head's own colours: the helmet's near-black and the face's white, around the middle.
      const colours = new Set<string>();
      for (let y = icon.size * 0.3; y < icon.size * 0.8; y += 1) for (let x = icon.size * 0.2; x < icon.size * 0.8; x += 1) colours.add(hexOf(pixels, at(Math.floor(x), Math.floor(y))));
      expect([...colours].some((colour) => Number.parseInt(colour.slice(1, 3), 16) < 0x50 && Number.parseInt(colour.slice(5, 7), 16) < 0x60)).toBe(true);
      expect([...colours].some((colour) => colour >= "#e8e8e8" && Number.parseInt(colour.slice(3, 5), 16) >= 0xe0)).toBe(true);
      // The favicon's drawing, shaded as it is, not the Office's 32-pixel cat the icons were first drawn from: that one
      // had a few dozen flat colours.
      expect(colours.size).toBeGreaterThan(400);
      if (shown) {
        expect(alpha).toBe(true);
        expect(pixels[at(0, 0) + 3]).toBe(0);
      } else {
        // A mask cuts its own shape out of the whole square, and an iPhone fills anything clear with black.
        expect(alpha).toBe(false);
        expect(hexOf(pixels, at(0, 0))).toBe(LAVENDER);
      }
    });
  }

  test("the one to be masked keeps the head inside the middle circle every mask keeps", () => {
    const icon = APP_ICONS.find((one) => "purpose" in one && one.purpose === "maskable")!;
    const { pixels } = read(icon.file);
    const centre = icon.size / 2;
    let outside = 0;
    let drawn = 0;
    for (let y = 0; y < icon.size; y += 1) {
      for (let x = 0; x < icon.size; x += 1) {
        const [r, g, b] = [...pixels.subarray((y * icon.size + x) * 4, (y * icon.size + x) * 4 + 3)] as [number, number, number];
        // The lavender, and the soft edge where the head's outline fades into it.
        if (Math.abs(r - 0xa9) + Math.abs(g - 0x9a) + Math.abs(b - 0xf0) < 24) continue;
        drawn += 1;
        // The safe zone: a circle of 40% of the side's radius, from the middle.
        if (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) > icon.size * 0.4) outside += 1;
      }
    }
    expect(drawn).toBeGreaterThan(icon.size * icon.size * 0.2);
    expect(outside).toBe(0);
  });

  test("the lavender is the night theme's fill", () => {
    expect(LAVENDER).toBe(themes.nouride!["fill-secondary"]!);
  });

  test("the build copies them with the brand marks, into a folder git leaves alone", () => {
    const sync = readFileSync(join(ROOT, "..", "..", "scripts", "sync-brand.ts"), "utf8");
    for (const icon of APP_ICONS) {
      const name = icon.file.replace("icons/", "");
      expect(sync).toContain(`{ from: "packages/shared/assets/app-icons/${name}", to: "apps/dashboard/public/${icon.file}" }`);
    }
    const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const name of ["build", "dev"]) expect(scripts[name]).toMatch(/^bun run \.\.\/\.\.\/scripts\/sync-brand\.ts && vite\b/);
    expect(readFileSync(join(ROOT, "..", "..", ".gitignore"), "utf8").split("\n")).toContain("apps/dashboard/public/icons/");
  });
});

describe("index.html", () => {
  /** A tag in the head by what it is, as written. */
  const tag = (pattern: RegExp) => pattern.exec(head)?.[0] ?? "";

  test("names the manifest, and the iPhone's icon the build draws", () => {
    expect(tag(/<link rel="manifest" href="\/manifest\.webmanifest" \/>/)).not.toBe("");
    // A public file, which the build serves under /dashboard/ as it is.
    expect(existsSync(join(ROOT, "public", "manifest.webmanifest"))).toBe(true);
    const apple = APP_ICONS.find((icon) => !("purpose" in icon))!;
    expect(apple.size).toBe(180);
    expect(tag(/<link rel="apple-touch-icon" href="([^"]+)" \/>/)).toContain(`href="/${apple.file}"`);
  });

  test("colours the browser's bar by the theme: the day's ground by day, the night's by night", () => {
    expect(tag(/<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="[^"]+" \/>/)).toContain(`content="${ground("nouride-light")}"`);
    expect(tag(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="[^"]+" \/>/)).toContain(`content="${ground("nouride")}"`);
    // The boot script's own copy, for a theme chosen against the system: it cannot import theme.ts.
    expect(boot).toContain(`"${GROUNDS.light}"`);
    expect(boot).toContain(`"${GROUNDS.dark}"`);
    // Before the boot script, which looks for them as it runs.
    expect(head.indexOf('name="theme-color"')).toBeLessThan(head.indexOf('src="/theme-boot.js"'));
  });

  test("opens as an app from a home screen, below the status bar, named Nouride", () => {
    for (const meta of ['name="mobile-web-app-capable" content="yes"', 'name="apple-mobile-web-app-capable" content="yes"', 'name="apple-mobile-web-app-status-bar-style" content="default"', 'name="apple-mobile-web-app-title" content="Nouride"']) {
      expect(head).toContain(`<meta ${meta} />`);
    }
  });
});

describe("no service worker", () => {
  test("none is registered and none is shipped: nothing can hold an installed dashboard on an old build", () => {
    const sources = (readdirSync(join(ROOT, "src"), { recursive: true }) as string[]).filter((file) => /\.(ts|tsx)$/.test(file));
    const registering = sources.filter((file) => readFileSync(join(ROOT, "src", file), "utf8").includes("serviceWorker"));
    expect(registering).toEqual([]);
    expect(readdirSync(join(ROOT, "public")).filter((file) => /(^sw|worker)\.js$/i.test(file))).toEqual([]);
    expect(html).not.toContain("serviceWorker");
  });
});
