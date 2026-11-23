/**
 * Memory's Embed now, refused (0.8.20): it said nothing at all, the server's refusal dropped by a mutation nobody
 * listened to, so the button looked as if it had done its work. Now a toast says why in the page's words, the server's
 * own under Details. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, buttons, press, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { AT_REST, boxIn, card } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";
import { PAGE_ASKS, SEMANTIC_SEARCH_ASK } from "@/commons/components/agents/page-asks";

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

/**
 * The Semantic search card asks for a provider that embeds and a model's name. A person who has neither could only
 * read how to get one; now the card has a button of its own that asks the orchestrator to set one up, on this machine,
 * on another server or with a cloud service. It is the card's, beside the page's own "about knowledge and memory".
 */
test("the Semantic search card asks the orchestrator to set it up: its own button, with the three places in the request", async () => {
  answer(AT_REST);
  const posts = recordPosts();
  const seen = { head: "", cardAsk: "", inCard: false, request: "" };
  try {
    await renderPage("/memories", async (host) => {
      await eventually(() => buttons(host).includes("Settings"), 2_000, "the Settings tab");
      press(host, "Settings");
      const asks = () => [...host.querySelectorAll("button")].filter((one) => (one.getAttribute("title") ?? "").startsWith("Ask Nouva "));
      await eventually(() => asks().length === 2, 3_000, "the page's ask and the card's");
      const [head, own] = asks();
      seen.head = head!.getAttribute("title") ?? "";
      // Its words whole at every width: two "Ask Nouva" on a phone would say nothing of which asks what.
      seen.cardAsk = (own!.textContent ?? "").replace(/\s+/g, " ").trim();
      seen.inCard = (own!.closest("section")?.querySelector("h2")?.textContent ?? "") === "Semantic search";
      own!.click();
      await eventually(() => boxIn(card())?.value === SEMANTIC_SEARCH_ASK.message, 3_000, "the request in the box");
      seen.request = boxIn(card())!.value;
    });
  } finally {
    posts.restore();
  }
  expect(seen.head).toBe(`Ask Nouva ${PAGE_ASKS.memory.task}`);
  expect(seen.head).toBe("Ask Nouva about knowledge and memory");
  expect(seen.cardAsk).toBe("Ask Nouva to set up semantic search");
  expect(seen.inCard).toBe(true);
  // The three places a model can run, and that nothing is installed before the person hears of it.
  for (const words of ["on this machine", "on another server of mine", "with a cloud service", "before you install anything"]) expect(seen.request).toContain(words);
  // Written in the box for the person to finish, never sent from the page.
  expect(posts.posts.filter((post) => post.path === "/chat/send")).toEqual([]);
});
