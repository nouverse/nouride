/**
 * The Project folders card on an agent's Skills tab (0.8.24): each folder it takes skills from, with the skills it
 * brings and a word for one the server cannot open; an admin adds one by its path and removes one after a question, a
 * refusal says the server's everyday words, and an account that may not change them sees them and no controls.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLDialogElement", "Element", "Node", "Event"] as const;
let dom: Window;
let realFetch: typeof fetch;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  dom.document.body.innerHTML = "";
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ROOTS = [
  { path: "/srv/projects/home-app", readable: true, skills: [{ name: "android-ui", description: "How the app's screens are built." }] },
  { path: "/srv/projects/not-cloned", readable: false, skills: [] },
];

interface Served {
  editable?: boolean;
  /** What an add answers: refused with these words, or saved. */
  refuse?: { error: string; plain: string };
}

function serve(options: Served = {}): { calls: { method: string; path: string; body?: unknown }[]; reads: () => number } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (url.pathname !== "/api/control/agents/nova/skill-roots") return json({});
    if (method === "GET") {
      reads += 1;
      return json({ roots: ROOTS, editable: options.editable ?? true });
    }
    calls.push({ method, path: `${url.pathname}${url.search}`, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "POST" && options.refuse) return json(options.refuse, 400);
    return json(method === "POST" ? { ok: true, path: "/srv/projects/new-app", skills: ["deploy"] } : { ok: true, path: "/srv/projects/home-app" });
  }) as typeof fetch;
  return { calls, reads: () => reads };
}

async function mount(): Promise<HTMLElement> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { SkillRootsCard } = await import("@/modules/agents/components/SkillRootsCard");
  const { ToastProvider } = await import("@/commons/components/ui/toast");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(host).render(React.createElement(QueryClientProvider, { client }, React.createElement(ToastProvider, null, React.createElement(SkillRootsCard, { agentId: "nova" }))));
  await eventually(() => (host.textContent ?? "").includes("/srv/projects/home-app"), 2_000, "the folders");
  return host;
}

/** Typed as a person types, through React's own value setter. */
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, text);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((one) => one.textContent?.trim() === label || one.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;

describe("an agent's project folders", () => {
  test("each with the skills it brings, and a word for one the server cannot open", async () => {
    serve();
    const host = await mount();
    const rows = [...host.querySelectorAll('ul[aria-label="Project folders"] > li')].map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("android-ui");
    expect(rows[1]).toContain("cannot be opened");
    expect(rows[1]).toContain("No skills there yet.");
  });

  test("an admin adds one by its path, and the list is read again", async () => {
    const served = serve();
    const host = await mount();
    const before = served.reads();
    type(host.querySelector('input[aria-label="Project folder to add"]') as HTMLInputElement, "  /srv/projects/new-app ");
    await eventually(() => button(host, "Add folder")?.disabled === false, 2_000, "the add button");
    button(host, "Add folder")!.click();
    await eventually(() => served.calls.length === 1, 2_000, "the add");
    expect(served.calls).toEqual([{ method: "POST", path: "/api/control/agents/nova/skill-roots", body: { path: "/srv/projects/new-app" } }]);
    await eventually(() => served.reads() > before, 2_000, "the list read again");
  });

  test("a folder the server refuses says its everyday words", async () => {
    serve({ refuse: { error: "There is no folder at /srv/projects/gone.", plain: "There is no folder there on this server. Nothing was saved." } });
    const host = await mount();
    type(host.querySelector('input[aria-label="Project folder to add"]') as HTMLInputElement, "/srv/projects/gone");
    await eventually(() => button(host, "Add folder")?.disabled === false, 2_000, "the add button");
    button(host, "Add folder")!.click();
    await eventually(() => (host.querySelector('[role="alert"]')?.textContent ?? "").includes("There is no folder there on this server."), 2_000, "the refusal");
  });

  test("removed only after the question: Cancel sends nothing, Remove sends the folder", async () => {
    const served = serve();
    const host = await mount();
    // The open question's own buttons: the dialog's backdrop holds a hidden one named Cancel too, and one answered keeps
    // its words while it closes.
    const answer = (label: string) => [...host.querySelectorAll("dialog[open] .modal-box button")].find((one) => one.textContent?.trim() === label) as HTMLButtonElement | undefined;
    button(host, "Remove /srv/projects/home-app")!.click();
    await eventually(() => answer("Cancel") !== undefined, 2_000, "the question");
    expect(host.querySelector(".modal-box")?.textContent).toContain("nova stops reading the skills in /srv/projects/home-app from its next message.");
    answer("Cancel")!.click();
    await eventually(() => answer("Cancel") === undefined, 2_000, "the question closed");
    expect(served.calls).toEqual([]);
    button(host, "Remove /srv/projects/home-app")!.click();
    await eventually(() => answer("Remove") !== undefined, 2_000, "the question again");
    answer("Remove")!.click();
    await eventually(() => served.calls.length === 1, 2_000, "the removal");
    expect(served.calls).toEqual([{ method: "DELETE", path: "/api/control/agents/nova/skill-roots?path=%2Fsrv%2Fprojects%2Fhome-app" }]);
  });

  test("an account that may not change them sees them, and no add or remove", async () => {
    serve({ editable: false });
    const host = await mount();
    expect(host.querySelector('input[aria-label="Project folder to add"]')).toBeNull();
    expect(button(host, "Remove /srv/projects/home-app")).toBeUndefined();
    expect(host.textContent).toContain("Only an admin can change these.");
  });
});
