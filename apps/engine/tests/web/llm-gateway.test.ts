/**
 * `/llm-gateway/*` — the bundled gateway's dashboard, served through the daemon's.
 *
 * What this has to get right is who reaches the gateway and as whom. A browser session, an admin's,
 * and nothing else; the request handed over is a new one the daemon vouches for, without the
 * browser's cookies; the gateway's own sign-in and OAuth landing routes are not reachable through it.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { EmbeddedGateway, HostRequest } from "@/modules/gateways/nougate-inproc.ts";
import type { UsersPort } from "@/modules/users/users.store.ts";
import { LLM_GATEWAY_PREFIX, mountLlmGateway } from "@/modules/web/llm-gateway.ts";

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
  as: HostRequest;
}

function fakeGateway(reachableFromNetwork = true) {
  const seen: Seen[] = [];
  const gateway: EmbeddedGateway = {
    url: "http://127.0.0.1:18256",
    port: 18256,
    reachableFromNetwork,
    serveAs: async (request, as) => {
      seen.push({
        url: new URL(request.url),
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? "" : await request.text(),
        as,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
      });
    },
    ensureHostKey: async () => ({ key: "unused", minted: false }),
    connectedModels: () => [],
    dashboardEmbeddable: () => true,
    resetAccounts: async () => 0,
    stop: async () => {},
  };
  return { gateway, seen };
}

/** Sessions by token: `admin`, `operator` and `viewer` each sign in with the role they are named. */
const users = {
  sessionUser: (token: string) =>
    ["admin", "operator", "viewer"].includes(token)
      ? { id: token, username: `${token}-person`, displayName: "", role: token, createdAt: 0, updatedAt: 0, mustChangePassword: false, lastLoginAt: null, hasPassword: true }
      : null,
} as unknown as UsersPort;

function app(reachable = true) {
  const { gateway, seen } = fakeGateway(reachable);
  const web = new Hono();
  mountLlmGateway(web, { gateway: () => gateway, users });
  return { web, seen };
}

const BOX = "http://box.lan:18254";
const as = (session?: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(session ? { cookie: `nouride_session=${session}` } : {}), ...(init.headers as Record<string, string> | undefined) },
});

describe("who gets through", () => {
  test("no session is a 401, and the gateway is never asked", async () => {
    const { web, seen } = app();
    const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`);
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("an operator or a viewer is refused — the gateway holds every upstream credential", async () => {
    const { web, seen } = app();
    for (const role of ["operator", "viewer"]) {
      const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`, as(role));
      expect(res.status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  test("the CLI's control token is not a way in", async () => {
    // A browser session only: the token is for the CLI, and accepting it here would be a second door.
    const { web, seen } = app();
    const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`, { headers: { "x-nouride-token": "" } });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe("what the gateway is handed", () => {
  test("the path under the prefix, the query, and the daemon's word for who is signed in", async () => {
    const { web, seen } = app();
    const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/metrics/recent?limit=5`, as("admin"));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.pathname).toBe("/api/metrics/recent");
    expect(seen[0]!.url.search).toBe("?limit=5");
    expect(seen[0]!.as).toEqual({ username: "admin-person", basePath: "/llm-gateway", apiOrigin: "http://box.lan:18256" });
  });

  test("never the browser's credentials", async () => {
    // The session cookie is a key to the daemon; the gateway is told who is signed in instead.
    const { web, seen } = app();
    await web.request(
      `${BOX}${LLM_GATEWAY_PREFIX}/api/providers`,
      as("admin", { headers: { authorization: "Bearer sk-nou-something", "x-api-key": "k", accept: "application/json" } }),
    );
    const headers = seen[0]!.headers;
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });

  test("a body goes with a write", async () => {
    const { web, seen } = app();
    await web.request(
      `${BOX}${LLM_GATEWAY_PREFIX}/api/providers/codex/accounts/add`,
      as("admin", { method: "POST", body: JSON.stringify({ code: "abc" }), headers: { "content-type": "application/json" } }),
    );
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body)).toEqual({ code: "abc" });
  });

  test("no API address is offered when the gateway's port answers only on the box", async () => {
    const { web, seen } = app(false);
    await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/frontend/`, as("admin"));
    expect(seen[0]!.as.apiOrigin).toBeUndefined();
  });

  test("the gateway's cross-origin headers are not passed on — there are no cross-origin callers here", async () => {
    const { web } = app();
    const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`, as("admin"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("what is not reachable through it", () => {
  test("the gateway's own sign-in and OAuth landings", async () => {
    // A GET that stores an account must not sit on the origin whose cookie a cross-site link carries.
    const { web, seen } = app();
    for (const path of ["/api/auth/login", "/api/auth/profile", "/api/auth/logout", "/oauth-callback?code=x", "/callback?code=x&state=y"]) {
      const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}${path}`, as("admin"));
      expect(res.status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  test("but the start of a sign-in is — it only redirects to the issuer", async () => {
    // Antigravity's `redirectUrl` is this path, relative to the gateway. Blocked, "Open sign-in" was a 404.
    const { web, seen } = app();
    const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/oauth/start`, as("admin"));
    expect(res.status).toBe(200);
    expect(seen[0]!.url.pathname).toBe("/oauth/start");
  });

  test("but who-am-I is: the dashboard asks it, and gets the daemon's answer", async () => {
    const { web, seen } = app();
    const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/auth/me`, as("admin"));
    expect(res.status).toBe(200);
    expect(seen[0]!.url.pathname).toBe("/api/auth/me");
  });

  test("the bare prefix leads to the dashboard", async () => {
    const { web } = app();
    const res = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}`, as("admin"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/llm-gateway/frontend/");
  });
});

describe("mounted on or off", () => {
  test("off, it answers in plain words without a status that reads as Nouride gone, and turned on, the same mount serves it", async () => {
    // Mounted whenever the build carries the gateway, so the setup wizard can turn it on and go straight to its sign-in
    // step with no restart. A 503 would have the dashboard wait for Nouride to come back from a restart nobody asked for.
    const { gateway, seen } = fakeGateway();
    let running: EmbeddedGateway | null = null;
    const web = new Hono();
    mountLlmGateway(web, { gateway: () => running, users });

    const off = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`, as("admin"));
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "the LLM gateway is off", plain: "Nougate is off. An admin can turn it on in the dashboard." });

    running = gateway;
    const on = await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`, as("admin"));
    expect(on.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test("off says nothing to somebody not signed in: who asks is checked first", async () => {
    const web = new Hono();
    mountLlmGateway(web, { gateway: () => null, users });
    expect((await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`)).status).toBe(401);
    expect((await web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/providers`, as("viewer"))).status).toBe(403);
  });
});
