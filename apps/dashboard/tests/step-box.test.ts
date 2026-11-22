/**
 * `StepBox`, a box of the automation canvas, mounted on its own: a title and one line whose words are the button when
 * a press does something, the state that rings it, its own rules under its words, and what opens in it.
 */

import { expect, test } from "bun:test";
import { useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

async function draw(element: (react: typeof import("react")) => import("react").ReactElement) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element(React));
  await eventually(() => host.firstElementChild !== null, 2_000, "the box");
  return { host, redraw: (next: (react: typeof import("react")) => import("react").ReactElement) => root.render(next(React)), done: () => (root.unmount(), host.remove()) };
}

test("a box at rest: its title and one line, its tile, and a state that rings it; with nothing a press does, its words are words", async () => {
  const { StepBox } = await import("@/modules/automations/components/StepBox");
  const { Terminal } = await import("lucide-react");
  const box = await draw(({ createElement }) => createElement(StepBox, { title: "Run a script", line: "curl -sf https://shop.example.com/health", mono: true, icon: Terminal, tile: "bg-info/15 text-info", state: "failed", anchor: "step:check" }));
  try {
    const root = box.host.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-flow-anchor")).toBe("step:check");
    expect(root.getAttribute("data-state")).toBe("failed");
    expect(root.getAttribute("class")).toContain("border-error/40");
    // Nothing but a title and a line: no number, no note, no menu drawn at rest.
    expect(root.textContent).toBe("Run a scriptcurl -sf https://shop.example.com/health");
    const line = [...root.querySelectorAll("span")].find((span) => span.textContent?.startsWith("curl"))!;
    // A command as it is typed, on one line however long it is.
    expect(line.getAttribute("class")?.split(" ")).toEqual(expect.arrayContaining(["font-mono", "truncate"]));
    expect(root.querySelector("button")).toBeNull();
  } finally {
    box.done();
  }
});

test("a box that opens: its words are the button, named and saying whether it is open; its rules stand under its words, and what it opens under those", async () => {
  const { StepBox } = await import("@/modules/automations/components/StepBox");
  const { Hand } = await import("lucide-react");
  let pressed = 0;
  const props = (expanded: boolean) => ({ title: "Wait for your OK", line: "Send it?", icon: Hand, tile: "bg-accent/15 text-accent", onPress: () => void (pressed += 1), pressLabel: `${expanded ? "Close" : "Edit"} step 1: Wait for your OK`, expanded });
  const box = await draw(({ createElement }) => createElement(StepBox, props(false)));
  try {
    const button = () => box.host.querySelector("button") as HTMLButtonElement;
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().getAttribute("aria-label")).toBe("Edit step 1: Wait for your OK");
    // A finger's height, whatever its words.
    expect(button().getAttribute("class")).toContain("min-h-16");
    button().click();
    expect(pressed).toBe(1);
    box.redraw(({ createElement }) =>
      createElement(StepBox, { ...props(true), state: "open", dimmed: true, side: true, badge: createElement("em", null, "Suggested"), strip: createElement("p", { "data-rule": "whenFailed" }, "If you say no, the run goes on anyway.") }, createElement("p", null, "its fields")),
    );
    await eventually(() => button().getAttribute("aria-expanded") === "true", 2_000, "open");
    const root = box.host.firstElementChild as HTMLElement;
    expect(button().getAttribute("aria-label")).toBe("Close step 1: Wait for your OK");
    expect(root.getAttribute("data-state")).toBe("open");
    // Set back, with its words still at their own ink: not faded as a whole.
    expect(root.hasAttribute("data-dimmed")).toBe(true);
    expect(root.getAttribute("class")).not.toMatch(/(^| )opacity-/);
    // A step of a lane says so, for the canvas to draw it off the main line.
    expect(root.hasAttribute("data-side")).toBe(true);
    expect(box.host.querySelector("em")?.textContent).toBe("Suggested");
    // In the box, in this order: its words, its rule, what it opens.
    expect(root.textContent).toBe("Wait for your OKSuggestedSend it?If you say no, the run goes on anyway.its fields");
  } finally {
    box.done();
  }
});

test("what shows on a pointer over the box takes no room of its words, and is not drawn where no pointer hovers", async () => {
  const { StepBox } = await import("@/modules/automations/components/StepBox");
  const { Hand } = await import("lucide-react");
  const box = await draw(({ createElement }) => createElement(StepBox, { title: "Wait for your OK", icon: Hand, tile: "bg-accent/15 text-accent", onPress: () => {}, hover: createElement("button", { type: "button", "aria-label": "More for step 1" }) }));
  try {
    const held = (box.host.querySelector('[aria-label="More for step 1"]') as HTMLElement).parentElement!;
    expect(held.getAttribute("class")?.split(" ")).toEqual(expect.arrayContaining(["absolute", "opacity-0", "group-hover/box:opacity-100", "group-focus-within/box:opacity-100", "max-md:hidden"]));
  } finally {
    box.done();
  }
});
