/**
 * `InlineTitle`, a page's title written where it stands, mounted on its own.
 */

import { expect, test } from "bun:test";
import { type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

async function draw(element: (react: typeof import("react")) => import("react").ReactElement) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element(React));
  await eventually(() => host.firstElementChild !== null, 2_000, "the piece");
  return { host, redraw: (next: (react: typeof import("react")) => import("react").ReactElement) => root.render(next(React)), done: () => (root.unmount(), host.remove()) };
}

test("a title written where it stands: typing changes it, Escape puts back what it held, and read only it is the heading alone", async () => {
  const { InlineTitle } = await import("@/commons/components/ui/InlineTitle");
  const changes: string[] = [];
  const element = (value: string, readOnly = false) => (react: typeof import("react")) => react.createElement(InlineTitle, { value, onChange: (next: string) => void changes.push(next), label: "Name", placeholder: "Name this automation", readOnly });
  const title = await draw(element("Morning brief"));
  try {
    const field = () => title.host.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    expect(title.host.querySelector("h1")).not.toBeNull();
    expect(field().value).toBe("Morning brief");
    field().focus();
    type(field(), "Evening brief");
    await eventually(() => changes.length === 1, 2_000, "the change");
    expect(changes).toEqual(["Evening brief"]);
    title.redraw(element("Evening brief"));
    await eventually(() => field().value === "Evening brief", 2_000, "the new name drawn");
    field().dispatchEvent(new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await eventually(() => changes.length === 2, 2_000, "the name put back");
    expect(changes[1]).toBe("Morning brief");
    // Empty, it says what goes there.
    title.redraw(element(""));
    await eventually(() => field().value === "", 2_000, "emptied");
    expect(field().getAttribute("placeholder")).toBe("Name this automation");
    title.redraw(element("Morning brief", true));
    await eventually(() => title.host.querySelector("input") === null, 2_000, "read only");
    expect(title.host.querySelector("h1")?.textContent).toBe("Morning brief");
  } finally {
    title.done();
  }
});
