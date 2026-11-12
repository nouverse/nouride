/**
 * Two small pieces a flow is made of, each mounted on its own: `StepCard`, one step as a card whose words are a button
 * when a press does something, and `InlineTitle`, a page's title written where it stands.
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

test("a step's card: its number and name, its line, its tile, and a state that rings it", async () => {
  const { StepCard } = await import("@/commons/components/jobs/StepCard");
  const { Terminal } = await import("lucide-react");
  const card = await draw(({ createElement }) => createElement(StepCard, { eyebrow: "Step 2", title: "Run a command", line: "curl -sf https://shop.example.com/health", mono: true, icon: Terminal, tile: "bg-info/15 text-info", state: "failed", anchor: "step:check" }));
  try {
    const root = card.host.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-flow-anchor")).toBe("step:check");
    expect(root.getAttribute("data-state")).toBe("failed");
    expect(root.getAttribute("class")).toContain("border-error/40");
    // A floating card as every other: 22px corners, a hairline, the soft shadow.
    expect(root.getAttribute("class")?.split(" ")).toEqual(expect.arrayContaining(["rounded-[22px]", "border", "bg-base-100", "shadow-soft"]));
    expect(root.textContent).toBe("Step 2 · Run a commandcurl -sf https://shop.example.com/health");
    expect([...root.querySelectorAll("span")].find((span) => span.textContent?.startsWith("curl"))?.getAttribute("class")).toContain("font-mono");
    // With nothing a press does, its words are words: no button.
    expect(root.querySelector("button")).toBeNull();
  } finally {
    card.done();
  }
});

test("a step's card that opens: its words are the button, which says whether what it opens is open; a dimmed one fades, a question is read whole", async () => {
  const { StepCard } = await import("@/commons/components/jobs/StepCard");
  const { Hand } = await import("lucide-react");
  let pressed = 0;
  const props = (expanded: boolean) => ({ eyebrow: "Step 1", title: "Wait for your OK", line: "Send it?", icon: Hand, tile: "bg-accent/15 text-accent", onPress: () => void (pressed += 1), expanded });
  const card = await draw(({ createElement }) => createElement(StepCard, props(false), createElement("p", null, "its fields")));
  try {
    const button = () => card.host.querySelector("button") as HTMLButtonElement;
    expect(button().getAttribute("aria-expanded")).toBe("false");
    button().click();
    expect(pressed).toBe(1);
    card.redraw(({ createElement }) => createElement(StepCard, { ...props(true), dimmed: true, whole: true, badge: createElement("em", null, "Suggested") }, createElement("p", null, "its fields")));
    await eventually(() => button().getAttribute("aria-expanded") === "true", 2_000, "open");
    // Set back, with its words still at their own ink: not faded as a whole.
    expect(card.host.firstElementChild?.hasAttribute("data-dimmed")).toBe(true);
    expect(card.host.firstElementChild?.getAttribute("class")).not.toMatch(/(^| )opacity-/);
    expect(card.host.textContent).toContain("its fields");
    expect(card.host.querySelector("em")?.textContent).toBe("Suggested");
    const line = [...card.host.querySelectorAll("span")].find((span) => span.textContent === "Send it?")!;
    expect(line.getAttribute("class")).not.toContain("line-clamp");
  } finally {
    card.done();
  }
});

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
