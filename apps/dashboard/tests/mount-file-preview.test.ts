/**
 * The Files tab opens a file as it reads (0.8.23): Preview first, Edit one click away, and each file opened
 * starts at Preview again. Both are one height, each scrolling inside it, as Write a document's are: the preview grew
 * with the file and moved the page under the switch. In a file of its own over the shared harness.
 */

import { expect, test } from "bun:test";
import { answer, press, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const file = (name: string) => ({ name, label: name, description: "", exists: true, bytes: 10, modifiedAt: 0 });
const pressed = (host: HTMLElement) => host.querySelector('button[aria-pressed="true"]')?.textContent?.trim();

test("a file opens in Preview, Edit is one click away, and the next file opened starts at Preview again", async () => {
  answer({
    "/agents/nouva/files": ok({ files: [file("IDENTITY.md"), file("SOUL.md")] }),
    "/agents/nouva/files/IDENTITY.md": ok({ content: "# Identity\n\nThe lead coordinator.\n" }),
    "/agents/nouva/files/SOUL.md": ok({ content: "# Soul\n\nCalm and careful.\n" }),
  });
  const seen: Record<string, string> = {};
  await renderPage("/agents/nouva", async (host) => {
    await eventually(() => host.textContent?.includes("IDENTITY.md") === true, 2_000, "the file list");
    press(host, "IDENTITY.md");
    await eventually(() => host.textContent?.includes("The lead coordinator.") === true, 2_000, "the file opened");
    seen.first = pressed(host) ?? "";
    seen.firstEditor = host.querySelector("textarea") ? "an editor" : "no editor";
    // Rendered, not the text as written: its heading is a heading.
    seen.heading = [...host.querySelectorAll("h1")].map((h) => h.textContent?.trim()).join("|");
    const heading = [...host.querySelectorAll("h1")].find((h) => h.textContent?.trim() === "Identity");
    seen.preview = (heading?.closest("div.rounded-2xl") as HTMLElement | null)?.className ?? "";

    press(host, "Edit");
    await eventually(() => host.querySelector("textarea")?.value.startsWith("# Identity") === true, 2_000, "the editor");
    seen.editor = host.querySelector("textarea")?.className ?? "";

    press(host, "SOUL.md");
    await eventually(() => host.textContent?.includes("Calm and careful.") === true, 2_000, "the next file opened");
    seen.next = pressed(host) ?? "";
    seen.nextEditor = host.querySelector("textarea") ? "an editor" : "no editor";
  });
  expect(seen.first).toBe("Preview");
  expect(seen.firstEditor).toBe("no editor");
  expect(seen.heading).toContain("Identity");
  // One height for both, each scrolling inside it.
  expect(seen.preview).toContain("h-[26rem]");
  expect(seen.preview).toContain("overflow-auto");
  expect(seen.editor).toContain("h-[26rem]");
  expect(seen.editor).toContain("overflow-auto");
  expect(seen.next).toBe("Preview");
  expect(seen.nextEditor).toBe("no editor");
});

test("a file that is not Markdown has no preview: it opens in the editor", async () => {
  answer({
    "/agents/nouva/files": ok({ files: [file("config.toml")] }),
    "/agents/nouva/files/config.toml": ok({ content: 'name = "Nouva"\n' }),
  });
  let value = "";
  let switchShown = true;
  await renderPage("/agents/nouva", async (host) => {
    await eventually(() => host.textContent?.includes("config.toml") === true, 2_000, "the file list");
    press(host, "config.toml");
    await eventually(() => host.querySelector("textarea")?.value === 'name = "Nouva"\n', 2_000, "the file in the editor");
    value = host.querySelector("textarea")?.value ?? "";
    switchShown = host.querySelector('button[aria-pressed]') !== null;
  });
  expect(value).toBe('name = "Nouva"\n');
  expect(switchShown).toBe(false);
});
