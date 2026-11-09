/**
 * System Logs on a phone (0.8.12). On an iPhone each daemon log row was a desktop row squeezed — the message a
 * column three letters wide ("poll / ing / sta / rte") beside a fixed-width time and the component — and the audit
 * trail a five-column table scrolling sideways inside its card. On a phone a log row is a block: the time and the
 * component on its first line, the message the whole width under them; an audit row the same. From `sm` up both are as
 * they were. And the page scrolls as a document there, so the rows are not a sliver under the filters.
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const message = "polling started for the bot's updates";

const logs = ok({
  entries: [{ id: 1, ts: 1_793_496_000_000, level: "info", component: "gateway.telegram:nix", message, data: { offset: 0 } }],
  total: 1,
  components: [{ component: "gateway.telegram:nix", entries: 1 }],
  span: { oldest: 1_793_496_000_000, newest: 1_793_496_000_000 },
  retentionDays: 3,
});
const audit = ok({
  entries: [{ id: "a1", timestamp: 1_793_496_000_000, action: "webhook_create", actor: "cli", agentId: "nova", details: { job: "cron_a446cfc7c25747cf9b90", name: "GitHub CI failure on nouverse/integrated/nouride-dashboard-mobile" } }],
});

/** The class of the element whose own text starts with `text`. */
const classOf = (host: HTMLElement, selector: string, text: string) =>
  [...host.querySelectorAll(selector)].find((el) => el.firstChild?.textContent?.startsWith(text))?.getAttribute("class") ?? "";

test("a daemon log row: its message the whole width under the time and the component on a phone, beside them from sm up", async () => {
  answer({ "/logs/stored": logs });
  let row = "";
  let messageClass = "";
  let page = "";
  await renderPage("/logs", async (host) => {
    await eventually(() => host.textContent?.includes(message) === true, 2_000, "the log row");
    messageClass = classOf(host, "span", message);
    row = host.querySelector("button.text-left")?.getAttribute("class") ?? "";
    page = host.querySelector("main > div")?.getAttribute("class") ?? "";
  });
  const words = messageClass.split(" ");
  expect(words).toEqual(expect.arrayContaining(["basis-full", "max-sm:order-last", "sm:basis-0", "sm:flex-1", "text-sm", "sm:text-xs"]));
  expect(row.split(" ")).toEqual(expect.arrayContaining(["flex-wrap", "sm:flex-nowrap"]));
  // A document on a phone, held to the window from a laptop up.
  expect(page.split(" ")).toEqual(expect.arrayContaining(["overflow-y-auto", "lg:overflow-hidden"]));
});

test("an audit row: a block on a phone, its details the whole width; the table and its header from sm up", async () => {
  answer({ "/audit": audit });
  let table = "";
  let head = "";
  let details = "";
  await renderPage("/logs", async (host) => {
    ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Audit") as HTMLElement).click();
    await eventually(() => host.textContent?.includes("webhook_create") === true, 2_000, "the audit row");
    table = host.querySelector("table")?.getAttribute("class") ?? "";
    head = host.querySelector("thead")?.getAttribute("class") ?? "";
    details = [...host.querySelectorAll("td")].find((td) => td.textContent?.includes("GitHub CI failure"))?.getAttribute("class") ?? "";
  });
  expect(table.split(" ")).toContain("max-sm:block");
  expect(head.split(" ")).toContain("max-sm:hidden");
  expect(details.split(" ")).toEqual(expect.arrayContaining(["max-sm:basis-full", "max-sm:max-w-none"]));
});
