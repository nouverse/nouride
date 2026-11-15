/**
 * A preview of HTML an agent wrote (`commons/components/ui/HtmlPreview.tsx`, `commons/lib/html-preview.ts`): "Preview"
 * on an `html` block of a reply and on an `.html` file, which opens the page in a frame over the dashboard.
 *
 * The page is somebody else's. What is held here: it is opened by a press and never by itself; the frame is
 * sandboxed, with scripts and nothing else; its address is the daemon's preview route and names what is stored, a
 * turn and a place in its reply, or a file's path, never the page's own words; and it is offered only where there is
 * something stored to read back. What the page can then do is the daemon's policy and the browser's, seen in a real
 * one.
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

describe("an html block in a reply", () => {
  test("has Preview on it and only on it, and nothing is opened until it is pressed", async () => {
    answer(chat(REPLY));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => previews(host).length > 0, 5_000, "the block's Preview");
      expect(previews(host)).toHaveLength(1);
      // On the html block's own head, not the js block's.
      expect(previews(host)[0]!.closest("[data-block-head]")!.textContent).toMatch(/^html/i);
      expect(host.ownerDocument.body.querySelector("iframe") === null).toBe(true);
      // Its words are still its code: a preview is beside the block, not in its place.
      expect(host.querySelector("pre code")!.textContent).toBe(PAGE);
    });
  });

  test("a press opens it in a frame that runs its scripts and nothing else, at the daemon's address for that block", async () => {
    answer(chat(REPLY));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => previews(host).length > 0, 5_000, "the block's Preview");
      previews(host)[0]!.click();
      await eventually(() => frame(host) !== null, 2_000, "the frame");
      const drawn = frame(host)!;
      expect(drawn.getAttribute("sandbox")).toBe("allow-scripts");
      expect(drawn.getAttribute("src")).toBe(`/api/control/preview/turn/turn_1?at=${REPLY.indexOf(PAGE)}&length=${PAGE.length}`);
      expect(drawn.getAttribute("referrerpolicy")).toBe("no-referrer");
      // Never filled from the page: a frame the dashboard filled would run under the dashboard's own policy.
      expect(drawn.hasAttribute("srcdoc")).toBe(false);
      const dialog = drawn.closest('[role="dialog"]')!;
      expect(dialog.getAttribute("aria-label")).toBe("Preview of an html block");
      // As wide as the screen leaves it, never a width of its own that a phone's screen is narrower than.
      expect(drawn.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "max-w-[76rem]"]));
      // The same address in a tab of its own, where the daemon's policy still holds it.
      expect(dialog.querySelector("a")!.getAttribute("href")).toBe(drawn.getAttribute("src"));
      expect(dialog.querySelector("a")!.getAttribute("rel")).toBe("noopener noreferrer");
      dialog.querySelector<HTMLButtonElement>('button[aria-label="Close the preview"]')!.click();
      await eventually(() => frame(host) === null || frame(host)!.closest("[data-leaving]") !== null, 2_000, "the preview closed");
    });
  });

  test("Escape closes it", async () => {
    answer(chat(REPLY));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => previews(host).length > 0, 5_000, "the block's Preview");
      previews(host)[0]!.click();
      await eventually(() => frame(host) !== null, 2_000, "the frame");
      host.ownerDocument.defaultView!.dispatchEvent(new (host.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape" }));
      await eventually(() => frame(host) === null || frame(host)!.closest("[data-leaving]") !== null, 2_000, "the preview closed");
    });
  });

  test("a reply with no html block offers none, and a block in another language whose words are a page offers none", async () => {
    for (const reply of ["```js\nconsole.log(1)\n```", `\`\`\`xml\n${PAGE}\n\`\`\``, `\`\`\`\n${PAGE}\n\`\`\``]) {
      answer(chat(reply));
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => host.querySelector("pre code") !== null, 5_000, "the block");
        expect(previews(host)).toHaveLength(0);
      });
    }
  });

  test("a block indented under a list item is previewed by the place its words are in the reply, indent and all", async () => {
    const reply = "1. A page:\n\n   ```html\n   <p>one</p>\n   <p>two</p>\n   ```";
    answer(chat(reply));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => previews(host).length > 0, 5_000, "the block's Preview");
      previews(host)[0]!.click();
      await eventually(() => frame(host) !== null, 2_000, "the frame");
      const [, from, length] = /at=(\d+)&length=(\d+)/.exec(frame(host)!.getAttribute("src")!)!;
      // What the address names is the block's own lines, and nothing of the fence around them.
      expect(reply.slice(Number(from), Number(from) + Number(length)).trim()).toBe("<p>one</p>\n   <p>two</p>");
    });
  });
});

describe("where nothing stored can be read back", () => {
  test("an html block in a mission's report has no Preview: only a reply's does", async () => {
    const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
    answer({ "/missions/msn_1": ok({ ...shown, mission: { ...shown.mission, status: "done", seen: "done", report: `The page:\n\n\`\`\`html\n${PAGE}\n\`\`\`` } }) });
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => host.querySelector("pre code")?.textContent === PAGE, 5_000, "the report's block");
      expect(previews(host)).toHaveLength(0);
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
