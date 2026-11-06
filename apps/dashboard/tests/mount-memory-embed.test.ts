/**
 * Memory's Embed now, refused (0.8.20): it said nothing at all, the server's refusal dropped by a mutation nobody
 * listened to, so the button looked as if it had done its work. Now a toast says why in the page's words, the server's
 * own under Details. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { buttons, press, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

test("a refused Embed now says why, in the page's words, the server's own under Details", async () => {
  const refused = {
    error: "semantic search is off: it needs [memory.semantic] enabled, provider and model",
    plain: "Search by meaning is off. Turn it on under Semantic search with an embedding model, then embed again.",
  };
  const posts = recordPosts({ "/memory/embed": { status: 409, body: refused } });
  let toast = "";
  let details = "";
  try {
    await renderPage("/memories", async (host) => {
      await eventually(() => buttons(host).includes("Settings"), 2_000, "the Settings tab");
      press(host, "Settings");
      await eventually(() => buttons(host).includes("Embed now"), 2_000, "Embed now");
      press(host, "Embed now");
      await eventually(() => [...host.ownerDocument.querySelectorAll('[role="status"]')].some((node) => (node.textContent ?? "").includes("Could not embed")), 2_000, "the toast");
      const shown = [...host.ownerDocument.querySelectorAll('[role="status"]')].find((node) => (node.textContent ?? "").includes("Could not embed"))!;
      details = shown.querySelector("details")?.textContent ?? "";
      toast = (shown.textContent ?? "").replace(details, "");
    });
  } finally {
    posts.restore();
  }
  expect(posts.posts.map((post) => post.path)).toEqual(["/memory/embed"]);
  expect(toast).toContain(`Could not embed${refused.plain}`);
  expect(toast).not.toContain("[memory.semantic]");
  expect(details).toContain(refused.error);
});
