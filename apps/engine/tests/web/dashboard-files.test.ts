/**
 * How long a browser may keep each dashboard file (2026-10-15).
 *
 * Served with no caching headers, every visit re-downloaded the build — ~2 MB from a Pi over Wi-Fi —
 * and a conditional request was answered 200. Against a dist of its own, so this does not depend on
 * whether the checkout has built the dashboard.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardFile, pickEncoding } from "@/modules/web/dashboard-files.ts";

const dist = mkdtempSync(join(tmpdir(), "nouride-dashboard-dist-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), '<!doctype html><script type="module" src="/dashboard/assets/index-BOaEL47T.js"></script>');
writeFileSync(join(dist, "assets", "index-BOaEL47T.js"), "console.log('the build')");
writeFileSync(join(dist, "favicon.png"), "png");
afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe("a hashed build file", () => {
  test("is kept for a year without being asked about, and keeps its content type", async () => {
    const response = await dashboardFile(dist, "/dashboard/assets/index-BOaEL47T.js", undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // Under `nosniff` a script without its type is a script the browser will not run.
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  test("that is not there is a 404 — never the app shell under a chunk's name", async () => {
    // What a tab opened before an upgrade asks for. Answered with index.html it would have been a 200,
    // and now that assets are kept for a year, possibly HTML cached as a script.
    const response = await dashboardFile(dist, "/dashboard/assets/index-OLDBUILD.js", undefined);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBeNull();
  });
});

describe("the app shell, and anything else that keeps its name", () => {
  test("is kept but asked about every time, with a validator to ask with", async () => {
    const response = await dashboardFile(dist, "/dashboard/", undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(await response.text()).toContain("index-BOaEL47T.js");
  });

  test("an unchanged one is a 304 with no body — the asking costs headers", async () => {
    const etag = (await dashboardFile(dist, "/dashboard/", undefined)).headers.get("etag") ?? "";
    const again = await dashboardFile(dist, "/dashboard/", etag);
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
    // Compared weakly, as the RFC says: the prefix on either side does not matter.
    expect((await dashboardFile(dist, "/dashboard/", etag.replace(/^W\//, ""))).status).toBe(304);
  });

  test("a stale validator is a 200 with the file — one differing in a single digit too", async () => {
    // Shaped exactly like the current one, as the validator from the previous build is.
    const etag = (await dashboardFile(dist, "/dashboard/", undefined)).headers.get("etag") ?? "";
    const stale = etag.replace(/([0-9a-f])"$/, (_, digit: string) => `${digit === "0" ? "1" : "0"}"`);
    expect(stale).not.toBe(etag);
    const response = await dashboardFile(dist, "/dashboard/", stale);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("index-BOaEL47T.js");
  });

  test("a client-side route is the shell, revalidated like it", async () => {
    const response = await dashboardFile(dist, "/dashboard/settings/gateways", undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("<!doctype html>");
  });

  test("an unhashed file at the top is revalidated too", async () => {
    const response = await dashboardFile(dist, "/dashboard/favicon.png", undefined);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toBeTruthy();
  });
});

test("a path outside the build is not served", async () => {
  expect((await dashboardFile(dist, "/dashboard/../../etc/passwd", undefined)).status).toBe(404);
});

describe("a script the build compressed (E16, 0.7.10)", () => {
  // Stand-ins for the build's `.br` and `.gz`: what matters is which file is sent, and how it is labelled.
  // The brotli stand-in has the script's length and time, so only the coding can tell their validators apart.
  writeFileSync(join(dist, "assets", "index-BOaEL47T.js.br"), "brotli:same-size-as-orig");
  utimesSync(join(dist, "assets", "index-BOaEL47T.js.br"), 1_700_000_000, 1_700_000_000);
  utimesSync(join(dist, "assets", "index-BOaEL47T.js"), 1_700_000_000, 1_700_000_000);
  writeFileSync(join(dist, "assets", "index-BOaEL47T.js.gz"), "gzip bytes, a little longer");
  const script = "/dashboard/assets/index-BOaEL47T.js";

  test("goes as brotli to a browser that takes it, still typed as a script", async () => {
    const response = await dashboardFile(dist, script, undefined, "gzip, deflate, br, zstd");
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    // Under `nosniff`, a script labelled as the `.br` file's octet-stream would not run.
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("brotli:same-size-as-orig");
  });

  test("goes as gzip to one that takes only that, or turns brotli down", async () => {
    for (const accept of ["gzip", "br;q=0, gzip", "gzip;q=1, br;q=0.5"]) {
      const response = await dashboardFile(dist, script, undefined, accept);
      expect({ accept, coding: response.headers.get("content-encoding") }).toEqual({ accept, coding: "gzip" });
      expect(await response.text()).toBe("gzip bytes, a little longer");
    }
  });

  test("goes as itself to one that takes neither, and says the answer depends on it", async () => {
    for (const accept of [undefined, "identity", "br;q=0, gzip;q=0", "deflate"]) {
      const response = await dashboardFile(dist, script, undefined, accept);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      expect(await response.text()).toBe("console.log('the build')");
    }
  });

  test("each copy has its own validator", async () => {
    const plain = (await dashboardFile(dist, script, undefined)).headers.get("etag") ?? "";
    const brotli = (await dashboardFile(dist, script, undefined, "br")).headers.get("etag") ?? "";
    expect(brotli).not.toBe(plain);
    expect((await dashboardFile(dist, script, brotli, "br")).status).toBe(304);
    // The plain file's validator does not revalidate the brotli copy: a cache would keep the wrong body.
    expect((await dashboardFile(dist, script, plain, "br")).status).toBe(200);
    expect((await dashboardFile(dist, script, brotli, "br")).headers.get("vary")).toBe("Accept-Encoding");
  });

  test("a file with no copies does not vary", async () => {
    const response = await dashboardFile(dist, "/dashboard/", undefined, "br");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });
});

describe("pickEncoding", () => {
  const both = ["br", "gzip"];
  test("prefers brotli when both are welcome, and follows the client's ratings otherwise", () => {
    expect(pickEncoding("gzip, br", both)).toBe("br");
    expect(pickEncoding("br;q=0.4, gzip;q=0.9", both)).toBe("gzip");
    expect(pickEncoding("*", both)).toBe("br");
    expect(pickEncoding("*;q=0, gzip", both)).toBe("gzip");
    expect(pickEncoding("BR; Q=1", both)).toBe("br");
  });

  test("sends nothing encoded when nothing on disk is welcome", () => {
    expect(pickEncoding(undefined, both)).toBeNull();
    expect(pickEncoding("", both)).toBeNull();
    expect(pickEncoding("br;q=0, gzip;q=0", both)).toBeNull();
    expect(pickEncoding("br", ["gzip"])).toBeNull();
    expect(pickEncoding("gzip, br", [])).toBeNull();
  });
});
