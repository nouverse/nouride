/**
 * An `svg` block in a reply drawn as its picture (`commons/components/ui/viewers/svg.tsx`): an `<img>` with a `data:`
 * address on a white card, opened large on a press, and never markup in the page.
 *
 * The block here carries a script, an event handler and a link out: as a picture none of them is an element of the
 * page. That the browser runs nothing of an SVG drawn as an image is the browser's rule, seen in a real one.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.hit=1"><script>window.hit=2</script><a href="https://example.com"><circle cx="20" cy="20" r="18" fill="teal"/></a></svg>';

function reply(text: string) {
  const transcript = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] } & Record<string, unknown>;
  answer({
    "/sessions/ses_1/turns": { status: 200, body: { ...transcript, turns: [{ ...transcript.turns[0], reply: text }] } },
    "/sessions/ses_1/live": { status: 200, body: { turn: null, jobs: [] } },
  });
}

describe("an svg block in a reply", () => {
  test("is an <img> with a data: address on a white card, and none of its markup is in the page", async () => {
    reply(["The logo:", "", "```svg", SVG, "```"].join("\n"));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.querySelector('[data-viewer="picture"] img') !== null, 5_000, "the picture");
      const img = host.querySelector<HTMLImageElement>('[data-viewer="picture"] img')!;
      expect(img.getAttribute("src")!.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
      expect(decodeURIComponent(img.getAttribute("src")!.split(",")[1]!)).toBe(SVG);
      expect(img.closest("button")!.className).toContain("bg-white");
      // Nothing of the SVG became an element of the page: no svg, no script, no circle, no link out.
      expect(host.ownerDocument.querySelector("circle[fill=teal], script, a[href='https://example.com'], [onload]")).toBeNull();
      expect(host.ownerDocument.body.innerHTML).not.toContain('fill="teal"');
    });
  });

  test("one that names only its viewBox is drawn with the viewBox's size: with none it was a picture zero wide", async () => {
    reply(["```svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect width="200" height="80" fill="teal"/></svg>', "```"].join("\n"));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.querySelector('[data-viewer="picture"] img') !== null, 5_000, "the picture");
      const drawn = decodeURIComponent(host.querySelector('[data-viewer="picture"] img')!.getAttribute("src")!.split(",")[1]!);
      expect(drawn.startsWith('<svg width="200" height="80" xmlns=')).toBe(true);
    });
  });

  test("a press opens it large as a sent picture, with save and no tab to open", async () => {
    reply(["```svg", SVG, "```"].join("\n"));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.querySelector('[data-viewer="picture"] img') !== null, 5_000, "the picture");
      host.querySelector<HTMLElement>('button[aria-label="Open the picture large"]')!.click();
      const doc = host.ownerDocument;
      await eventually(() => doc.querySelector('[role="dialog"][aria-label="picture.svg"] img') !== null, 2_000, "the popup");
      const dialog = doc.querySelector('[role="dialog"][aria-label="picture.svg"]')!;
      expect(dialog.querySelector("img")!.getAttribute("src")).toBe(host.querySelector('[data-viewer="picture"] img')!.getAttribute("src"));
      expect(dialog.querySelector("img")!.className).toContain("bg-white");
      // A drawing has no pixels of its own: opened as wide as the window lets it, not at the 40px it names.
      expect(dialog.querySelector("img")!.className.split(" ")).toContain("w-[min(92vw,64rem)]");
      const links = [...dialog.querySelectorAll("a")].map((a) => a.textContent?.trim());
      expect(links).toEqual(["save"]);
      expect(dialog.querySelector("a[download]")!.getAttribute("download")).toBe("picture.svg");
    });
  });

  test("a growing svg block is its code", async () => {
    reply(["```svg", SVG].join("\n"));
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.querySelector("pre code") !== null, 5_000, "the block");
      expect(host.querySelector("pre code")!.textContent).toBe(SVG);
      expect(host.querySelector('[data-viewer="picture"]')).toBeNull();
    });
  });
});
