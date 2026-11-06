/**
 * The response headers the dashboard is served with.
 *
 * Pinned because a CSP fails the way nothing else in this codebase does: **silently, and only in a
 * browser.** No log line, no failed request, no test going red — a console warning nobody is looking
 * at, and a feature that just does not work. That is not hypothetical: attachment previews shipped
 * broken because `URL.createObjectURL` produces a `blob:` URL and `img-src` allowed only `self` and
 * `data:`. Everything typechecked, every test passed, and the thumbnail was a broken-image icon.
 *
 * So each directive here is asserted with the reason it exists. A future tightening that breaks a
 * feature should break a test first.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { parseConfig } from "@/modules/config/global/index.ts";
import { bindWebServer, GATEWAY_SECURITY_HEADERS, SECURITY_HEADERS, type WebServer } from "@/modules/web/server.ts";

const csp = SECURITY_HEADERS["Content-Security-Policy"] ?? "";
const gateway = GATEWAY_SECURITY_HEADERS["Content-Security-Policy"] ?? "";
const directive = (name: string): string =>
  csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `)) ?? "";

describe("what the dashboard may load", () => {
  test("images: its own files, data URLs, and the object URLs it creates itself", () => {
    const img = directive("img-src");
    expect(img).toContain("'self'");
    // A picked file has no address until the page gives it one, and that address is a blob.
    expect(img).toContain("blob:");
    expect(img).toContain("data:");
  });

  test("scripts and connections stay same-origin", () => {
    // The dashboard is a static SPA talking to same-origin JSON. Nothing it does needs a third party,
    // and `blob:` above is deliberately *not* extended to either of these — a blob script is a script.
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("script-src")).not.toContain("blob:");
    expect(directive("script-src")).not.toContain("unsafe-inline");
  });

  test("inline styles are allowed and inline scripts are not", () => {
    // Vite emits an inline style tag for critical CSS; a style attribute carries no equivalent risk.
    expect(directive("style-src")).toContain("'unsafe-inline'");
  });

  test("nothing may frame it, and nothing may rewrite its base URL", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  test("the browser is told not to guess content types", () => {
    // With `nosniff`, a response whose Content-Type is lost is a response the browser refuses to
    // apply — which is why the header middleware mutates the response in place instead of rebuilding it.
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("referrers do not leak the session id in a URL", () => {
    // A chat URL contains the conversation's id. Nothing outside should ever be told it.
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });
});

/**
 * The gateway's dashboard, under a policy of its own (S9): another product's frontend, on this origin with this
 * session, allowed what its bundle loads and nothing the dashboard happens to need. Checked in headless Chrome
 * against every gateway page, framed and in its own tab, with no violation in the console.
 */
describe("the LLM Gateway's own policy", () => {
  const gatewayDirective = (name: string): string =>
    gateway.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";

  test("starts from nothing, rather than from the dashboard's policy", () => {
    expect(gatewayDirective("default-src")).toBe("default-src 'none'");
    expect(gateway).not.toBe(csp);
  });

  test("allows what its bundle loads: its scripts, styles and API, its images and daisyUI's data: masks", () => {
    expect(gatewayDirective("script-src")).toBe("script-src 'self'");
    expect(gatewayDirective("connect-src")).toBe("connect-src 'self'");
    expect(gatewayDirective("img-src")).toBe("img-src 'self' data:");
    expect(gatewayDirective("style-src")).toBe("style-src 'self'");
  });

  test("and none of what only the dashboard needs: inline styles, blob: images", () => {
    expect(gateway).not.toContain("unsafe-inline");
    expect(gateway).not.toContain("blob:");
  });

  test("may be framed by this origin and nothing else, posts forms only here, and keeps its base URL", () => {
    // The LLM Gateway page frames `/llm-gateway/frontend/` — same origin, by construction.
    expect(gatewayDirective("frame-ancestors")).toBe("frame-ancestors 'self'");
    expect(GATEWAY_SECURITY_HEADERS["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(gatewayDirective("form-action")).toBe("form-action 'self'");
    expect(gatewayDirective("base-uri")).toBe("base-uri 'none'");
  });
});

/** Which policy a response actually carries — the gateway's on `/llm-gateway` and under it, the dashboard's everywhere else. */
describe("the policy each path is served with", () => {
  let web: WebServer | undefined;
  afterAll(async () => {
    await web?.server.stop(true);
  });

  test("the gateway's pages get the gateway's, and nothing else does", async () => {
    const config = parseConfig({});
    config.dashboard.host = "127.0.0.1";
    config.dashboard.port = 0;
    web = bindWebServer(config, Date.now(), { phase: "ready" });
    web.serve(
      { config, db: { walSizeBytes: () => 0 }, gateways: new Map(), startedAt: Date.now(), configSource: null, status: "ready", agentCount: 0, providerErrors: new Map(), backgroundTimers: [] } as never,
      { mountLlmGateway: (app) => app.all("/llm-gateway/*", (c) => c.text("gateway")) },
    );
    const policy = async (path: string) =>
      (await fetch(`http://127.0.0.1:${web!.server.port}${path}`, { redirect: "manual" })).headers.get("content-security-policy");

    expect(await policy("/llm-gateway/frontend/")).toBe(gateway);
    expect(await policy("/dashboard/")).toBe(csp);
    expect(await policy("/api/health")).toBe(csp);
    // A path that only starts with the same letters is not the gateway's.
    expect(await policy("/llm-gatewayx")).toBe(csp);
  });
});
