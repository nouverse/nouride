/**
 * The files of one message as one set: its pictures open as a gallery, gone through by key, by
 * the buttons beside the picture and by a swipe; "Download all" fetches every file still on disk and hands them over
 * as one archive, named after the set, saying how far it is and which file stopped it.
 *
 * The archive's bytes are read back by the daemon's own reader in the engine's tests (`dashboard-zip.test.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { archiveName } from "@/commons/lib/download-all";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const picture = (name: string) => ({ name, mimeType: "image/png", kind: "image", direction: "out" as const, url: `files/${name}` });
const SET = [picture("slide-01.png"), picture("slide-02.png"), { name: "notes.pdf", mimeType: "application/pdf", kind: "document", direction: "out" as const, url: "files/notes.pdf" }, picture("slide-03.png"), { name: "gone.png", mimeType: "image/png", kind: "image", direction: "out" as const }];

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

async function mount(files: unknown[]) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AttachmentList } = await import("@/commons/components/chat/Attachments");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  root.render(React.createElement(AttachmentList, { sessionId: "ses_1", files: files as never }));
  unmount = () => (root.unmount(), host.remove());
  await eventually(() => host.querySelector("img") !== null, 2_000, "the pictures");
  return host;
}

const doc = () => dom.document as unknown as Document;
const dialog = () => doc().querySelector<HTMLElement>('[role="dialog"]');
const shownName = () => dialog()?.getAttribute("aria-label") ?? null;
const counter = () => dialog()?.querySelector("[aria-live]")?.textContent ?? null;
const key = (name: string) => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name }) as never);
const pointer = (type: string, x: number, y: number, kind = "touch") => dialog()!.dispatchEvent(new dom.PointerEvent(type, { clientX: x, clientY: y, pointerType: kind, bubbles: true }) as never);

describe("a message's pictures", () => {
  test("open as one gallery where the one pressed is, and go by key, stopping at each end", async () => {
    const host = await mount(SET);
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.querySelector("img[alt='slide-02.png']"))!.click();
    await eventually(() => shownName() === "slide-02.png", 2_000, "the gallery");
    expect(counter()).toBe("2 / 3");
    key("ArrowRight");
    await eventually(() => shownName() === "slide-03.png", 1_000, "the next");
    key("ArrowRight");
    expect(shownName()).toBe("slide-03.png");
    key("ArrowLeft");
    key("ArrowLeft");
    await eventually(() => shownName() === "slide-01.png", 1_000, "back to the first");
    expect(counter()).toBe("1 / 3");
    expect(dialog()!.querySelector<HTMLButtonElement>('[aria-label="The picture before"]')!.disabled).toBe(true);
  });

  test("go by the buttons beside the picture, and by a swipe of a finger, not of a mouse or a scroll up", async () => {
    const host = await mount(SET);
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.querySelector("img[alt='slide-01.png']"))!.click();
    await eventually(() => shownName() === "slide-01.png", 2_000, "the gallery");
    dialog()!.querySelector<HTMLButtonElement>('[aria-label="The next picture"]')!.click();
    await eventually(() => shownName() === "slide-02.png", 1_000, "the next by its button");
    pointer("pointerdown", 300, 400);
    pointer("pointerup", 200, 410);
    await eventually(() => shownName() === "slide-03.png", 1_000, "the next by a swipe left");
    pointer("pointerdown", 100, 400);
    pointer("pointerup", 200, 420);
    await eventually(() => shownName() === "slide-02.png", 1_000, "the one before by a swipe right");
    // A mouse dragged, a short slide, and a finger moving more up than across turn nothing.
    pointer("pointerdown", 300, 400, "mouse");
    pointer("pointerup", 100, 400, "mouse");
    pointer("pointerdown", 300, 400);
    pointer("pointerup", 270, 400);
    pointer("pointerdown", 300, 400);
    pointer("pointerup", 240, 200);
    // Had any of them turned the picture, a swipe right would not land on the first.
    pointer("pointerdown", 100, 400);
    pointer("pointerup", 200, 400);
    await eventually(() => shownName() === "slide-01.png", 1_000, "the first, by a swipe right from the second");
    expect(counter()).toBe("1 / 3");
  });

  test("a swipe is not a press on the backdrop, and the page does not take the finger's sideways move", async () => {
    const host = await mount(SET);
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.querySelector("img[alt='slide-01.png']"))!.click();
    await eventually(() => shownName() === "slide-01.png", 2_000, "the gallery");
    // A browser that pans a sideways move sends pointercancel, not pointerup: the swipe would never be heard.
    expect(dialog()!.className).toContain("touch-pan-y");
    const backdrop = () => dialog()!.querySelector<HTMLButtonElement>('button.cursor-zoom-out')!;
    pointer("pointerdown", 300, 400);
    pointer("pointerup", 200, 400);
    backdrop().click();
    await eventually(() => shownName() === "slide-02.png", 1_000, "the next");
    // A closed dialog stays drawn a moment to leave, marked `data-leaving`: this one is not leaving.
    expect(dialog()!.closest("[data-leaving]")).toBeNull();
    // A swipe whose lift made no click: the next press on the backdrop still closes it.
    pointer("pointerdown", 300, 400);
    pointer("pointerup", 200, 400);
    await eventually(() => shownName() === "slide-03.png", 1_000, "the next by a swipe");
    pointer("pointerdown", 50, 50);
    backdrop().click();
    await eventually(() => dialog() === null, 1_000, "closed by a press on the backdrop");
  });

  test("one picture alone opens with no count and no buttons to go", async () => {
    const host = await mount([picture("only.png")]);
    host.querySelector<HTMLButtonElement>("button")!.click();
    await eventually(() => shownName() === "only.png", 2_000, "the picture");
    expect(counter()).toBeNull();
    expect(dialog()!.querySelector('[aria-label="The next picture"]')).toBeNull();
    // A photo is opened at its own size, capped to the window: only a drawing is stretched to it.
    expect(dialog()!.querySelector("img")!.className).not.toContain("w-[min(92vw,64rem)]");
  });
});

describe("Download all", () => {
  const press = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Download all"))!;

  test("is there for two files or more still on disk, and fetches each of them, as the page would", async () => {
    const asked: { url: string; credentials?: string }[] = [];
    const saved: { name: string; size: number }[] = [];
    const host = await mount(SET);
    expect(press(host).textContent).toBe("Download all (4)");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url, ...(init?.credentials ? { credentials: init.credentials } : {}) });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob: Blob) => (saved.push({ name: "", size: blob.size }), "blob:x");
    const clicked: string[] = [];
    const realClick = (dom as unknown as { HTMLAnchorElement: { prototype: { click: () => void } } }).HTMLAnchorElement.prototype.click;
    (dom as unknown as { HTMLAnchorElement: { prototype: { click: (this: HTMLAnchorElement) => void } } }).HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    try {
      press(host).click();
      await eventually(() => clicked.length === 1, 2_000, "the archive saved");
      expect(asked.map((one) => one.url)).toEqual(["slide-01.png", "slide-02.png", "notes.pdf", "slide-03.png"].map((name) => `/api/control/sessions/ses_1/files/${name}`));
      expect(asked.every((one) => one.credentials === "same-origin")).toBe(true);
      // A PDF among the slides: the set shares no name.
      expect(clicked).toEqual(["files.zip"]);
      // Four files of three bytes, stored: four local headers, the directory and its end around them.
      expect(saved[0]!.size).toBe(4 * 3 + [12, 12, 9, 12].reduce((sum, name) => sum + 30 + 46 + 2 * name, 0) + 22);
    } finally {
      URL.createObjectURL = realCreate;
      (dom as unknown as { HTMLAnchorElement: { prototype: { click: () => void } } }).HTMLAnchorElement.prototype.click = realClick;
    }
  });

  test("a file that cannot be had stops it, named, and nothing is saved", async () => {
    const host = await mount(SET);
    globalThis.fetch = (async (url: string) => new Response("", { status: url.endsWith("notes.pdf") ? 404 : 200 })) as typeof fetch;
    press(host).click();
    await eventually(() => (host.textContent ?? "").includes("Not downloaded"), 2_000, "the failure");
    expect(host.textContent).toContain("Not downloaded: notes.pdf could not be fetched (error 404).");
    expect(press(host).disabled).toBe(false);
  });

  test("is not there for one file", async () => {
    const host = await mount([picture("one.png"), { name: "gone.pdf", mimeType: "application/pdf", kind: "document", direction: "out" }]);
    expect(press(host)).toBeUndefined();
  });
});

describe("what the archive is called", () => {
  test("the stem a numbered set shares, or files.zip", () => {
    expect(archiveName(["slide-01.png", "slide-02.png", "slide-10.png"])).toBe("slide.zip");
    expect(archiveName(["carousel_1.jpg", "carousel_2.jpg"])).toBe("carousel.zip");
    expect(archiveName(["laporan.pdf", "laporan.xlsx"])).toBe("laporan.zip");
    expect(archiveName(["a.png", "b.png"])).toBe("files.zip");
    expect(archiveName(["ab1.png", "ab2.png"])).toBe("files.zip");
  });
});
