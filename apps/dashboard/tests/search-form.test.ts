/**
 * A search that is asked (`SearchForm`): sent by its button or by Enter, never by a key typed. What it searches costs a
 * request or a model's time (Nouverse's catalogs, the documents), and a request a letter was what Connectors' Explore
 * once spent.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
let dom: Window;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
});

interface Options {
  allowEmpty?: boolean;
  busy?: boolean;
  after?: boolean;
}

async function mount(options: Options = {}) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SearchForm } = await import("@/commons/components/ui/SearchForm");
  const asked: string[] = [];
  const typed: string[] = [];
  function Page() {
    const [value, setValue] = React.useState("");
    return React.createElement(SearchForm, {
      value,
      onChange: (next: string) => (typed.push(next), setValue(next)),
      onSearch: (words: string) => void asked.push(words),
      placeholder: "pdf…",
      label: "Search skills",
      ...(options.allowEmpty ? { allowEmpty: true } : {}),
      ...(options.busy ? { busy: true } : {}),
      ...(options.after ? { after: React.createElement("button", { type: "button" }, "Clear") } : {}),
    });
  }
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  root.render(React.createElement(Page));
  await eventually(() => host.querySelector("form") !== null, 2_000, "the form");
  const input = () => host.querySelector('input[aria-label="Search skills"]') as HTMLInputElement;
  const button = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
  const type = async (text: string) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input()), "value")!.set!.call(input(), text);
    input().dispatchEvent(new (dom.window as unknown as typeof globalThis).Event("input", { bubbles: true }));
    await eventually(() => typed.at(-1) === text, 2_000, `"${text}" typed`);
  };
  /** Enter in the field: the form is sent, whatever its button allows. */
  const enter = () => host.querySelector("form")!.dispatchEvent(new (dom.window as unknown as typeof globalThis).Event("submit", { bubbles: true, cancelable: true }));
  return { host, asked, input, button, type, enter, unmount: () => (root.unmount(), host.remove()) };
}

describe("a search that is asked", () => {
  test("typing asks nothing; the button, or Enter, sends the words without the space around them", async () => {
    const { host, asked, button, type, enter, unmount } = await mount();
    try {
      expect(host.querySelector("form")!.getAttribute("role")).toBe("search");
      await type("  pdf forms ");
      expect(asked).toEqual([]);
      await eventually(() => !button().disabled, 2_000, "Search to be ready");
      button().click();
      await eventually(() => asked.length === 1, 2_000, "the search asked");
      enter();
      expect(asked).toEqual(["pdf forms", "pdf forms"]);
    } finally {
      unmount();
    }
  });

  test("with nothing typed, or only spaces, there is nothing to ask: the button cannot be pressed and Enter asks nothing", async () => {
    const { asked, button, type, enter, unmount } = await mount();
    try {
      expect(button().disabled).toBe(true);
      enter();
      await type("   ");
      expect(button().disabled).toBe(true);
      enter();
      expect(asked).toEqual([]);
    } finally {
      unmount();
    }
  });

  test("where nothing typed means the list before a search, it is asked as that", async () => {
    const { asked, button, type, unmount } = await mount({ allowEmpty: true });
    try {
      expect(button().disabled).toBe(false);
      button().click();
      await eventually(() => asked.length === 1, 2_000, "asked with no words");
      await type("github");
      button().click();
      await eventually(() => asked.length === 2, 2_000, "asked with words");
      expect(asked).toEqual(["", "github"]);
    } finally {
      unmount();
    }
  });

  test("while it is asked the button waits, and what follows it is drawn after it", async () => {
    const { host, button, type, unmount } = await mount({ busy: true, after: true, allowEmpty: true });
    try {
      await type("pdf");
      expect(button().disabled).toBe(true);
      expect(button().querySelector(".loading")).not.toBeNull();
      expect(host.querySelector("form")!.lastElementChild!.textContent).toBe("Clear");
    } finally {
      unmount();
    }
  });
});
