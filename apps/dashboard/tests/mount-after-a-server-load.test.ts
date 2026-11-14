/**
 * A page mounted after the query library was loaded with no window is still a browser's.
 *
 * The library decides once, when it is first loaded, whether it is on a server, and on one it sets no interval. Every
 * test file runs in one process, so a file with no DOM that loaded it first left every page mounted after it unable
 * to ask again: the automation page's "asks again every two seconds" failed on Linux runners, where the files come in
 * another order, and never on a Mac. The mount harness now has the library ask each time (`asABrowser`). Here the
 * library is first told what such a file leaves behind, and the harness has to put it right.
 */

import { beforeAll, expect, test } from "bun:test";
import { environmentManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

// Registered before the harness's own hook, so it runs first: the library as a file with no DOM leaves it.
beforeAll(() => environmentManager.setIsServer(() => true));
useMountHarness();

test("with a page mounted the library is a browser's, and an interval asks again", async () => {
  answer({});
  await renderPage("/", async () => {
    expect(environmentManager.isServer()).toBe(false);
    const client = new QueryClient();
    let asked = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["asked-again"],
      queryFn: async () => {
        asked += 1;
        return asked;
      },
      refetchInterval: 30,
    });
    const stop = observer.subscribe(() => {});
    try {
      // The first is the fetch a mount makes; every one after it is the interval's.
      await eventually(() => asked >= 3, 3_000, "asked again");
    } finally {
      stop();
      client.clear();
    }
  });
});

test("it is asked each time, not decided once: with no window it is a server's again", () => {
  const held = (globalThis as { window?: unknown }).window;
  try {
    delete (globalThis as { window?: unknown }).window;
    expect(environmentManager.isServer()).toBe(true);
  } finally {
    (globalThis as { window?: unknown }).window = held;
  }
  expect(environmentManager.isServer()).toBe(false);
});
