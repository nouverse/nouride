/**
 * The LLM gateway a `router` build carries, as the dashboard sees it.
 *
 * The daemon serves its dashboard and API under `bundledGateway.mount`; everything that offers the
 * LLM Gateway page or the wizard's sign-in step goes through `gatewayMount`, so "is there a gateway"
 * and "can this daemon serve it" are asked once, together.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gatewayDashboard, gatewayMount, isBundledEndpoint, nougateConsoleUrl } from "@/commons/lib/bundled-gateway";

describe("gatewayMount", () => {
  test("a running, mounted gateway answers its mount", () => {
    expect(gatewayMount({ hasUser: true, hasProvider: false, hasAgent: false, complete: false, bundledGateway: { available: true, baseUrl: "http://127.0.0.1:18256", mount: "/llm-gateway" } })).toBe("/llm-gateway");
  });

  test("running but not mounted is nothing — a daemon older than the mount", () => {
    // The sign-in step would send every request to a route that is not there.
    expect(gatewayMount({ hasUser: true, hasProvider: false, hasAgent: false, complete: false, bundledGateway: { available: true, baseUrl: "http://127.0.0.1:18256" } })).toBeNull();
  });

  test("a mount for a gateway that is switched off is nothing", () => {
    expect(gatewayMount({ hasUser: true, hasProvider: false, hasAgent: false, complete: false, bundledGateway: { available: false, mount: "/llm-gateway" } })).toBeNull();
  });

  test("no state, or no field, is no gateway rather than a crash", () => {
    expect(gatewayMount(undefined)).toBeNull();
    expect(gatewayMount(null)).toBeNull();
    expect(gatewayMount({ hasUser: true, hasProvider: true, hasAgent: true, complete: true })).toBeNull();
  });
});

describe("gatewayDashboard", () => {
  const base = { hasUser: true, hasProvider: true, hasAgent: true, complete: true };

  test("the page is offered only where the bundle beside the binary can be framed", () => {
    expect(gatewayDashboard({ ...base, bundledGateway: { available: true, mount: "/llm-gateway", dashboard: true } })).toBe("/llm-gateway");
    // An update from before 2026-10-15 replaced the binary and not the bundle. The sign-in step still
    // works — it is the gateway's API — but the page would frame a dashboard that calls the wrong API.
    expect(gatewayDashboard({ ...base, bundledGateway: { available: true, mount: "/llm-gateway", dashboard: false } })).toBeNull();
    expect(gatewayMount({ ...base, bundledGateway: { available: true, mount: "/llm-gateway", dashboard: false } })).toBe("/llm-gateway");
  });

  test("a daemon that does not say is not believed", () => {
    expect(gatewayDashboard({ ...base, bundledGateway: { available: true, mount: "/llm-gateway" } })).toBeNull();
  });
});

describe("isBundledEndpoint", () => {
  const state = {
    hasUser: true, hasProvider: true, hasAgent: true, complete: true,
    bundledGateway: { available: true, baseUrl: "http://127.0.0.1:18256", mount: "/llm-gateway", dashboard: true },
  };

  test("the hosted gateway's endpoints are recognised, on either wire format", () => {
    expect(isBundledEndpoint("http://127.0.0.1:18256/openai/v1", state)).toBe(true);
    expect(isBundledEndpoint("http://127.0.0.1:18256/anthropic/v1", state)).toBe(true);
  });

  test("another nougate, or another port, is not this one", () => {
    expect(isBundledEndpoint("http://192.168.0.10:3000/openai/v1", state)).toBe(false);
    expect(isBundledEndpoint("http://127.0.0.1:18257/openai/v1", state)).toBe(false);
  });

  test("no link to a page that cannot show it", () => {
    expect(isBundledEndpoint("http://127.0.0.1:18256/openai/v1", { ...state, bundledGateway: { available: true, baseUrl: "http://127.0.0.1:18256" } })).toBe(false);
    expect(isBundledEndpoint("http://127.0.0.1:18256/openai/v1", { ...state, bundledGateway: { ...state.bundledGateway, dashboard: false } })).toBe(false);
  });
});

describe("nougateConsoleUrl", () => {
  test("a nougate endpoint yields its console", () => {
    expect(nougateConsoleUrl("http://192.168.0.10:3000/openai/v1")).toBe("http://192.168.0.10:3000");
    expect(nougateConsoleUrl("https://gw.example.com/anthropic/v1")).toBe("https://gw.example.com");
  });

  test("the bundled gateway gets no link", () => {
    /**
     * The half that matters. `127.0.0.1` is the *daemon's* loopback; a link would open the reader's
     * own machine, find nothing, and read as "the console is down". The bundled gateway also serves
     * the backend alone — there is no console there to reach even from the right host.
     */
    expect(nougateConsoleUrl("http://127.0.0.1:18256/openai/v1")).toBeNull();
    expect(nougateConsoleUrl("http://localhost:18256/anthropic/v1")).toBeNull();
  });

  test("a provider that is not a nougate gets no link", () => {
    // The origin of an API host is a marketing site, which is not what anybody clicked for.
    expect(nougateConsoleUrl("https://api.openai.com/v1")).toBeNull();
    expect(nougateConsoleUrl("https://api.anthropic.com/v1")).toBeNull();
    expect(nougateConsoleUrl("")).toBeNull();
  });

  test("a trailing slash still resolves", () => {
    expect(nougateConsoleUrl("http://192.168.0.10:3000/openai/v1/")).toBe("http://192.168.0.10:3000");
  });
});

/**
 * Pro Router became Pro in 0.7.20: a Pro install hosts the gateway when its config says so, and its edition is `pro`
 * either way. So nothing that offers the gateway may ask which edition this is — only what the daemon says it runs.
 */
describe("the gateway is offered by what runs, never by the edition", () => {
  const src = join(import.meta.dir, "../src");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
    );

  test("a Pro daemon with its gateway on gets the LLM Gateway page", () => {
    const state = { bundledGateway: { available: true, mount: "/llm-gateway", dashboard: true } };
    expect(gatewayDashboard({ ...state, edition: "pro" } as never)).toBe("/llm-gateway");
  });

  test("no dashboard source names `pro-router`, the edition Pro was until 0.7.20 — not even to label it", () => {
    const naming = files(src)
      .filter((path) => readFileSync(path, "utf8").includes("pro-router"))
      .map((path) => path.slice(src.length + 1));
    expect(naming).toEqual([]);
  });
});
