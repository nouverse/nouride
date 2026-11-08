/**
 * Dialogs and toasts open and close with motion. A dialog's box grows in as it is drawn and goes back as it closes. A
 * page closes a dialog by no longer drawing it, which would take it off the screen at once, so it draws it through
 * `Leaving`: that keeps it while it leaves, and `overPage`'s frame marks it (`data-leaving`) for main.css's rules, with no
 * click or focus left on it. A toast enters and leaves the same way, and a confirmation keeps its question drawn while
 * its dialog closes. What is checked: the state each holds, how long it holds it — main.css's own leave — and what
 * main.css draws for each state.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Window } from "happy-dom";
import { LEAVE_MS } from "@/commons/lib/motion";
import { eventually } from "./wait.ts";

const css = readFileSync(join(import.meta.dir, "..", "src", "styles", "main.css"), "utf8");
/** Each `--animate-*` of main.css's `@theme`, by name: what `var(--animate-…)` stands for once Tailwind has built it. */
const THEME = Object.fromEntries([...css.matchAll(/^\s*--animate-([\w-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]));
/** main.css's "Dialogs" block, its `var(--animate-…)` written out. */
const DIALOGS = (/\/\* ── Dialogs[\s\S]*?\*\/([\s\S]*?)\/\* ──/.exec(css)?.[1] ?? "").replace(/var\(--animate-([\w-]+)\)/g, (_, name: string) => THEME[name] ?? "");

/** What main.css's dialog rules give the element at `selector` in `markup`: its animation, and what it transitions. */
function drawn(markup: string, selector: string): { animation: string; transition: string } {
  const window = new Window();
  try {
    window.document.head.innerHTML = `<style>${DIALOGS}</style>`;
    window.document.body.innerHTML = markup;
    const style = window.getComputedStyle(window.document.querySelector(selector)!);
    return { animation: style.getPropertyValue("animation").trim(), transition: style.getPropertyValue("transition-property").trim() };
  } finally {
    void window.happyDOM.close();
  }
}

describe("what main.css draws for a dialog", () => {
  test("is read from it, and a leave as long as the one the code waits for", () => {
    expect(DIALOGS).toContain(".modal-box");
    expect(THEME.leave).toMatch(new RegExp(`^leave ${LEAVE_MS}ms `));
  });

  test("its box grows in as it is drawn open, or opened, and goes back once closed", () => {
    expect(drawn('<div class="modal modal-open"><div class="modal-box"></div></div>', ".modal-box").animation).toBe(THEME.enter!);
    expect(drawn('<dialog class="modal" open><div class="modal-box"></div></dialog>', ".modal-box").animation).toBe(THEME.enter!);
    expect(drawn('<dialog class="modal"><div class="modal-box"></div></dialog>', ".modal-box").animation).toBe(THEME.leave!);
  });

  test("leaving, its box goes back and the shade under it fades, as a picture opened over the chat does", () => {
    const leaving = '<div data-leaving=""><div class="modal modal-open"><div class="modal-box"></div></div></div>';
    expect(drawn(leaving, ".modal-box").animation).toBe(THEME.leave!);
    expect(drawn(leaving, ".modal").animation).toBe(`${THEME.fade} reverse forwards`);
    expect(drawn('<div data-leaving=""><div class="fixed inset-0"><img></div></div>', ".fixed").animation).toBe(`${THEME.fade} reverse forwards`);
  });

  test("its box no longer moves by daisyUI's own transitions, which would win over the keyframes", () => {
    expect(drawn('<dialog class="modal" open><div class="modal-box"></div></dialog>', ".modal-box").transition).toBe("box-shadow");
  });
});

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "getComputedStyle"] as const;
let dom: Window;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
});

/** A React root in a host of its own, rendered at once, and how to draw it again and take it away. */
async function mount(element: unknown): Promise<{ host: HTMLElement; draw: (next: unknown) => void; unmount: () => void }> {
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const draw = (next: unknown) => flushSync(() => root.render(next as never));
  draw(element);
  return {
    host,
    draw,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

describe("a dialog a page draws through Leaving", () => {
  /** A page drawing one dialog through `Leaving` for each value it is given, side by side. */
  async function page() {
    const React = await import("react");
    const { Leaving, overPage } = await import("@/commons/components/ui/OverPage");
    const Dialog = ({ name }: { name: string }) =>
      overPage(React.createElement("div", { className: "modal modal-open", role: "dialog", "aria-label": name }, React.createElement("div", { className: "modal-box" }, name)));
    return (...values: (string | null)[]) =>
      React.createElement(
        React.Fragment,
        null,
        values.map((value, at) => React.createElement(Leaving<string>, { key: at, value, children: (name: string) => React.createElement(Dialog, { name }) })),
      );
  }
  const dialog = (name: string) => dom.document.querySelector(`[role="dialog"][aria-label="${name}"]`);
  const frame = (name: string) => dialog(name)?.parentElement ?? null;

  test("is drawn while open, in a frame that is not leaving", async () => {
    const at = await page();
    const view = await mount(at("Notes"));
    try {
      expect(dialog("Notes")).not.toBeNull();
      expect(frame("Notes")?.hasAttribute("data-leaving")).toBe(false);
      expect(frame("Notes")?.hasAttribute("inert")).toBe(false);
    } finally {
      view.unmount();
    }
  });

  test("once closed, stays for its leave, marked leaving and out of reach, then goes", async () => {
    const at = await page();
    const view = await mount(at("Notes"));
    try {
      const closed = Date.now();
      view.draw(at(null));
      expect(dialog("Notes")).not.toBeNull();
      expect(frame("Notes")?.hasAttribute("data-leaving")).toBe(true);
      expect(frame("Notes")?.hasAttribute("inert")).toBe(true);
      await eventually(() => dialog("Notes") === null, 2_000, "the dialog to go");
      expect(Date.now() - closed).toBeGreaterThanOrEqual(LEAVE_MS - 5);
    } finally {
      view.unmount();
    }
  });

  test("open for longer than a leave, still leaves when closed — timed by one closed beside it", async () => {
    const at = await page();
    const view = await mount(at("Notes", "Brief"));
    try {
      view.draw(at("Notes", null));
      await eventually(() => dialog("Brief") === null, 2_000, "the one beside it to go");
      view.draw(at(null, null));
      expect(dialog("Notes")).not.toBeNull();
      expect(frame("Notes")?.hasAttribute("data-leaving")).toBe(true);
      await eventually(() => dialog("Notes") === null, 2_000, "the dialog to go");
    } finally {
      view.unmount();
    }
  });

  test("opened again while it leaves, is open again and stays — past the leave of one closed beside it", async () => {
    const at = await page();
    const view = await mount(at("Notes", "Brief"));
    try {
      view.draw(at(null, null));
      view.draw(at("Report", null));
      expect(frame("Report")?.hasAttribute("data-leaving")).toBe(false);
      await eventually(() => dialog("Brief") === null, 2_000, "the one beside it to go");
      expect(dialog("Report")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe("a toast", () => {
  async function toaster() {
    const React = await import("react");
    const { ToastProvider, useToast } = await import("@/commons/components/ui/toast");
    let reached: ReturnType<typeof useToast> | null = null;
    const Reach = () => {
      reached = useToast();
      return null;
    };
    const view = await mount(React.createElement(ToastProvider, null, React.createElement(Reach)));
    const { flushSync } = await import("react-dom");
    return { view, raise: (show: (toast: ReturnType<typeof useToast>) => void) => flushSync(() => show(reached!)) };
  }
  const shown = (host: HTMLElement, words: string) => [...host.querySelectorAll('[role="status"]')].find((node) => node.textContent?.includes(words)) ?? null;

  test("enters as it is raised, leaves when dismissed — out of reach while it goes — and is then gone", async () => {
    const { view, raise } = await toaster();
    try {
      raise((toast) => toast.success("Schedule saved"));
      expect(shown(view.host, "Schedule saved")?.classList.contains("animate-enter")).toBe(true);
      (shown(view.host, "Schedule saved")!.querySelector('button[aria-label="Dismiss"]') as HTMLElement).click();
      await eventually(() => shown(view.host, "Schedule saved")?.classList.contains("animate-leave") ?? false, 1_000, "the toast to leave");
      expect(shown(view.host, "Schedule saved")?.classList.contains("pointer-events-none")).toBe(true);
      await eventually(() => shown(view.host, "Schedule saved") === null, 2_000, "the toast to go");
    } finally {
      view.unmount();
    }
  });

  test("whose time is up leaves the same way", async () => {
    const { view, raise } = await toaster();
    try {
      raise((toast) => toast.show({ message: "Copied", kind: "info", duration: 20 }));
      await eventually(() => shown(view.host, "Copied")?.classList.contains("animate-leave") ?? false, 1_000, "the toast to leave");
      await eventually(() => shown(view.host, "Copied") === null, 2_000, "the toast to go");
    } finally {
      view.unmount();
    }
  });
});

describe("a confirmation", () => {
  test("answered, closes its dialog with the question still drawn in it, so it is seen to close", async () => {
    const React = await import("react");
    const { useConfirm } = await import("@/commons/components/ui/confirm");
    let asking: ((title: string) => Promise<boolean>) | null = null;
    const Asker = () => {
      const confirm = useConfirm();
      asking = (title) => confirm.ask({ title, confirmLabel: "Delete" });
      return confirm.dialog as never;
    };
    const view = await mount(React.createElement(Asker));
    try {
      const { flushSync } = await import("react-dom");
      let answer: Promise<boolean> | null = null;
      flushSync(() => {
        answer = asking!("Delete draw-diagram?");
      });
      const box = () => view.host.querySelector("dialog .modal-box");
      await eventually(() => view.host.querySelector("dialog")?.hasAttribute("open") ?? false, 1_000, "the dialog to open");
      ([...view.host.querySelectorAll("dialog button")].find((button) => button.textContent === "Delete") as HTMLElement).click();
      expect(await answer!).toBe(true);
      expect(view.host.querySelector("dialog")?.hasAttribute("open")).toBe(false);
      expect(box()?.textContent).toContain("Delete draw-diagram?");
    } finally {
      view.unmount();
    }
  });
});

/** Every `.tsx` under `src`, with its code: comments taken out, so a name in one is not a use. */
function sources(): { file: string; code: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".tsx") ? [path] : [];
    });
  return walk(join(import.meta.dir, "..", "src")).map((path) => ({
    file: relative(join(import.meta.dir, "..", "src"), path),
    code: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1"),
  }));
}

/** A file's top-level components, each with its body: from one `function Name(` at the line's start to the next. */
function components(code: string): { name: string; body: string; start: number }[] {
  const starts = [...code.matchAll(/^(?:export (?:default )?)?function ([A-Z]\w*)\b/gm)];
  return starts.map((m, i) => ({ name: m[1]!, body: code.slice(m.index, starts[i + 1]?.index ?? code.length), start: m.index }));
}

describe("every dialog a page draws", () => {
  test("is drawn through Leaving, so it is seen to close — never on a bare condition", () => {
    const files = sources();
    // A dialog draws itself over the page; one that only wraps one (a page's notes around NotesModal) is one too.
    const dialogs = new Set(files.flatMap(({ code }) => components(code).filter(({ body }) => /\boverPage\(/.test(body)).map(({ name }) => name)));
    for (let grew = true; grew; ) {
      grew = false;
      for (const { code } of files) {
        for (const { name, body } of components(code)) {
          const root = /\breturn\s*\(?\s*<([A-Z]\w*)/.exec(body)?.[1];
          if (root && dialogs.has(root) && !dialogs.has(name)) {
            dialogs.add(name);
            grew = true;
          }
        }
      }
    }
    expect([...dialogs]).toEqual(expect.arrayContaining(["DocumentDialog", "MarkdownPreview", "NotesModal", "NoteView", "PersonNotes", "Lightbox"]));

    const bare = files.flatMap(({ file, code }) => {
      const own = components(code).filter(({ name }) => dialogs.has(name));
      return [...code.matchAll(/<([A-Z]\w*)[\s/>]/g)]
        .filter((m) => dialogs.has(m[1]!))
        .filter((m) => !own.some(({ start, body }) => m.index >= start && m.index < start + body.length))
        .filter((m) => {
          const before = code.slice(0, m.index);
          return before.lastIndexOf("<Leaving") <= before.lastIndexOf("</Leaving>");
        })
        .map((m) => `${file}: <${m[1]}>`);
    });
    expect(bare).toEqual([]);
  });
});
