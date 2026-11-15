/**
 * What a finger presses on a phone is at least 32px on its smaller side: the smallest button the dashboard draws there
 * (`btn-xs`, `main.css`). A pass over every page at a phone's width, in a real browser, measured these under it: a line
 * of text that is a link (16px), a pill (28 to 30), a box to tick whose label is one line tall, a switch with no label
 * around it (24), a round button inside a field or a chip (28). And one filter with no width left to it at all.
 *
 * A DOM here has no layout to measure, so each is held by the class that gives it its size, as the browser then drew
 * it. An icon alone in a `btn-xs` is held by `main.css`'s rule (`phone-type.test.ts`). The same pass found a button
 * whose words broke in two inside it.
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/);
/** The first `selector` on the page, a dialog over it included, whose words are `text`. */
const saying = (host: HTMLElement, selector: string, text: string | RegExp) =>
  [...host.ownerDocument.body.querySelectorAll<HTMLElement>(selector)].find((el) => (typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent?.trim() ?? "")));
/** A refusal that has words of its own and the server's under Details. */
const refused = { status: 500, body: { plain: "It could not be saved.", error: "config.toml is read-only", note: "Change it in the file." } };

describe("on every page", () => {
  test("the phone header's name is as tall as the button beside it", async () => {
    let brand: string[] = [];
    await renderPage("/", async (host) => {
      await eventually(() => saying(host, "header a", "Nouride") !== undefined, 3_000, "the header");
      brand = classes(saying(host, "header a", "Nouride"));
    });
    expect(brand).toContain("min-h-11");
  });
});

describe("a line of text that is pressed", () => {
  test("the way back from an agent's page", async () => {
    let back: string[] = [];
    await renderPage("/agents/nouva", async (host) => {
      await eventually(() => saying(host, "a", "Back to Agents") !== undefined, 3_000, "the agent's page");
      back = classes(saying(host, "a", "Back to Agents"));
    });
    expect(back).toEqual(expect.arrayContaining(["inline-flex", "items-center", "max-sm:min-h-8"]));
  });

  test("the sign-in page's credit", async () => {
    let credit: string[] = [];
    answer({ "/auth/me": { status: 401, body: { error: "unauthorized" } } });
    await renderPage("/login", async (host) => {
      await eventually(() => saying(host, "a", /^Powered by/) !== undefined, 3_000, "the sign-in page");
      credit = classes(saying(host, "a", /^Powered by/));
    });
    expect(credit).toEqual(expect.arrayContaining(["inline-flex", "items-center", "min-h-8"]));
  });

  test("System's folders, each a row, and where Nouride's files are", async () => {
    let rows: string[][] = [];
    let where: string[] = [];
    await renderPage("/system", async (host) => {
      await eventually(() => host.querySelectorAll("ul a.group").length > 0, 3_000, "the folders");
      rows = [...host.querySelectorAll("ul a.group")].map(classes);
      where = classes(host.querySelector("a.font-mono.text-primary"));
    });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((row) => row.includes("max-sm:min-h-8")).length).toBe(rows.length);
    // One line of small type: its own height and as much again around it.
    expect(where).toEqual(expect.arrayContaining(["text-xs", "max-sm:py-2"]));
  });

  test("Details, under a failure on the page and in a toast", async () => {
    let onPage: string[] = [];
    let inToast: string[] = [];
    const posts = recordPosts({ "/access/mode": refused, "/chat/send": refused });
    try {
      await renderPage("/agents/settings", async (host) => {
        await eventually(() => host.querySelector('input[aria-label="Accept new senders"]') !== null, 3_000, "the switch");
        host.querySelector<HTMLInputElement>('input[aria-label="Accept new senders"]')!.click();
        await eventually(() => host.querySelector('[role="alert"] summary') !== null, 3_000, "the failure's Details");
        onPage = classes(host.querySelector('[role="alert"] summary'));
      });
      await renderPage("/", async (host) => {
        await eventually(() => host.querySelector('input[aria-label^="Message "]') !== null, 3_000, "Quick chat");
        type(host.querySelector<HTMLInputElement>('input[aria-label^="Message "]')!, "hello");
        await eventually(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled === false, 2_000, "Send enabled");
        host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
        await eventually(() => host.ownerDocument.body.querySelector('[role="status"] summary') !== null, 3_000, "the toast's Details");
        inToast = classes(host.ownerDocument.body.querySelector('[role="status"] summary'));
      });
    } finally {
      posts.restore();
    }
    expect(onPage).toContain("max-sm:py-2");
    expect(inToast).toContain("max-sm:py-2");
  });
});

describe("a pill", () => {
  test("Home's update badge, and a turn's steps", async () => {
    let badge: string[] = [];
    let steps: string[] = [];
    await renderPage("/", async (host) => {
      await eventually(() => saying(host, "a", /available$/) !== undefined, 3_000, "the update badge");
      badge = classes(saying(host, "a", /available$/));
    });
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.querySelector("button.rounded-full.font-mono") !== null, 3_000, "the turn's steps");
      steps = classes(host.querySelector("button.rounded-full.font-mono"));
    });
    expect(badge).toEqual(expect.arrayContaining(["rounded-full", "max-sm:min-h-8"]));
    expect(steps).toEqual(expect.arrayContaining(["inline-flex", "items-center", "max-sm:min-h-8"]));
  });

  test("when an automation starts: each of the four, and the button in a field that shows its whole list", async () => {
    let starts: string[][] = [];
    let whole: string[] = [];
    await renderPage("/automations/new", async (host) => {
      await eventually(() => saying(host, "button", "At a time") !== undefined, 3_000, "the form");
      starts = [...saying(host, "button", "At a time")!.parentElement!.querySelectorAll("button")].map(classes);
      whole = classes(host.querySelector('button[aria-label="Show the whole list"]'));
    });
    expect(starts).toHaveLength(4);
    expect(starts.filter((start) => start.includes("max-sm:min-h-8")).length).toBe(4);
    expect(whole).toEqual(expect.arrayContaining(["size-7", "max-sm:size-8"]));
  });
});

describe("a box to tick, a switch", () => {
  test("each of an agent's tools is a row a finger's height, pressed anywhere along it", async () => {
    let rows: string[][] = [];
    let boxes = 0;
    let group: string[] = [];
    await renderPage("/agents/nouva/settings", async (host) => {
      await eventually(() => host.querySelectorAll("fieldset label").length > 0, 3_000, "the tools");
      rows = [...host.querySelectorAll("fieldset label")].map(classes);
      boxes = host.querySelectorAll('fieldset label > input[type="checkbox"]').length;
      group = classes(host.querySelector("fieldset"));
    });
    expect(rows.length).toBeGreaterThan(1);
    expect(boxes).toBe(rows.length);
    expect(rows.filter((row) => row.includes("max-sm:min-h-8")).length).toBe(rows.length);
    // The rows are their own room there: the gap a desktop puts between one-line rows is not added to it.
    expect(group).toEqual(expect.arrayContaining(["space-y-1.5", "max-sm:space-y-0"]));
  });

  test("a switch on its own, and one beside a word, are pressed by a label that tall", async () => {
    let accept: string[] = [];
    let acceptIn = "";
    let mentions: string[] = [];
    await renderPage("/agents/settings", async (host) => {
      await eventually(() => host.querySelector('input[aria-label="Accept new senders"]') !== null && saying(host, "label", /^(On|Off)$/) !== undefined, 3_000, "the switches");
      const label = host.querySelector('input[aria-label="Accept new senders"]')!.parentElement!;
      acceptIn = label.tagName;
      accept = classes(label);
      mentions = classes(saying(host, "label", /^(On|Off)$/));
    });
    expect(acceptIn).toBe("LABEL");
    expect(accept).toContain("min-h-8");
    expect(mentions).toContain("min-h-8");
  });
});

describe("a round button in a field or a chip", () => {
  test("Logs' clear-the-search, and the remove on an account being added to a person", async () => {
    let clear: string[] = [];
    let remove: string[] = [];
    await renderPage("/logs", async (host) => {
      await eventually(() => host.querySelector('input[placeholder^="Search the message"]') !== null, 3_000, "the log's search");
      type(host.querySelector<HTMLInputElement>('input[placeholder^="Search the message"]')!, "poll");
      await eventually(() => host.querySelector('button[aria-label="Clear search"]') !== null, 2_000, "the clear button");
      clear = classes(host.querySelector('button[aria-label="Clear search"]'));
    });
    await renderPage("/people", async (host) => {
      await eventually(() => saying(host, "button", "Edit") !== undefined, 3_000, "the people");
      saying(host, "button", "Edit")!.click();
      await eventually(() => host.ownerDocument.body.querySelector("span.font-mono button.btn-circle") !== null, 2_000, "an account's chip");
      remove = classes(host.ownerDocument.body.querySelector("span.font-mono button.btn-circle"));
    });
    expect(clear).toContain("max-sm:size-8");
    expect(clear).not.toContain("max-sm:size-7");
    expect(remove).toContain("max-sm:size-8");
    expect(remove).not.toContain("max-sm:size-7");
  });
});

describe("a button's words", () => {
  test("the two buttons that save a new automation share their row from their own widths, each on one line", async () => {
    // As equal halves of a bar that ends short of the chat's button, "Save automation" was two lines in a one-line button.
    let both: string[][] = [];
    await renderPage("/automations/new", async (host) => {
      await eventually(() => host.querySelectorAll('[aria-label="Unsaved changes"] button').length === 2, 3_000, "the bar that saves");
      both = [...host.querySelectorAll('[aria-label="Unsaved changes"] button')].map(classes);
    });
    expect(both).toHaveLength(2);
    expect(both.filter((button) => button.includes("whitespace-nowrap") && button.includes("max-sm:flex-auto")).length).toBe(2);
    expect(both.filter((button) => button.includes("max-sm:flex-1")).length).toBe(0);
  });
});

describe("Logs' filters", () => {
  test("the component filter keeps a width of its own on a phone, and takes the next line where the first has none left", async () => {
    // Told to share the line from nothing, it was given what the search and the level left: 28px, its arrow and no words.
    let filter: string[] = [];
    let line: string[] = [];
    await renderPage("/logs", async (host) => {
      await eventually(() => host.querySelector('button[aria-label^="Component: "]') !== null, 3_000, "the component filter");
      filter = classes(host.querySelector('button[aria-label^="Component: "]'));
      line = classes(host.querySelector('input[placeholder^="Search the message"]')!.parentElement!.parentElement);
    });
    expect(filter).toEqual(expect.arrayContaining(["max-sm:basis-36", "max-sm:grow", "max-sm:min-w-0"]));
    expect(filter).not.toContain("max-sm:flex-1");
    // Its line wraps: the filter can go under.
    expect(line).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
  });
});
