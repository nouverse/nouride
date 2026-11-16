/**
 * A page of HTML an agent wrote, looked at (`commons/lib/html-preview.ts`): an `html` block of a reply is drawn in the
 * reply itself, in a frame (`commons/components/ui/HtmlFrame.tsx`), and an `.html` file has "Preview", which opens it
 * in a frame over the dashboard (`HtmlPreview.tsx`).
 *
 * The page is somebody else's. What is held here: the frame is sandboxed, with scripts and nothing else; its address
 * is the daemon's preview route and names what is stored, a turn and a place in its reply, or a file's path, never
 * the page's own words; it is drawn only where there is something stored to read back; what the frame hears of its
 * height is a number held to bounds, from its own page alone; and a file's page is opened by a press. What the page
 * can then do is the daemon's policy and the browser's, seen in a real one.
 */

import { describe, expect, test } from "bun:test";
import { fileHtmlPreview, isHtmlFile, namesHtml, turnHtmlPreview } from "@/commons/lib/html-preview";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const PAGE = '<!doctype html>\n<h1>Menu</h1>\n<script>document.title = "ran"</script>';
const REPLY = ["The mockup:", "", "```html", PAGE, "```", "", "```js", "console.log(1)", "```"].join("\n");

describe("where a block is previewed", () => {
  test("by the turn and where the block is in its reply, never by its words", () => {
    const address = turnHtmlPreview("turn_1", REPLY)(PAGE);
    expect(address).toBe(`/api/control/preview/turn/turn_1?at=${REPLY.indexOf(PAGE)}&length=${PAGE.length}`);
    expect(address).not.toContain("Menu");
    // An id is one part of the path, whatever it holds.
    expect(turnHtmlPreview("turn/1?x", REPLY)(PAGE)).toStartWith("/api/control/preview/turn/turn%2F1%3Fx?at=");
  });

  test("none for words that are not an html block of the reply: not in it, in another block, or quoted in its prose", () => {
    const preview = turnHtmlPreview("turn_1", REPLY);
    expect(preview("<p>elsewhere</p>")).toBeNull();
    expect(preview("console.log(1)")).toBeNull();
    expect(preview("The mockup:")).toBeNull();
    expect(preview("")).toBeNull();
    // Quoted first in the prose and then written as a block: the block's own place, which the daemon serves.
    const twice = `I will write <p>hi</p> for you:\n\n\`\`\`html\n<p>hi</p>\n\`\`\``;
    expect(turnHtmlPreview("turn_1", twice)("<p>hi</p>")).toBe(`/api/control/preview/turn/turn_1?at=${twice.lastIndexOf("<p>hi</p>")}&length=9`);
  });

  test("html written with no fence is previewed by where its run is in the reply, and none where it is only quoted", () => {
    const raw = "Raw:\n\n<div>one</div>\n\nDone.";
    expect(turnHtmlPreview("turn_1", raw)("<div>one</div>")).toBe("/api/control/preview/turn/turn_1?at=6&length=14");
    expect(turnHtmlPreview("turn_1", "I wrote <div>one</div> for you.")("<div>one</div>")).toBeNull();
    // Quoted in the prose first, then written on lines of its own: the run's own place.
    const twice = "I will write <div>one</div> now:\n\n<div>one</div>";
    expect(turnHtmlPreview("turn_1", twice)("<div>one</div>")).toBe(`/api/control/preview/turn/turn_1?at=${twice.lastIndexOf("<div>one</div>")}&length=14`);
  });

  test("a file by its path, and which names are pages and which fences are html", () => {
    expect(fileHtmlPreview("workspace/private/nix/menu a&b.html")).toBe("/api/control/preview/file?path=workspace%2Fprivate%2Fnix%2Fmenu%20a%26b.html");
    expect(["menu.html", "MENU.HTM", "a.b.html"].map(isHtmlFile)).toEqual([true, true, true]);
    expect(["menu.html.txt", "notes.md", "html", "page.xhtml2"].map(isHtmlFile)).toEqual([false, false, false, false]);
    expect(["html", "HTML", " html title=menu"].map(namesHtml)).toEqual([true, true, true]);
    expect(["htmlbars", "xml", "", undefined].map(namesHtml)).toEqual([false, false, false, false]);
  });
});

const transcript = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] } & Record<string, unknown>;
const chat = (reply: string) => ({
  "/sessions/ses_1/turns": ok({ ...transcript, turns: [{ ...transcript.turns[0], reply }] }),
  "/sessions/ses_1/live": ok({ turn: null, jobs: [] }),
});
const previews = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Preview");
const frame = (host: HTMLElement) => host.ownerDocument.body.querySelector<HTMLIFrameElement>('[role="dialog"] iframe');

/** The frame an html block of a reply is drawn in, inside the reply. */
const page = (host: HTMLElement) => host.querySelector<HTMLIFrameElement>('[data-viewer="page"] iframe');
/** A button of the block's switch between its page and its code. */
const showAs = (host: HTMLElement, as: "Preview" | "Code") => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Show as"] button')].find((button) => button.textContent?.trim() === as);

describe("an html block in a reply", () => {
  test("is drawn in the reply itself, in a frame that runs its scripts and nothing else, at the daemon's address for that block", async () => {
    answer(chat(REPLY));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => page(host) !== null, 5_000, "the block's page");
      const drawn = page(host)!;
      expect(drawn.getAttribute("sandbox")).toBe("allow-scripts");
      expect(drawn.getAttribute("src")).toBe(`/api/control/preview/turn/turn_1?at=${REPLY.indexOf(PAGE)}&length=${PAGE.length}`);
      expect(drawn.getAttribute("referrerpolicy")).toBe("no-referrer");
      // Asked for when it comes near the screen: a long chat does not load every page in it.
      expect(drawn.getAttribute("loading")).toBe("lazy");
      // Never filled from the page: a frame the dashboard filled would run under the dashboard's own policy.
      expect(drawn.hasAttribute("srcdoc")).toBe(false);
      // In the chat, not over it: nothing opens, and the one frame is the html block's own. The js block is code.
      expect(host.ownerDocument.body.querySelector('[role="dialog"]') === null).toBe(true);
      expect(host.ownerDocument.body.querySelectorAll("iframe")).toHaveLength(1);
      expect(drawn.closest("[data-viewer]")!.querySelector("[data-block-head]")!.textContent).toMatch(/^html/i);
      // The page's words are the frame's, never elements of the dashboard's own page.
      expect([...host.querySelectorAll("h1")].filter((heading) => heading.textContent?.trim() === "Menu")).toHaveLength(0);
    });
  });

  test("its code is a press away and its page a press back, and a link opens the page in a tab of its own", async () => {
    answer(chat(REPLY));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => page(host) !== null, 5_000, "the block's page");
      const address = page(host)!.getAttribute("src");
      expect(showAs(host, "Preview")!.getAttribute("aria-pressed")).toBe("true");
      showAs(host, "Code")!.click();
      await eventually(() => page(host) === null, 2_000, "the block as its code");
      expect([...host.querySelectorAll("pre code")].map((code) => code.textContent)).toContain(PAGE);
      // The same address in a tab of its own, where the daemon's policy still holds it; there as its code too.
      const link = host.querySelector<HTMLAnchorElement>('a[aria-label="Open in a tab"]')!;
      expect(link.getAttribute("href")).toBe(address);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      showAs(host, "Preview")!.click();
      await eventually(() => page(host) !== null, 2_000, "the block as its page again");
    });
  });

  test("is as tall as its page says, within bounds, and hears no other's word for it", async () => {
    answer(chat(REPLY));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => page(host) !== null, 5_000, "the block's page");
      const drawn = page(host)!;
      const view = host.ownerDocument.defaultView as unknown as Window & { MessageEvent: typeof MessageEvent };
      const own = {};
      let its: object | null = own;
      Object.defineProperty(drawn, "contentWindow", { configurable: true, get: () => its });
      const says = (data: unknown, source: unknown = own) => view.dispatchEvent(new view.MessageEvent("message", { data, source: source as MessageEventSource }));
      const tall = () => drawn.style.height;
      // Before its page has said anything: the window a page that fills its window is given.
      expect(tall()).toBe("320px");
      expect(drawn.className.split(" ")).toContain("max-h-[70dvh]");
      says({ nouridePreviewHeight: 231.4 });
      await eventually(() => tall() === "232px", 2_000, "the page's own height");
      // A page far taller than a chat scrolls inside its frame; one with nothing in it still has a frame to be seen.
      says({ nouridePreviewHeight: 99_999 });
      await eventually(() => tall() === "640px", 2_000, "held to the tallest");
      says({ nouridePreviewHeight: 3 });
      await eventually(() => tall() === "40px", 2_000, "held to the least");
      // Not its own frame's word, and not a height: each comes after the page's own and none of them is the last heard.
      says({ nouridePreviewHeight: 123 });
      says({ nouridePreviewHeight: 300 }, {});
      says({ nouridePreviewHeight: 300 }, null);
      says({ nouridePreviewHeight: "300" });
      says({ nouridePreviewHeight: Number.NaN });
      says("300");
      says(null);
      // A frame with no window of its own yet is nobody: a message from nowhere is not its page's.
      its = null;
      says({ nouridePreviewHeight: 300 }, null);
      its = own;
      await eventually(() => tall() === "123px", 2_000, "the page's own word, and no other's");
      // Drawn again, it is as tall as its page last said: nothing jumps when the block comes back from its code.
      showAs(host, "Code")!.click();
      await eventually(() => page(host) === null, 2_000, "the block as its code");
      showAs(host, "Preview")!.click();
      await eventually(() => page(host) !== null, 2_000, "the block as its page again");
      expect(page(host)!.style.height).toBe("123px");
    });
  });

  test("a reply with no html block draws no page, and a block in another language whose words are a page draws none", async () => {
    for (const reply of ["```js\nconsole.log(1)\n```", `\`\`\`xml\n${PAGE}\n\`\`\``, `\`\`\`\n${PAGE}\n\`\`\``]) {
      answer(chat(reply));
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => host.querySelector("pre code") !== null, 5_000, "the block");
        expect(host.ownerDocument.body.querySelector("iframe") === null).toBe(true);
        expect(showAs(host, "Preview")).toBeUndefined();
      });
    }
  });

  test("a block indented under a list item is drawn from the place its words are in the reply, indent and all", async () => {
    const reply = "1. A page:\n\n   ```html\n   <p>one</p>\n   <p>two</p>\n   ```";
    answer(chat(reply));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => page(host) !== null, 5_000, "the block's page");
      const [, from, length] = /at=(\d+)&length=(\d+)/.exec(page(host)!.getAttribute("src")!)!;
      // What the address names is the block's own lines, and nothing of the fence around them.
      expect(reply.slice(Number(from), Number(from) + Number(length)).trim()).toBe("<p>one</p>\n   <p>two</p>");
    });
  });
});

describe("html written straight into a reply, with no code block around it", () => {
  // As an agent asked to "write some html here" wrote it: a card and a table as lines of tags, between its prose.
  const CARD = ['<div style="padding:16px">', "  <h3>Render test</h3>", "  <button>A button</button>", "</div>"].join("\n");
  const RUN = [CARD, "", "<table><tr><td>a cell</td></tr></table>"].join("\n");
  const RAW = ["Here it is, raw:", "", RUN, "", "What to check:", "", "<b>Note:</b> a sentence that begins with a tag."].join("\n");

  test("is one html block, drawn in the reply at the daemon's address for where it is, and nothing of it drawn by the dashboard", async () => {
    answer(chat(RAW));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => page(host) !== null, 5_000, "the run's page");
      expect(host.ownerDocument.body.querySelectorAll("iframe")).toHaveLength(1);
      expect(page(host)!.getAttribute("src")).toBe(`/api/control/preview/turn/turn_1?at=${RAW.indexOf(RUN)}&length=${RUN.length}`);
      expect(page(host)!.getAttribute("sandbox")).toBe("allow-scripts");
      expect(page(host)!.closest("[data-viewer]")!.querySelector("[data-block-head]")!.textContent).toMatch(/^html/i);
      // No tag is left as a line of prose, and none became an element of the dashboard's page.
      expect([...host.querySelectorAll("p")].filter((line) => /<div|<table|<\/div/.test(line.textContent ?? ""))).toHaveLength(0);
      expect([...host.querySelectorAll("h3, button, td")].filter((drawn) => /^(Render test|A button|a cell)$/.test(drawn.textContent?.trim() ?? ""))).toHaveLength(0);
      // The card and the table are one block: its code is its words as they were written, blank line and all.
      showAs(host, "Code")!.click();
      await eventually(() => page(host) === null, 2_000, "the run as its code");
      expect([...host.querySelectorAll("pre code")].map((code) => code.textContent)).toEqual([RUN]);
    });
  });

  test("a sentence that begins with a tag stays a sentence", async () => {
    answer(chat(RAW));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => page(host) !== null, 5_000, "the run's page");
      expect([...host.querySelectorAll("p")].filter((line) => line.textContent === "<b>Note:</b> a sentence that begins with a tag.")).toHaveLength(1);
    });
  });
});

describe("where nothing stored can be read back", () => {
  test("an html block in a mission's report is its code, with no page drawn: only a reply's is", async () => {
    const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
    answer({ "/missions/msn_1": ok({ ...shown, mission: { ...shown.mission, status: "done", seen: "done", report: `The page:\n\n\`\`\`html\n${PAGE}\n\`\`\`` } }) });
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => host.querySelector("pre code")?.textContent === PAGE, 5_000, "the report's block");
      expect(previews(host)).toHaveLength(0);
      expect(host.ownerDocument.body.querySelector("iframe") === null).toBe(true);
      expect(showAs(host, "Preview")).toBeUndefined();
    });
  });
});

describe("an .html file in Files", () => {
  const entry = { name: "menu.html", path: "workspace/menu.html", kind: "file", sizeBytes: 71, modifiedAt: Date.now() - 60_000, removable: true };
  const files = (name: string) => {
    const file = { ...entry, name, path: `workspace/${name}` };
    return {
      [`/system/files?path=workspace/${name}`]: ok({ path: file.path, entries: [], more: 0, leftOut: false, file }),
      [`/system/files/read?path=workspace/${name}`]: ok({ entry: file, kind: "text", text: PAGE, truncated: false, masked: false }),
    };
  };

  test("has Preview beside its other buttons, which opens the file by its path in the same frame", async () => {
    answer(files("menu.html"));
    await renderPage("/files?path=workspace/menu.html", async (host) => {
      await eventually(() => previews(host).length > 0, 5_000, "the file's Preview");
      expect(host.ownerDocument.body.querySelector("iframe") === null).toBe(true);
      // Read as its source until then: the page is not run by opening the file.
      expect(host.querySelector("pre")!.textContent).toContain("<h1>Menu</h1>");
      previews(host)[0]!.click();
      await eventually(() => frame(host) !== null, 2_000, "the frame");
      expect(frame(host)!.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame(host)!.getAttribute("src")).toBe("/api/control/preview/file?path=workspace%2Fmenu.html");
      expect(frame(host)!.closest('[role="dialog"]')!.getAttribute("aria-label")).toBe("Preview of menu.html");
    });
  });

  test("a file that is not a page has none", async () => {
    answer(files("menu.txt"));
    await renderPage("/files?path=workspace/menu.txt", async (host) => {
      await eventually(() => host.querySelector("pre") !== null, 5_000, "the file");
      expect(previews(host)).toHaveLength(0);
    });
  });
});
