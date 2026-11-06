/**
 * One job on the Schedule page (0.8.11): `?job=<id>`, the link an agent hands a person for a job it proposed. Its card is
 * marked and its runs open; an id the list does not hold, or one that is not an id, leaves the page as it opens without
 * it. Rendered against a stand-in for the daemon's routes.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { JobSummary } from "@/commons/lib/api.cron";
import { jobCardId, parseScheduleSearch } from "@/modules/schedule/search";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "requestAnimationFrame"] as const;
let dom: Window;
let realFetch: typeof fetch;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/schedule" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const job = (id: string, name: string, enabled: boolean): JobSummary => ({
  id, agentId: "nouva", name, enabled,
  trigger: { kind: "cron", expr: "0 9 * * 1-5" },
  payload: { kind: "systemEvent", text: name },
  delivery: { mode: "announce" },
  target: { gatewayId: "telegram:nouva", chatId: "8142" },
  session: "fresh", createdBy: "agent:nouva", createdAt: 1, runCount: 0, failCount: 0, failStreak: 0,
  describes: "weekdays at 09:00",
});

const JOBS = [job("cron_standup", "Standup", true), job("cron_backup", "Backup", false)];

function serve(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/control/auth/me") return json({ id: "u1", username: "gading", role: "admin" });
    if (path === "/api/control/cron") return json({ jobs: JOBS, timezone: "Asia/Jakarta" });
    if (path.startsWith("/api/control/cron/")) return json({ job: JOBS.find((one) => path.endsWith(one.id)), runs: [], timezone: "Asia/Jakarta" });
    if (path === "/api/control/status") return json({ agents: [], gateways: [] });
    if (path === "/api/control/gateways") return json({ gateways: [] });
    if (path === "/api/control/sessions") return json({ sessions: [] });
    if (path === "/api/control/chats") return json({ chats: [] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

async function mount(linked?: string): Promise<{ host: HTMLElement; unmount: () => void }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { ToastProvider } = await import("@/commons/components/ui/toast");
  const { default: SchedulePage } = await import("@/modules/schedule/index.page");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page: { job?: string } = linked ? { job: linked } : {};
  root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ToastProvider, null, React.createElement(SchedulePage, page))));
  await eventually(() => (host.textContent ?? "").includes("Standup") && (host.textContent ?? "").includes("Backup"), 3_000, "the Schedule page with its jobs");
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
      client.clear();
    },
  };
}

const card = (host: HTMLElement, id: string) => host.querySelector(`#${jobCardId(id)}`) as HTMLElement | null;
const opened = (host: HTMLElement) => [...host.querySelectorAll("button")].filter((one) => one.textContent?.includes("Hide execution runs")).length;

describe("`?job=` on the Schedule page", () => {
  test("the job it names is marked and its runs open; the others are not", async () => {
    serve();
    const { host, unmount } = await mount("cron_backup");
    try {
      await eventually(() => opened(host) === 1, 3_000, "its runs open");
      expect(card(host, "cron_backup")?.getAttribute("aria-current")).toBe("true");
      expect(card(host, "cron_backup")?.textContent).toContain("Hide execution runs");
      expect(card(host, "cron_standup")?.getAttribute("aria-current")).toBeNull();
    } finally {
      unmount();
    }
  });

  test("an id the list does not hold leaves the page as it is: nothing marked, no runs open", async () => {
    serve();
    const { host, unmount } = await mount("cron_gone");
    try {
      expect(host.querySelector('[aria-current="true"]')).toBeNull();
      expect(opened(host)).toBe(0);
      expect(card(host, "cron_standup")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("a value that is not an id is dropped before the page sees it", () => {
    expect(parseScheduleSearch({ job: "cron_standup" })).toEqual({ job: "cron_standup" });
    for (const job of ["", "a b", "x\"><img>", "../cron", "a".repeat(65), 7, ["cron_standup"]]) expect(parseScheduleSearch({ job })).toEqual({});
  });
});
