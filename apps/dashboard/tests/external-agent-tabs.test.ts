/**
 * An external agent's tabs say what of them its CLI uses (0.8.1). Model: the CLI answers on its own model, chosen on the
 * Brain tab, and what the model here is for — the owner read the two as one, and asked whether a fallback would answer when
 * the CLI ran out. Skills: whether Nouride's reach the CLI, and when a change does. Settings: the tool budget does not apply.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

async function mount(external: boolean): Promise<string> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: "admin" });
    if (path === "/api/control/status") return json({ gateways: [], agents: [{ id: "coder", displayName: "Coder", provider: "gate", model: "small", ...(external ? { external: { cli: "codex", profile: "default" } } : {}) }] });
    if (path === "/api/control/providers") return json({ providers: [{ name: "gate" }] });
    return json({ ok: false, models: [] });
  }) as typeof fetch;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { default: AgentModelPage } = await import("@/modules/agents/model.page");
  const { ToastProvider } = await import("@/commons/components/ui/toast");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ToastProvider, null, React.createElement(AgentModelPage, { agentId: "coder" }))));
  await eventually(() => (host.querySelector('input[role="combobox"]') as HTMLInputElement | null)?.value === "small" && (!external || (host.textContent ?? "").includes("answers Coder")), 2_000, "the Model tab");
  const text = host.textContent ?? "";
  root.unmount();
  host.remove();
  client.clear();
  return text;
}

describe("an external agent's tabs", () => {
  test("for an external agent, says the CLI answers on its own model and what this one is for", async () => {
    const text = await mount(true);
    expect(text).toContain("codex answers Coder, on its own model, chosen above on the Brain tab.");
    // The owner asked whether a fallback would answer when the CLI's account runs out: the agent's own model does.
    expect(text).toContain("and answer a turn codex cannot, signed out or at its account's limit, saying so.");
  });

  test("for any other agent, says nothing of a CLI", async () => {
    expect(await mount(false)).not.toContain("codex");
  });

  test("the Skills and Settings tabs of an external agent say what reaches its CLI and what does not, and no other agent's do", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/control/status") return json({ gateways: [], agents: [{ id: "coder", displayName: "Coder", external: { cli: "codex", name: "codex", profile: "default", skills: true } }, { id: "nouva", displayName: "Nouva" }] });
      return json({});
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { ExternalNote } = await import("@/modules/agents/components/ExternalNote");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const note = (agentId: string) => React.createElement(ExternalNote, { agentId, says: ({ name, cli }) => `${cli} answers ${name}` });
    // A note says what holds for this CLI: Claude Code reads the agent's skills.
    const skillsNote = React.createElement(ExternalNote, { agentId: "coder", says: ({ skills }) => (skills ? "skills reach it" : "skills do not reach it") });
    root.render(React.createElement(QueryClientProvider, { client }, note("coder"), note("nouva"), skillsNote));
    try {
      await eventually(() => (host.textContent ?? "").includes("codex answers Coder"), 2_000, "the note");
      expect(host.textContent).not.toContain("Nouva");
      expect(host.textContent).toContain("skills reach it");
      expect(host.textContent).not.toContain("skills do not reach it");
    } finally {
      root.unmount();
      host.remove();
      client.clear();
    }
    // Each tab's words, as its page passes them.
    const page = (name: string) => readFileSync(join(import.meta.dir, "../src/modules/agents", name), "utf8");
    expect(page("skills.page.tsx")).toContain("`${cli} gets the skills switched on here. A change reaches a conversation as it starts. In a chat already going, send /new or /reset.`");
    expect(page("skills.page.tsx")).toContain("`Nouride's skills do not reach ${cli} yet: it uses its own. What you switch here applies when ${name} goes back to its model.`");
    expect(page("agent-settings.page.tsx")).toContain("`${cli} runs its own tool loop, so the tool budget does not apply to it. The tools picked here are the Nouride tools lent to it");
  });

  test("its card says the CLI, its model and account, and why it cannot answer; its page has one Brain tab for CLI and Model", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: "admin" });
      if (path === "/api/control/status") return json({ gateways: [], orchestrator: "nouva", agents: [{ id: "nox", displayName: "Nox", enabled: true, tools: [], external: { cli: "claude-code", name: "Claude Code", profile: "team", skills: true, model: null, cliDefault: "Opus 5.5" }, activity: { state: "idle", unavailable: "Claude Code is not signed in — sign in on the agent's Brain tab" } }] });
      if (path === "/api/control/gateways") return json({ gateways: [] });
      return json({});
    }) as typeof fetch;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
    const { default: AgentListPage } = await import("@/modules/agents/index.page");
    const routes = createRootRoute({ component: () => React.createElement(Outlet) });
    const page = createRoute({ getParentRoute: () => routes, path: "/", component: () => React.createElement(AgentListPage) });
    const router = createRouter({ routeTree: routes.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
    try {
      await eventually(() => (host.textContent ?? "").includes("Nox"), 3_000, "the card");
      // Its model is its CLI's default as a session named it, not its `[llm]` (0.8.1).
      expect(host.textContent).toContain("Claude Code · Opus 5.5 (default) · account team");
      expect(host.textContent).toContain("Claude Code is not signed in — sign in on the agent's Brain tab");
      expect(host.textContent).not.toContain("External");
    } finally {
      root.unmount();
      host.remove();
      client.clear();
    }
    const layout = readFileSync(join(import.meta.dir, "../src/modules/agents/layout.page.tsx"), "utf8");
    expect(layout).toContain('const BRAIN_TAB: Tab = { to: "/agents/$agentId/cli", label: "Brain", icon: Terminal };');
    expect(layout).toContain("(agent.external ? [TABS[0]!, BRAIN_TAB, ...TABS.slice(2)] : TABS)");
  });
});
