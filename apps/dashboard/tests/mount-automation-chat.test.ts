/**
 * The chat that floats over every page, on the Automations pages: a message sent from it tells the agent which page is
 * open. The list is "Automations"; one automation's page is in Automations and is about that automation, by its name;
 * the page that makes one is about none yet. And the bar that saves stands clear of the chat's button and its card.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionTitle } from "@/commons/components/floating-chat/page-open";
import { answer, dom, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY, sendIn } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

afterEach(() => {
  dom.localStorage.removeItem(LAST_AGENT_KEY);
});

const sent = (posts: { path: string; body: unknown }[]) => posts.filter((post) => post.path === "/chat/send").map((post) => (post.body as { page?: unknown }).page);

/** A message sent from the floating chat over `path`, once `ready` says the page is drawn: the page it was sent with. */
async function pageSentFrom(path: string, ready: (host: HTMLElement) => boolean): Promise<unknown> {
  answer(AT_REST);
  const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" } } });
  try {
    await renderPage(path, async (host) => {
      await eventually(() => ready(host) && floatButton(host) !== null, 4_000, "the page and the chat's button");
      floatButton(host)!.click();
      await eventually(() => boxIn(card()) !== null, 3_000, "the conversation in the panel");
      type(boxIn(card())!, "what does this one do?");
      await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
      sendIn(card())!.click();
      await eventually(() => sent(posted.posts).length === 1, 3_000, "sent");
    });
    return sent(posted.posts)[0];
  } finally {
    posted.restore();
  }
}

describe("the page a message from the floating chat is sent with", () => {
  test("one automation's page: in Automations, and about that automation by its name", async () => {
    const page = await pageSentFrom("/automations/cron_1", (host) => host.textContent?.includes("Who and where") === true);
    expect(page).toEqual({ path: "/dashboard/automations/cron_1", title: "Automations", subject: "Shop health check" });
  });

  test("the list is Automations, about no one of them; and the page that makes one is about none yet", async () => {
    const list = await pageSentFrom("/automations", (host) => host.querySelector("[data-automation]") !== null);
    expect(list).toEqual({ path: "/dashboard/automations", title: "Automations" });
    const fresh = await pageSentFrom("/automations/new", (host) => host.textContent?.includes("Add the first step") === true);
    expect(fresh).toEqual({ path: "/dashboard/automations/new", title: "Automations" });
  });

  test("its place in the menu is read from the menu: an automation's page and the page that makes one are in Automations", () => {
    expect(["/automations", "/automations/cron_1", "/automations/new"].map(sectionTitle)).toEqual(["Automations", "Automations", "Automations"]);
  });
});

test("the bar that saves ends short of the chat's button below a laptop's width, and of its open card from a laptop up", () => {
  const bar = readFileSync(join(import.meta.dir, "../src/modules/automations/components/SaveBar.tsx"), "utf8");
  const chat = readFileSync(join(import.meta.dir, "../src/commons/components/floating-chat/FloatingChat.tsx"), "utf8");
  // The chat's own places, as it writes them: its button 3rem wide, 1rem from the right, over the tab bar; its card 25rem wide.
  expect(chat).toContain("right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] size-12");
  expect(chat).toContain("w-[25rem]");
  const classes = /aria-label="Unsaved changes" className="([^"]+)"/.exec(bar)?.[1]?.split(" ") ?? [];
  // Beside the button, at its height: 4rem of room at its right is the button's 3rem and the 1rem it stands in from the edge.
  expect(classes).toEqual(expect.arrayContaining(["sticky", "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]", "max-lg:mr-16"]));
  // Left of the card: its 25rem and the 0.625rem it stands in, less the page's own 2rem of padding, and a gap.
  expect(classes).toEqual(expect.arrayContaining(["lg:bottom-6", "lg:mr-[24.75rem]"]));
  // Not centred on the page, where its right end would lie under the card.
  expect(classes).not.toContain("mx-auto");
});
