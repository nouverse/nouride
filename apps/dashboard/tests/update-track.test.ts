/**
 * The Update page's track (0.8.18): the track the install follows is the one checked, each choice says what it would
 * install now (the long-term line's newest beside the newest once both exist), picking the other posts it, a viewer
 * sees it and cannot change it, a refusal says why, and a daemon before 0.8.18 shows no card.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let realFetch: typeof fetch;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/update" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CHECK = {
  current: "1.0.5",
  latest: "v1.0.7",
  newer: true,
  track: "lts",
  publishedAt: null,
  notesUrl: null,
  otherTrack: { track: "latest", tag: "v1.1.0" },
};

function serve(options: { role?: "admin" | "viewer"; refuse?: string; check?: Record<string, unknown> } = {}) {
  const posted: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "POST") {
      posted.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
      return options.refuse ? json({ error: options.refuse }, 400) : json({ ok: true, track: "latest" });
    }
    if (path === "/api/control/auth/me") return json({ id: "u1", username: "mira", role: options.role ?? "admin" });
    return json({ ok: false });
  }) as typeof fetch;
  return { posted };
}

async function mount(check: Record<string, unknown> = CHECK) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { TrackCard } = await import("@/modules/update/TrackCard");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(TrackCard, { check: check as never })));
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
      client.clear();
    },
  };
}

const choices = (host: HTMLElement) => [...host.querySelectorAll('[role="radiogroup"][aria-label="Which updates"] [role="radio"]')] as HTMLButtonElement[];
const named = (host: HTMLElement, label: string) => choices(host).find((entry) => entry.textContent?.startsWith(label))!;

describe("the update track on the Update page", () => {
  test("checks the track followed, and each choice says what it would install now", async () => {
    serve();
    const { host, unmount } = await mount();
    await eventually(() => choices(host).length === 2, 2_000, "the two tracks");
    expect(named(host, "Stable").getAttribute("aria-checked")).toBe("true");
    expect(named(host, "Stable").textContent).toContain("v1.0.7");
    expect(named(host, "Newest").getAttribute("aria-checked")).toBe("false");
    expect(named(host, "Newest").textContent).toContain("v1.1.0");
    unmount();
  });

  test("an admin picking the other track posts it", async () => {
    const { posted } = serve();
    const { host, unmount } = await mount();
    await eventually(() => !!named(host, "Newest") && !named(host, "Newest").disabled, 2_000, "an admin's choice");
    named(host, "Newest").click();
    await eventually(() => posted.length === 1, 2_000, "the save");
    expect(posted).toEqual([{ path: "/api/control/update/track", body: { track: "latest" } }]);
    unmount();
  });

  test("a refusal says why", async () => {
    serve({ refuse: '[update] track must be one of "latest", "lts"' });
    const { host, unmount } = await mount();
    await eventually(() => !!named(host, "Newest") && !named(host, "Newest").disabled, 2_000, "an admin's choice");
    named(host, "Newest").click();
    await eventually(() => (host.querySelector('[role="alert"]')?.textContent ?? "").includes("[update] track must be one of"), 2_000, "the refusal");
    unmount();
  });

  test("a viewer sees it and cannot change it", async () => {
    serve({ role: "viewer" });
    const { host, unmount } = await mount();
    await eventually(() => (host.textContent ?? "").includes("Only an admin can change this."), 2_000, "the viewer's note");
    expect(choices(host).every((entry) => entry.disabled)).toBe(true);
    unmount();
  });

  test("before both tracks differ they offer the same, and a daemon before 0.8.18 shows no card", async () => {
    serve();
    const same = await mount({ current: "0.8.18", latest: "0.8.18", newer: false, track: "latest", publishedAt: null, notesUrl: null });
    await eventually(() => choices(same.host).length === 2, 2_000, "the two tracks");
    expect(named(same.host, "Newest").textContent).toContain("0.8.18, installed");
    expect(named(same.host, "Stable").textContent).toContain("0.8.18, installed");
    same.unmount();
    // Rendered on the server, which has no wait to make: no track, no card.
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { TrackCard } = await import("@/modules/update/TrackCard");
    const old = { current: "0.8.17", latest: "0.8.17", newer: false, publishedAt: null, notesUrl: null };
    expect(renderToString(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(TrackCard, { check: old })))).toBe("");
  });
});
