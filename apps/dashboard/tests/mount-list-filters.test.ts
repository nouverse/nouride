/**
 * A list's filters are the dashboard's one dropdown (`SearchSelect`), a short list with no field, where each page drew
 * the browser's own select: Helpers' kind and agent, Access's agent, the daemon log's level and component. What each
 * did is kept: the kind narrows the list on the page, the agent is the address's, the log asks the daemon again.
 * Missions' two are held where its other cases are (`mount-missions-list.test.ts`, `mount.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { BackgroundJob } from "@nouride/wire";
import { answer, dropdown, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });

/** Every address the page asks for under `path`, with its query, from here until `restore`. */
function asking(path: string) {
  const asked: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
    if (url.pathname.endsWith(path)) asked.push(url.search);
    return (spy as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = spy) };
}

const job = (id: string, over: Partial<BackgroundJob>): BackgroundJob => ({
  id, agentId: "nexa", gatewayId: "telegram:nexa", chatId: "555", command: `job ${id}`, kind: "command", cwd: "/srv/work", status: "succeeded", pid: null, exitCode: 0,
  startedAt: Date.now() - 120_000, endedAt: Date.now() - 60_000, logBytes: 10, logUpdatedAt: Date.now() - 60_000, processAlive: false, brief: null, report: null, turnId: null,
  ...over,
});

describe("Helpers", () => {
  const JOBS = [
    job("job_1", { kind: "helper", command: "helper: Render the video", brief: { goal: "Render the video", context: "", deliverable: "" } }),
    job("job_2", { command: "npx remotion render" }),
  ];

  test("the kind is a short dropdown that narrows the list on the page, with no select and no field", async () => {
    answer({ "/jobs": ok({ jobs: JOBS }) });
    const seen = { options: [] as string[], field: true, selects: -1, all: "", helpers: "", holds: "" };
    await renderPage("/jobs", async (host) => {
      await eventually(() => host.textContent?.includes("npx remotion render") === true, 2_000, "the jobs");
      seen.all = host.textContent ?? "";
      const kind = dropdown(host, "Kind");
      seen.options = await kind.open();
      seen.field = host.ownerDocument.body.querySelector('[role="combobox"]') !== null;
      seen.selects = host.querySelectorAll("main select").length;
      await kind.pick("Helpers");
      await eventually(() => host.textContent?.includes("npx remotion render") === false, 2_000, "the commands gone");
      seen.helpers = host.textContent ?? "";
      seen.holds = kind.holds() ?? "";
    });
    expect(seen.options).toEqual(["Every kind", "Helpers", "Commands", "Asked agents"]);
    expect(seen.field).toBe(false);
    expect(seen.selects).toBe(0);
    expect(seen.all).toContain("Render the video");
    expect(seen.helpers).toContain("Render the video");
    expect(seen.holds).toBe("Helpers");
  });

  test("the agent is the address's ?agent=: one picked asks for that agent's, and Every agent for all again", async () => {
    answer({
      "/jobs": ok({ jobs: JOBS }),
      "/status": ok({ status: "ready", gateways: [], providers: [], uptimeMs: 1, orchestrator: "nouva", agents: ["nouva", "nexa"].map((id) => ({ id, displayName: id, enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" })) }),
    });
    const watch = asking("/jobs");
    const seen = { options: [] as string[], held: "", search: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
    try {
      await renderPage("/jobs?agent=nexa", async (host, app) => {
        const agent = dropdown(host, "Agent");
        await eventually(() => agent.button() !== undefined, 2_000, "the agent filter");
        seen.held = agent.holds() ?? "";
        seen.options = await agent.open();
        await agent.pick("nouva (orchestrator)");
        await eventually(() => watch.asked.includes("?all=1&agent=nouva"), 2_000, "the orchestrator jobs asked for");
        seen.search = app.search();
        await agent.pick("Every agent");
        await eventually(() => app.search().agent === undefined, 2_000, "the address cleared");
        seen.after = app.search();
      });
    } finally {
      watch.restore();
    }
    expect(seen.held).toBe("nexa");
    expect(seen.options).toEqual(["Every agent", "nouva (orchestrator)", "nexa"]);
    expect(seen.search).toEqual({ agent: "nouva" });
    expect(seen.after).toEqual({});
    expect(watch.asked[0]).toBe("?all=1&agent=nexa");
  });
});

test("Access: the agent is a short dropdown, and what it picks is the address's ?agent= beside its tab", async () => {
  const seen = { options: [] as string[], held: "", search: {} as Record<string, unknown>, selects: -1 };
  await renderPage("/access?tab=denied", async (host, app) => {
    const agent = dropdown(host, "Agent");
    await eventually(() => agent.button() !== undefined, 2_000, "the agent filter");
    seen.held = agent.holds() ?? "";
    seen.options = await agent.open();
    seen.selects = host.querySelectorAll("main select").length;
    await agent.pick("nouva");
    await eventually(() => app.search().agent === "nouva", 2_000, "the address");
    seen.search = app.search();
  });
  expect(seen.held).toBe("All agents");
  expect(seen.options).toEqual(["All agents", "nouva"]);
  expect(seen.selects).toBe(0);
  expect(seen.search).toEqual({ tab: "denied", agent: "nouva" });
});

test("the daemon log: a level and a component picked are asked of the daemon, and the long list keeps a field", async () => {
  const logs = ok({
    entries: [{ id: 1, ts: 1_793_496_000_000, level: "warn", component: "gateway.telegram:nix", message: "polling restarted", data: {} }],
    total: 1,
    components: [{ component: "gateway.telegram:nix", entries: 12 }, { component: "cron", entries: 3 }],
    span: { oldest: 1_793_496_000_000, newest: 1_793_496_000_000 },
    retentionDays: 3,
  });
  answer({ "/logs/stored": logs });
  const watch = asking("/logs/stored");
  const seen = { levels: [] as string[], components: [] as string[], field: false, selects: -1 };
  try {
    await renderPage("/logs", async (host) => {
      await eventually(() => host.textContent?.includes("polling restarted") === true, 2_000, "the log");
      const level = dropdown(host, "Level");
      seen.levels = await level.open();
      await level.pick("Warnings and errors");
      await eventually(() => watch.asked.some((search) => search.includes("level=warn")), 2_000, "warnings asked for");
      const component = dropdown(host, "Component");
      seen.components = await component.open();
      seen.field = host.ownerDocument.body.querySelector('input[aria-label="Find a component"]') !== null;
      seen.selects = host.querySelectorAll("main select").length;
      await component.pick("cron");
      await eventually(() => watch.asked.some((search) => search.includes("level=warn") && search.includes("component=cron")), 2_000, "the component asked for");
    });
  } finally {
    watch.restore();
  }
  expect(seen.levels).toEqual(["All levels", "Info and above", "Warnings and errors", "Errors only"]);
  expect(seen.components).toEqual(["All components", "gateway.telegram:nix", "cron"]);
  expect(seen.field).toBe(true);
  expect(seen.selects).toBe(0);
});
