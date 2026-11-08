/**
 * Where each coding CLI stands, in plain words (0.8.24, v0.8.24 item 2): on the Models page and the Brain tab of an agent
 * that works in it — up to date; a newer version is out; newer than this Nouride was tested with (it runs, with a
 * warning); older than it supports. Each state's words, and an update on offer for the two that have one; the version
 * numbers under Details, since the one Nouride reads is not the number the CLI itself shows.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { AgentCli, CliAccountsView, CliVersionView } from "@/commons/lib/api.external-agents";
import { standingWords } from "@/commons/lib/cli-standing";
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
  dom.document.body.innerHTML = "";
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const STATES: [CliVersionView, string, string, boolean][] = [
  [{ standing: "current" }, "up to date", "This is the newest Claude Code this Nouride was tested with.", false],
  [{ standing: "current", untested: "0.101.0" }, "up to date", "This is the newest Claude Code this Nouride was tested with. A newer one is out, not tested with it yet.", false],
  [{ standing: "update", offer: "0.100.0" }, "update out", "A newer version of Claude Code is out, one this Nouride was tested with.", true],
  [{ standing: "newer" }, "newer than tested", "This Claude Code is newer than this Nouride was tested with. It runs, but it was not tried with it.", false],
  [{ standing: "older", offer: "0.100.0" }, "too old", "This Claude Code is older than this Nouride supports. Update it.", true],
];

describe("each standing's words", () => {
  test("a badge, a sentence, and an update on offer where there is one", () => {
    for (const [view, badge, says, update] of STATES) expect(standingWords("Claude Code", view)).toMatchObject({ badge, says, update });
    expect(standingWords("Codex", { standing: "older" }).tone).toBe("warning");
    expect(standingWords("Codex", { standing: "newer" }).tone).toBe("warning");
    expect(standingWords("Codex", { standing: "current" }).tone).toBe("success");
  });
});

/** What a person reads without opening a Details. */
const plainText = (element: Element) => {
  const copy = element.cloneNode(true) as Element;
  for (const details of copy.querySelectorAll("details")) details.remove();
  return copy.textContent ?? "";
};

const card = (id: string, version: string, standing: CliVersionView): CliAccountsView => ({ id, name: "Claude Code", installed: true, version, package: "@agentclientprotocol/claude-agent-acp", standing, install: "npm i -g", shared: false, canLogin: true, accounts: [] });

describe("the Models page", () => {
  async function mount(clis: CliAccountsView[]): Promise<{ host: HTMLElement; asked: string[] }> {
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: "admin" });
      if (url.pathname === "/api/control/cli-accounts") return (asked.push(url.search), json({ clis }));
      if (url.pathname === "/api/control/status") return json({ orchestrator: "nouva", agents: [{ id: "nouva", displayName: "Nouva" }], gateways: [] });
      return json({ error: "not found" }, 404);
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
    const { CodingClis } = await import("@/modules/models/components/CodingClis");
    const root = createRootRoute({ component: () => React.createElement(Outlet) });
    const route = createRoute({ getParentRoute: () => root, path: "/", component: () => React.createElement(CodingClis) });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    createRoot(host).render(React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, React.createElement(RouterProvider, { router } as never)));
    await eventually(() => host.querySelectorAll("[data-standing]").length === clis.length, 3_000, "the standings");
    return { host, asked };
  }

  test("each CLI says where it stands in words, its numbers under Details", async () => {
    const { host } = await mount([card("a", "0.100.0", { standing: "current", untested: "0.101.0" }), card("b", "0.97.0", { standing: "update", offer: "0.100.0" }), card("c", "0.102.0", { standing: "newer" }), card("d", "0.90.0", { standing: "older", offer: "0.100.0" })]);
    // The badge and the sentence: the update's button below them comes once the orchestrator's name is known.
    const shown = [...host.querySelectorAll("[data-standing] > p")].map((element) => plainText(element).replace(/\s+/g, " ").trim());
    expect(shown).toEqual([
      "up to date This is the newest Claude Code this Nouride was tested with. A newer one is out, not tested with it yet.",
      "update out A newer version of Claude Code is out, one this Nouride was tested with.",
      "newer than tested This Claude Code is newer than this Nouride was tested with. It runs, but it was not tried with it.",
      "too old This Claude Code is older than this Nouride supports. Update it.",
    ]);
    // The numbers are for whoever runs the server: the one Nouride reads is not the one the CLI shows.
    const details = host.querySelector('[data-standing="older"] details')?.textContent ?? "";
    expect(details).toContain("@agentclientprotocol/claude-agent-acp 0.90.0 · an update installs 0.100.0");
    expect(plainText(host)).not.toContain("0.90.0");
  });

  test("an update on offer is a button that asks the orchestrator to run the update, in a message the person sends", async () => {
    const { host } = await mount([card("claude-code", "0.97.0", { standing: "update", offer: "0.100.0" }), card("codex", "2.5.0", { standing: "current" })]);
    const asking = () => [...host.querySelectorAll("a")].filter((link) => link.textContent?.trim() === "Ask Nouva to update it");
    await eventually(() => asking().length > 0, 3_000, "the update's button");
    const asks = asking();
    expect(asks).toHaveLength(1);
    const draft = new URL(asks[0]!.getAttribute("href")!, "http://localhost").searchParams.get("draft");
    expect(draft).toBe("Please update Claude Code on this server with `nouride agents update claude-code`, and tell me how it went.");
  });

  test("Check again asks the server afresh, which reads the newest out again", async () => {
    const { host, asked } = await mount([card("a", "0.100.0", { standing: "current" })]);
    const again = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Check again") as HTMLButtonElement;
    again.click();
    await eventually(() => asked.includes("?fresh=1"), 2_000, "the fresh read");
  });
});

describe("the Brain tab of an agent that works in it", () => {
  const CLI: AgentCli = { cli: "codex", profile: "work", permissions: "risky", model: null, models: [], effort: null, efforts: [], effortChoices: [], effortDefault: null, unavailable: null, login: null };

  async function brainTab(cli: AgentCli, scanned: Record<string, unknown>): Promise<HTMLElement> {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: "admin" });
      if (path === "/api/control/agents/coder/cli") return json(cli);
      if (path === "/api/control/agents/coder/cli/profiles") return json({ profiles: [], separate: true, models: [] });
      if (path === "/api/control/status") return json({ orchestrator: "nouva", agents: [{ id: "coder", displayName: "Coder" }, { id: "nouva", displayName: "Nouva" }], gateways: [] });
      if (path === "/api/control/external-clis") return json({ room: { enough: true, bytes: 0, needs: 0 }, clis: [scanned] });
      return json({ error: "not found" }, 404);
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
    const { ToastProvider } = await import("@/commons/components/ui/toast");
    const { default: AgentCliPage } = await import("@/modules/agents/cli.page");
    const routes = createRootRoute({ component: () => React.createElement(Outlet) });
    const page = createRoute({ getParentRoute: () => routes, path: "/", component: () => React.createElement(ToastProvider, null, React.createElement(AgentCliPage, { agentId: "coder" })) });
    const router = createRouter({ routeTree: routes.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    createRoot(host).render(React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, React.createElement(RouterProvider, { router } as never)));
    await eventually(() => (host.textContent ?? "").includes("Codex answers Coder"), 3_000, "the Brain tab");
    return host;
  }

  test("after a failed check its plain words say so, and the version before is a button that puts it back", async () => {
    const failed = { ...CLI, unavailable: "Codex 2.6.0 did not pass Nouride's check: it no longer offers steering. Go back to 2.5.0 (`nouride agents update codex 2.5.0`), or update Nouride", plain: "Its coding CLI was updated to a version that does not work with this Nouride. The version before can be put back.", wayBack: "2.5.0" };
    const host = await brainTab(failed, { id: "codex", name: "Codex", command: "codex-acp", installed: true, version: "2.6.0", install: "npm i -g", login: true, standing: { standing: "newer" } });
    await eventually(() => [...host.querySelectorAll("a")].some((link) => link.textContent?.trim() === "Ask Nouva to put it back"), 3_000, "the way back");
    const back = [...host.querySelectorAll("a")].find((link) => link.textContent?.trim() === "Ask Nouva to put it back")!;
    expect(new URL(back.getAttribute("href")!, "http://localhost").searchParams.get("draft")).toBe("Please put Codex on this server back to 2.5.0 with `nouride agents update codex 2.5.0`, and tell me how it went.");
    expect(plainText(host)).toContain("Its coding CLI was updated to a version that does not work with this Nouride.");
  });

  test("says the same words, under the CLI's name", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: "admin" });
      if (path === "/api/control/agents/coder/cli") return json(CLI);
      if (path === "/api/control/agents/coder/cli/profiles") return json({ profiles: [], separate: true, models: [] });
      if (path === "/api/control/status") return json({ agents: [{ id: "coder", displayName: "Coder" }], gateways: [] });
      if (path === "/api/control/external-clis") {
        return json({ room: { enough: true, bytes: 0, needs: 0 }, clis: [{ id: "codex", name: "Codex", command: "codex-acp", installed: true, version: "2.1.0", install: "npm i -g", login: true, standing: { standing: "older", offer: "2.5.0" } }] });
      }
      return json({ error: "not found" }, 404);
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
    const { ToastProvider } = await import("@/commons/components/ui/toast");
    const { default: AgentCliPage } = await import("@/modules/agents/cli.page");
    // The tab links to the Models page and folds the Model tab in: a router and a toaster to hold them.
    const routes = createRootRoute({ component: () => React.createElement(Outlet) });
    const page = createRoute({ getParentRoute: () => routes, path: "/", component: () => React.createElement(ToastProvider, null, React.createElement(AgentCliPage, { agentId: "coder" })) });
    const router = createRouter({ routeTree: routes.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    createRoot(host).render(React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, React.createElement(RouterProvider, { router } as never)));
    await eventually(() => host.querySelector("[data-standing]") !== null, 3_000, "the standing");
    expect(plainText(host.querySelector("[data-standing] > p")!).replace(/\s+/g, " ").trim()).toBe("too old This Codex is older than this Nouride supports. Update it.");
  });
});
