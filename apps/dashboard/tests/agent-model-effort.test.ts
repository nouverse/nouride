/**
 * The Effort choice on an agent's Model tab (0.8.17): for an agent its own model answers, the level its requests ask
 * for in every chat, as an external agent's CLI tab has for its CLI. The level it is on is the one checked, "Default"
 * names the install's; a level picked and saved is posted as the agent's own, "Default" as `default`. A viewer sees it
 * and cannot change it, a save the daemon refuses says why, and an external agent has none here: its CLI tab has it.
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

interface Served {
  role?: "admin" | "viewer";
  external?: boolean;
  effort?: string | null;
  /** What a save answers: refused with this error, or saved. */
  refuse?: string;
}

function serve(options: Served = {}): { posted: { path: string; body: unknown }[] } {
  const posted: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "POST") {
      posted.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
      return options.refuse ? json({ error: options.refuse }, 400) : json({ ok: true });
    }
    if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: options.role ?? "admin" });
    if (path === "/api/control/status") {
      return json({
        gateways: [],
        agents: [{ id: "nova", displayName: "Nova", provider: "gate", model: "small", effort: options.effort === undefined ? "high" : options.effort, effortDefault: "medium", ...(options.external ? { external: { cli: "codex", profile: "default" } } : {}) }],
      });
    }
    if (path === "/api/control/providers") return json({ providers: [{ name: "gate" }] });
    return json({ ok: false, models: [] });
  }) as typeof fetch;
  return { posted };
}

async function mount(): Promise<{ host: HTMLElement; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { default: AgentModelPage } = await import("@/modules/agents/model.page");
  const { ToastProvider } = await import("@/commons/components/ui/toast");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ToastProvider, null, React.createElement(AgentModelPage, { agentId: "nova" }))));
  await eventually(() => (host.querySelector('input[role="combobox"]') as HTMLInputElement | null)?.value === "small", 2_000, "the Model tab");
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
      client.clear();
    },
  };
}

const levels = (host: HTMLElement) => [...host.querySelectorAll('[role="radiogroup"][aria-label="Effort"] [role="radio"]')] as HTMLButtonElement[];
const level = (host: HTMLElement, text: string) => levels(host).find((entry) => entry.textContent?.trim() === text)!;
const checked = (host: HTMLElement) => levels(host).filter((entry) => entry.getAttribute("aria-checked") === "true").map((entry) => entry.textContent?.trim());
const saveButton = (host: HTMLElement) => [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Save") as HTMLButtonElement;

describe("the Effort choice on the Model tab", () => {
  test("checks the level it is on, names the install's default, and posts the level picked as its own", async () => {
    const { posted } = serve();
    const { host, unmount } = await mount();
    await eventually(() => levels(host).length > 0, 2_000, "the Effort choice");
    expect(levels(host).map((entry) => entry.textContent?.trim())).toEqual(["Default (medium)", "low", "medium", "high", "xhigh", "max"]);
    expect(checked(host)).toEqual(["high"]);
    // Nothing to save until another level is picked.
    expect(saveButton(host).disabled).toBe(true);
    level(host, "low").click();
    await eventually(() => checked(host)[0] === "low" && !saveButton(host).disabled, 2_000, "low picked");
    saveButton(host).click();
    await eventually(() => posted.length === 1, 2_000, "the save");
    expect(posted).toEqual([{ path: "/api/control/agents/nova/effort", body: { effort: "low" } }]);
    unmount();
  });

  test("Default is posted as `default`, and an agent with none of its own is on it", async () => {
    const { posted } = serve();
    const { host, unmount } = await mount();
    await eventually(() => levels(host).length > 0, 2_000, "the Effort choice");
    level(host, "Default (medium)").click();
    await eventually(() => !saveButton(host).disabled, 2_000, "Default picked");
    saveButton(host).click();
    await eventually(() => posted.length === 1, 2_000, "the save");
    expect(posted[0]!.body).toEqual({ effort: "default" });
    unmount();

    serve({ effort: null });
    const bare = await mount();
    await eventually(() => levels(bare.host).length > 0, 2_000, "the Effort choice");
    expect(checked(bare.host)).toEqual(["Default (medium)"]);
    bare.unmount();
  });

  test("a save the daemon refuses says why", async () => {
    serve({ refuse: "effort is one of low, medium, high, xhigh, max, default" });
    const { host, unmount } = await mount();
    await eventually(() => levels(host).length > 0, 2_000, "the Effort choice");
    level(host, "max").click();
    await eventually(() => !saveButton(host).disabled, 2_000, "max picked");
    saveButton(host).click();
    await eventually(() => (host.querySelector('[role="alert"]')?.textContent ?? "").includes("effort is one of"), 2_000, "the refusal");
    unmount();
  });

  test("a viewer sees the level and cannot change it", async () => {
    serve({ role: "viewer" });
    const { host, unmount } = await mount();
    await eventually(() => levels(host).length > 0, 2_000, "the Effort choice");
    expect(checked(host)).toEqual(["high"]);
    expect(levels(host).every((entry) => entry.disabled)).toBe(true);
    unmount();
  });

  test("an external agent has none here: its CLI tab chooses it", async () => {
    serve({ external: true });
    const { host, unmount } = await mount();
    expect(levels(host)).toEqual([]);
    expect(host.textContent).not.toContain("How long the model thinks before it answers");
    unmount();
  });
});
