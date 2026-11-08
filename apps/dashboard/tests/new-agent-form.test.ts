/**
 * The New Agent form (0.8.1): its headline and SOUL.md are filled in from what it can do, for the person to keep or
 * change: nobody should have to write a system prompt to make an agent. Another preset swaps them, unless
 * the person has written their own. What it can do, and Custom's tool list, come after the name and words — not
 * between them — the model field offers chat models only, never an embedding one, and Create waits for an id the
 * daemon would take, a name and a model. Who answers is one choice on the same form — a model, or a coding CLI this
 * box has, on an account — where external agents had a form of their own that was hard to follow.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let realFetch: typeof fetch;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PRESETS = [
  { id: "pilot", label: "Pilot", summary: "Full access.", headline: "Takes a task to the end", soul: "You are a capable, calm operator.", tools: [] },
  { id: "researcher", label: "Researcher", summary: "Reads the web.", headline: "Research, with links", soul: "You are a careful researcher.", tools: [] },
];

function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
  input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
}

describe("the New Agent form", () => {
  test("fills the headline and SOUL.md from what it can do, swaps them with the preset, and keeps what the person wrote", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/control/setup/presets") return json({ presets: PRESETS, groups: [] });
      if (path === "/api/control/providers") return json({ providers: [{ name: "gate", hasCredential: true }] });
      if (path.endsWith("/models")) return json({ ok: true, models: ["claude-sonnet-5-5", "bge-m3", "text-embedding-3-small"] });
      return json({ ok: false, models: [] });
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { NewAgentForm } = await import("@/modules/agents/components/NewAgentForm");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(NewAgentForm, { onClose: () => {}, onCreated: () => {} })));
    const soul = () => host.querySelector("textarea") as HTMLTextAreaElement;
    const headline = () => host.querySelector("#new-agent-headline") as HTMLInputElement;
    const pick = (label: string) => ([...host.querySelectorAll('button[role="radio"]')].find((entry) => entry.textContent?.startsWith(label)) as HTMLButtonElement).click();
    try {
      await eventually(() => soul()?.value === "You are a capable, calm operator.", 2_000, "Pilot's SOUL filled in");
      expect(headline().value).toBe("Takes a task to the end");
      // The name and the words first; what it can do after them.
      const text = host.textContent ?? "";
      expect(text.indexOf("Headline")).toBeLessThan(text.indexOf("What it can do"));
      expect(text.indexOf("Personality and instructions")).toBeLessThan(text.indexOf("What it can do"));
      const model = host.querySelector('input[role="combobox"]') as HTMLInputElement;
      model.focus();
      // A model's list waits for typing, or the arrow keys, which show it whole once the models are in (`Combobox`).
      const down = () => model.dispatchEvent(new (model.ownerDocument.defaultView as unknown as typeof globalThis).KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await eventually(() => {
        if (!dom.document.querySelector('[role="listbox"]')) down();
        return (dom.document.querySelector('[role="listbox"]')?.textContent ?? "").includes("claude-sonnet-5-5");
      }, 2_000, "the chat models");
      expect(dom.document.querySelector('[role="listbox"]')?.textContent).not.toContain("bge-m3");
      expect(dom.document.querySelector('[role="listbox"]')?.textContent).not.toContain("text-embedding");
      model.blur();
      // Create waits for an id, a name and a model.
      const create = () => [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Create Agent") as HTMLButtonElement;
      expect(create().disabled).toBe(true);
      type(host.querySelector('input[placeholder="e.g. assistant"]') as HTMLInputElement, "Scout!");
      type(host.querySelector('input[placeholder="e.g. Assistant"]') as HTMLInputElement, "Scout");
      type(model, "claude-sonnet-5-5");
      await eventually(() => true, 50);
      expect(create().disabled).toBe(true);
      type(host.querySelector('input[placeholder="e.g. assistant"]') as HTMLInputElement, "scout");
      await eventually(() => !create().disabled, 2_000, "Create, with an id, a name and a model");
      pick("Researcher");
      await eventually(() => soul().value === "You are a careful researcher.", 2_000, "Researcher's SOUL");
      expect(headline().value).toBe("Research, with links");
      type(soul(), "My own words.");
      pick("Pilot");
      await eventually(() => headline().value === "Takes a task to the end", 2_000, "Pilot's headline");
      expect(soul().value).toBe("My own words.");
    } finally {
      root.unmount();
      host.remove();
      client.clear();
    }
  });

  test("a coding CLI is picked on the same form: its model fields give way to an account, and it is made on that account", async () => {
    const posted: { path: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method === "POST") {
        posted.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
        return json({ ok: true, id: "coder" });
      }
      if (path === "/api/control/setup/presets") return json({ presets: PRESETS, groups: [] });
      if (path === "/api/control/providers") return json({ providers: [{ name: "gate", hasCredential: true }] });
      if (path === "/api/control/external-clis") return json({ room: { enough: true, bytes: 2 ** 31, needs: 2 ** 29 }, clis: [{ id: "claude-code", name: "Claude Code", command: "claude-agent-acp", installed: true, version: "0.95.0", install: "npm i -g x", login: true }, { id: "codex", name: "Codex", command: "codex-acp", installed: false, install: "npm i -g codex-acp", login: true }] });
      if (path === "/api/control/cli-accounts") return json({ clis: [{ id: "claude-code", name: "Claude Code", installed: true, install: "", shared: true, canLogin: true, accounts: [{ name: "team", signedIn: true, agents: [] }] }] });
      return json({ ok: false, models: [] });
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { NewAgentForm } = await import("@/modules/agents/components/NewAgentForm");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const made: [string, boolean][] = [];
    const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
    // The account field links to the Models page: a router to hold the link.
    const routes = createRootRoute({ component: () => React.createElement(Outlet) });
    const page = createRoute({ getParentRoute: () => routes, path: "/", component: () => React.createElement(NewAgentForm, { onClose: () => {}, onCreated: (id: string, external: boolean) => void made.push([id, external]) }) });
    const router = createRouter({ routeTree: routes.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
    const radio = (label: string) => [...host.querySelectorAll('button[role="radio"]')].find((entry) => entry.textContent?.includes(label)) as HTMLButtonElement | undefined;
    try {
      await eventually(() => radio("Claude Code") !== undefined, 2_000, "Claude Code offered");
      // No version on the option: the scan's is the ACP adapter's (0.95.0), not Claude Code's own.
      expect(radio("Claude Code")!.textContent).toContain("Installed. Signs in after it is made.");
      expect(radio("Claude Code")!.textContent).not.toContain("0.95.0");
      expect(radio("Codex")).toBeUndefined();
      expect(host.textContent).toContain("Not set up on this server yet: Codex.");
      expect(host.textContent).toContain("Model Name");
      radio("Claude Code")!.click();
      await eventually(() => (host.textContent ?? "").includes("team (signed in)"), 2_000, "the accounts");
      expect(host.textContent).not.toContain("Model Name");
      // Accounts are added on the Models page, not here.
      expect(host.querySelector('a[href$="/models?tab=clis"]')?.textContent).toBe("Add or sign in an account");
      expect(host.querySelector('input[aria-label="The new account\'s name"]')).toBeNull();
      (host.querySelector("select.select-sm") as HTMLSelectElement).value = "team";
      host.querySelector("select.select-sm")!.dispatchEvent(new (dom as unknown as typeof globalThis).Event("change", { bubbles: true }));
      type(host.querySelector('input[placeholder="e.g. assistant"]') as HTMLInputElement, "coder");
      type(host.querySelector('input[placeholder="e.g. Assistant"]') as HTMLInputElement, "Coder");
      const create = () => [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Create Agent") as HTMLButtonElement;
      await eventually(() => !create().disabled, 2_000, "Create, with no model needed");
      (create().form as HTMLFormElement).requestSubmit();
      await eventually(() => posted.length === 1, 2_000, "the agent made");
      expect(posted[0]!.body).toMatchObject({ id: "coder", display_name: "Coder", model: "", external: { cli: "claude-code", profile: "team" } });
      expect(posted[0]!.body.provider).toBeUndefined();
      await eventually(() => made.length === 1, 2_000, "onCreated");
      expect(made).toEqual([["coder", true]]);
    } finally {
      root.unmount();
      host.remove();
      client.clear();
    }
  });

  test("is an admin's to open, as the daemon's route is — an operator sees New Agent switched off", async () => {
    // An operator could make an agent with every tool and a coding CLI on the shared account; the route refuses that now,
    // so a button that opened a form ending in "admin only" would be one more thing to be told no by.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/control/status") return json({ gateways: [], orchestrator: "nouva", agents: [{ id: "nox", displayName: "Nox", enabled: true, tools: [], activity: { state: "idle" } }] });
      if (path === "/api/control/gateways") return json({ gateways: [] });
      return json({});
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
    const { default: AgentListPage } = await import("@/modules/agents/index.page");
    const offered: Record<string, boolean> = {};
    for (const role of ["operator", "admin"]) {
      const routes = createRootRoute({ component: () => React.createElement(Outlet) });
      const page = createRoute({ getParentRoute: () => routes, path: "/", component: () => React.createElement(AgentListPage) });
      const router = createRouter({ routeTree: routes.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/"] }) });
      const host = dom.document.createElement("div") as unknown as HTMLElement;
      dom.document.body.appendChild(host as never);
      const root = createRoot(host);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // Who is signed in, known before the page draws: the button's state is then the role's, not a load's.
      client.setQueryData(["me"], { id: "u1", username: "mira", role });
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
      try {
        await eventually(() => (host.textContent ?? "").includes("Nox"), 3_000, "the agents");
        const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "New Agent") as HTMLButtonElement;
        offered[role] = !button.disabled;
      } finally {
        root.unmount();
        host.remove();
        client.clear();
      }
    }
    expect(offered).toEqual({ operator: false, admin: true });
  });
});
