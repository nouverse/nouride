/**
 * Image search, across both backends.
 *
 * The property that matters most here is the refusal. A backend without image support could be made
 * to run a *web* search and hand back page URLs — results that look right and are HTML documents.
 * Sending one of those as a picture is the failure this whole path exists to avoid, so "says no
 * clearly" is tested harder than "returns hits".
 */

import { describe, expect, test } from "bun:test";
import { SEARCH_BACKENDS } from "@/modules/tools/builtins/search-backends.ts";
import { createWebSearchTool } from "@/modules/tools/builtins/web/index.ts";

describe("brave", () => {
  const images = SEARCH_BACKENDS.brave.images!;

  test("the image endpoint is derived from the configured web one", () => {
    expect(images.endpointFor("https://api.search.brave.com/res/v1/web/search")).toBe(
      "https://api.search.brave.com/res/v1/images/search",
    );
  });

  test("an unrecognised endpoint falls back to the documented default rather than being mangled", () => {
    // A proxy has a URL shape we cannot guess at, and a wrong guess is a 404 that reads as
    // "image search is broken" rather than "your endpoint is not what I expected".
    expect(images.endpointFor("https://proxy.internal/search")).toBe(
      "https://api.search.brave.com/res/v1/images/search",
    );
  });

  test("safe search is forced on", () => {
    const url = new URL(images.buildUrl("https://x/images/search", "cats", 5));
    // An agent asked for a picture should not be how adult results reach somebody's chat.
    expect(url.searchParams.get("safesearch")).toBe("strict");
    expect(url.searchParams.get("q")).toBe("cats");
  });

  test("the direct image URL is preferred over the cached thumbnail", () => {
    const hits = images.parse({
      results: [
        {
          title: "A cat",
          url: "https://example.com/page",
          properties: { url: "https://example.com/cat.jpg", width: 800, height: 600 },
          thumbnail: { src: "https://brave.cdn/thumb.jpg" },
        },
      ],
    });
    expect(hits[0]).toEqual({
      title: "A cat",
      imageUrl: "https://example.com/cat.jpg",
      sourceUrl: "https://example.com/page",
      width: 800,
      height: 600,
    });
  });

  test("a result with only a thumbnail is still usable", () => {
    const hits = images.parse({
      results: [{ title: "x", url: "https://example.com/p", thumbnail: { src: "https://cdn/t.jpg" } }],
    });
    expect(hits[0]?.imageUrl).toBe("https://cdn/t.jpg");
  });

  test("a result with no image at all is dropped, not returned with an empty URL", () => {
    expect(images.parse({ results: [{ title: "x", url: "https://example.com/p" }] })).toEqual([]);
  });

  test("an unfamiliar body is an empty list, never a throw", () => {
    expect(images.parse({ unexpected: true })).toEqual([]);
    expect(images.parse(null)).toEqual([]);
  });
});

describe("searxng", () => {
  const images = SEARCH_BACKENDS.searxng.images!;

  test("images are selected by category on the same endpoint", () => {
    const url = new URL(images.buildUrl("http://searxng:8080/search", "kucing", 5));
    expect(url.searchParams.get("categories")).toBe("images");
    expect(url.searchParams.get("format")).toBe("json");
    expect(images.endpointFor("http://searxng:8080/search")).toBe("http://searxng:8080/search");
  });

  test("img_src is the file and url is the page — they are not interchangeable", () => {
    const hits = images.parse({
      results: [
        {
          title: "Kucing",
          url: "https://example.com/artikel",
          img_src: "https://example.com/kucing.png",
          resolution: "1024x768",
        },
      ],
    });
    expect(hits[0]?.imageUrl).toBe("https://example.com/kucing.png");
    expect(hits[0]?.sourceUrl).toBe("https://example.com/artikel");
    expect(hits[0]?.width).toBe(1024);
    expect(hits[0]?.height).toBe(768);
  });

  test("a thumbnail-only result survives", () => {
    const hits = images.parse({
      results: [{ title: "x", url: "https://p", thumbnail_src: "https://t/x.jpg" }],
    });
    expect(hits[0]?.imageUrl).toBe("https://t/x.jpg");
  });

  test("an unparseable resolution is omitted rather than guessed", () => {
    const hits = images.parse({
      results: [{ title: "x", url: "https://p", img_src: "https://i/x.jpg", resolution: "unknown" }],
    });
    expect(hits[0]?.width).toBeUndefined();
  });
});

describe("when the backend cannot do images", () => {
  test("the keyless fallback refuses and names both settings that would fix it", async () => {
    // No key and no endpoint: this is the state of a fresh install, and the one an operator hits.
    const tool = createWebSearchTool({});
    expect(tool).not.toBeNull();

    const result = await tool!.execute({ query: "kucing lucu", kind: "image" }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("search_api_key");
    expect(result.content).toContain("searxng");
    // And it says the other half still works, so the agent does not conclude search is down.
    expect(result.content).toMatch(/web search still works/i);
  });

  test("a web search on the same daemon still succeeds", async () => {
    const tool = createWebSearchTool({
      fetchImpl: (async () =>
        new Response('<a class="result__a" href="https://example.com">A page</a>', {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const result = await tool!.execute({ query: "anything" }, {} as never);
    expect(result.isError).toBe(false);
  });
});
