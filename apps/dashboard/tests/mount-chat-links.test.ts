/**
 * A link in an agent's answer, in the chat that floats over a page: one to a page of this dashboard opens that page
 * under the chat, in place. Through the whole app, as a person meets it.
 *
 * The agent is told the page a person has open, and the dashboard's pages (`pagesNote` in the engine), so "take me
 * there" is answered with a link. Each case is a way that link would let somebody down: drawn as words with nothing
 * to click, opened in a second tab beside the dashboard, the chat gone with the page it was over, a phone left looking
 * at the sheet while the page changed under it, or a click taken from somebody who asked for a new tab.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { answer, dom, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY, sheet } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

afterEach(() => {
  dom.localStorage.removeItem(LAST_AGENT_KEY);
  dom.happyDOM.setViewport({ width: 1024, height: 768 });
});

const transcript = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] } & Record<string, unknown>;
/** The conversation, its one answer written as an agent asked "take me there" writes it. */
const answered = (reply: string) => ({ ...AT_REST, "/sessions/ses_1/turns": { status: 200, body: { ...transcript, turns: [{ ...transcript.turns[0]!, reply }] } } });

const REPLY = [
  "Here: [Open the graph](/dashboard/memories/graph).",
  "Its docs are at [the manual](https://example.com/docs), and the keys at [the route](/api/control/secrets).",
  "Or open http://localhost/dashboard/automations/cron_1 for the job.",
].join("\n\n");

const linkTo = (panel: HTMLElement | null, href: string) => (panel?.querySelector(`a[href="${href}"]`) ?? null) as HTMLAnchorElement | null;
const staying = () => card() !== null && card()!.parentElement?.hasAttribute("data-leaving") === false;

async function open(host: HTMLElement, panel: () => HTMLElement | null = card): Promise<void> {
  await eventually(() => floatButton(host) !== null, 3_000, "the button");
  floatButton(host)!.click();
  await eventually(() => boxIn(panel()) !== null, 3_000, "the conversation in the panel");
  await eventually(() => panel()?.textContent?.includes("Open the graph") === true, 3_000, "the answer");
}

/**
 * A click as a browser sends one, with a key held or none, and whether the page took it for itself: what it does not
 * take, the browser then opens its own way. Stopped once the page has had it, so the test's own window opens nothing.
 */
function click(link: HTMLElement, held?: "metaKey" | "ctrlKey" | "shiftKey"): { taken: boolean } {
  const seen = { taken: false };
  const after = (event: Event) => {
    seen.taken = event.defaultPrevented;
    event.preventDefault();
  };
  dom.document.addEventListener("click", after as never, { once: true });
  const view = dom as unknown as { MouseEvent: new (type: string, init: Record<string, unknown>) => Event };
  link.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...(held ? { [held]: true } : {}) }));
  return seen;
}

describe("a link in an answer, in the floating chat", () => {
  test("to a page of this dashboard is a link, and a click opens that page under the chat, which stays open", async () => {
    answer(answered(REPLY));
    await renderPage("/skills", async (host, app) => {
      await open(host);
      const graph = linkTo(card(), "/dashboard/memories/graph");
      expect(graph, "the path, drawn as a link").not.toBeNull();
      expect(graph!.textContent).toBe("Open the graph");
      // In place: no second tab, and no sign that it leaves the dashboard.
      expect(graph!.hasAttribute("target")).toBe(false);
      expect(graph!.querySelector("svg")).toBeNull();

      // Taken from the browser, which would load the whole dashboard again to show one page of it.
      expect(click(graph!).taken).toBe(true);
      await eventually(() => app.location() === "/memories/graph", 3_000, "the page opened");
      expect(staying()).toBe(true);
      expect(card()!.textContent).toContain("Open the graph");

      // This dashboard's own address in full is the same: the page, here.
      const job = linkTo(card(), "/dashboard/automations/cron_1");
      expect(job, "the full address, drawn as a page's link").not.toBeNull();
      expect(job!.hasAttribute("target")).toBe(false);
      expect(job!.textContent).toBe("http://localhost/dashboard/automations/cron_1");
      job!.click();
      await eventually(() => app.location() === "/automations/cron_1", 3_000, "the job's page opened");
      expect(staying()).toBe(true);
    });
  });

  test("anywhere else on the web opens in a new tab, and the daemon's own route is words with nothing to click", async () => {
    answer(answered(REPLY));
    await renderPage("/skills", async (host, app) => {
      await open(host);
      const manual = linkTo(card(), "https://example.com/docs");
      expect(manual?.getAttribute("target")).toBe("_blank");
      expect(manual?.getAttribute("rel")).toBe("noreferrer noopener");
      expect(card()!.textContent).toContain("the route");
      expect(card()!.querySelector('a[href*="/api/control"]')).toBeNull();
      expect(app.location()).toBe("/skills");
    });
  });

  test("a click with a key held is the browser's: a new tab is what was asked for, and this page stays", async () => {
    answer(answered(REPLY));
    await renderPage("/skills", async (host, app) => {
      await open(host);
      const graph = linkTo(card(), "/dashboard/memories/graph")!;
      for (const key of ["metaKey", "ctrlKey", "shiftKey"] as const) expect(click(graph, key).taken, key).toBe(false);
      expect(app.location()).toBe("/skills");
    });
  });

  test("on a phone the sheet is put away as the page opens: the page is what was asked for, and it is under the sheet", async () => {
    dom.happyDOM.setViewport({ width: 390, height: 844 });
    answer(answered(REPLY));
    await renderPage("/skills", async (host, app) => {
      await open(host, sheet);
      linkTo(sheet(), "/dashboard/memories/graph")!.click();
      await eventually(() => app.location() === "/memories/graph", 3_000, "the page opened");
      await eventually(() => sheet() === null, 3_000, "the sheet put away");
    });
  });
});
