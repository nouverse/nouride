/**
 * Another site's page may not write through the dashboard's session, and the hosted gateway's own port signs
 * nobody in once its dashboard is a page of this one.
 *
 * `SameSite=Lax` was the whole of the CSRF defence: right for a cross-site form, no help against a same-site one — a
 * sibling subdomain is the same site. Planted for real here: the session cookie a browser would attach, on a POST the
 * browser marks as coming from another page, against the two surfaces that cookie opens.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { keepsStandaloneLogin, withoutStandaloneLogin } from "@/modules/gateways/nougate-port.ts";
import type { EmbeddedGateway } from "@/modules/gateways/nougate-inproc.ts";
import type { UsersPort } from "@/modules/users/users.store.ts";
import { controlGuard } from "@/modules/web/control/guard.ts";
import { LLM_GATEWAY_PREFIX, mountLlmGateway } from "@/modules/web/llm-gateway.ts";
import { crossSiteWrite } from "@/modules/web/same-origin.ts";

const TOKEN = "control-token-for-the-test";
const BOX = "https://agents.example.com";

/** The control API's guard in front of one write, signed in by the CLI's token — what reaches it is the guard's call. */
function control() {
  const app = new Hono();
  app.use("/api/control/*", controlGuard({ token: TOKEN } as never));
  app.post("/api/control/secrets", (c) => c.json({ written: true }));
  app.post("/api/control/auth/login", (c) => c.json({ signedIn: true }));
  app.get("/api/control/status", (c) => c.json({ ok: true }));
  return app;
}

const write = (path: string, headers: Record<string, string>) =>
  control().request(`${BOX}${path}`, { method: "POST", headers: { "x-nouride-token": TOKEN, ...headers }, body: "{}" });

describe("a write to the control API", () => {
  test("from another site — cross-site or a sibling subdomain — is refused, signed in or not", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await write("/api/control/secrets", { "sec-fetch-site": site });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { note: string }).note).toContain(site);
    }
  });

  test("a sign-in posted from another site too — a login CSRF signs the victim in as somebody else", async () => {
    expect((await write("/api/control/auth/login", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("from this daemon's own pages, a person's own navigation, or no browser at all — goes on", async () => {
    expect((await write("/api/control/secrets", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await write("/api/control/secrets", { "sec-fetch-site": "none" })).status).toBe(200);
    // The CLI: no Sec-Fetch-Site, no Origin.
    expect((await write("/api/control/secrets", {})).status).toBe(200);
  });

  test("a browser too old to say where it came from is judged by its Origin, against the host it addressed", async () => {
    expect((await write("/api/control/secrets", { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await write("/api/control/secrets", { origin: "null" })).status).toBe(403);
    expect((await write("/api/control/secrets", { origin: BOX, host: "agents.example.com" })).status).toBe(200);
    // Behind a reverse proxy that rewrote Host, the host the browser addressed is the forwarded one.
    expect((await write("/api/control/secrets", { origin: BOX, host: "127.0.0.1:18254", "x-forwarded-host": "agents.example.com" })).status).toBe(200);
  });

  test("a read is never asked — a link into the dashboard from anywhere still opens it", async () => {
    const res = await control().request(`${BOX}/api/control/status`, { headers: { "x-nouride-token": TOKEN, "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(200);
    expect(crossSiteWrite(new Request(`${BOX}/x`, { method: "HEAD", headers: { "sec-fetch-site": "cross-site" } }))).toBeNull();
  });
});

describe("a write to the hosted gateway's page", () => {
  test("from another site is refused before the gateway is asked — it holds every upstream account", async () => {
    let asked = 0;
    const gateway = { serveAs: async () => (asked++, new Response("{}")), reachableFromNetwork: false, port: 18256 } as unknown as EmbeddedGateway;
    const users = { sessionUser: () => ({ username: "gading", role: "admin" }) } as unknown as UsersPort;
    const web = new Hono();
    mountLlmGateway(web, { gateway, users });
    const post = (site: string) =>
      web.request(`${BOX}${LLM_GATEWAY_PREFIX}/api/accounts/reset-all`, { method: "POST", headers: { cookie: "nouride_session=admin", "sec-fetch-site": site } });

    expect((await post("same-site")).status).toBe(403);
    expect(asked).toBe(0);
    expect((await post("same-origin")).status).toBe(200);
    expect(asked).toBe(1);
  });
});

describe("the hosted gateway's own port", () => {
  const seen: Request[] = [];
  const port = withoutStandaloneLogin((request) => (seen.push(request), Response.json({ reached: true })));

  test("signs nobody in, and says where to go instead", async () => {
    seen.length = 0;
    const res = await port(new Request("http://box.lan:18256/api/auth/login", { method: "POST", body: '{"username":"admin","password":"lent"}' }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("Open LLM Gateway in Nouride's dashboard");
    expect(seen).toHaveLength(0);
    // However the path is spelled.
    expect((await port(new Request("http://box.lan:18256//api/auth/login/", { method: "POST" }))).status).toBe(403);
  });

  test("passes on no session cookie — one minted before the upgrade stops working with its password", async () => {
    seen.length = 0;
    await port(new Request("http://box.lan:18256/api/providers", { headers: { cookie: "nougate_session=minted-before", "x-test": "kept" } }));
    expect(seen[0]?.headers.get("cookie")).toBeNull();
    expect(seen[0]?.headers.get("x-test")).toBe("kept");
  });

  test("keeps its sign-in where it is the only way in: no dashboard here, or a bundle too old to show inside it", () => {
    expect(keepsStandaloneLogin({ hostedDashboard: true, embeddable: true })).toBe(false);
    expect(keepsStandaloneLogin({ hostedDashboard: false, embeddable: true })).toBe(true);
    expect(keepsStandaloneLogin({ hostedDashboard: true, embeddable: false })).toBe(true);
  });

  test("still answers what carries a key: the daemon's model calls and the clients on the network", async () => {
    seen.length = 0;
    const res = await port(
      new Request("http://127.0.0.1:18256/openai/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-nou-key" }, body: '{"model":"m"}' }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-nou-key");
    expect(await seen[0]?.text()).toBe('{"model":"m"}');
  });
});
