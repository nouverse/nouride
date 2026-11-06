/**
 * The mount harness itself: a page whose step throws is taken down all the same. Left mounted, its queries went on
 * through the next tests' fetch, and one failed knowledge test in CI failed ten restart tests in another file after it.
 */

import { expect, test } from "bun:test";
import { dom, renderPage, useMountHarness } from "./mount-harness.ts";

useMountHarness();

test("a page whose step throws is unmounted and taken off the page all the same", async () => {
  const before = dom.document.body.children.length;
  await expect(
    renderPage("/memories", async (host) => {
      expect(host.isConnected).toBe(true);
      throw new Error("a step failed");
    }),
  ).rejects.toThrow("a step failed");
  expect(dom.document.body.children.length).toBe(before);
});
