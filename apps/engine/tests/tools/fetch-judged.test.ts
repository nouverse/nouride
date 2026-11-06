/**
 * Every fetch behind the SSRF guard connects to the address the guard judged — never to a second lookup (S12).
 *
 * The check resolved a name and judged its addresses; the fetch then handed the URL to `fetch`, which resolved it
 * again. A resolver answering with a TTL of 0 gives the check a public address and the connection a private one, and
 * the guard was a guard over the first answer only.
 *
 * Planted for each caller with a name that cannot resolve (`.invalid`, RFC 6761) and a check that judged it to be at
 * the address a test server listens on. A fetch that looked the name up again fails; only one that connected to the
 * judged address reaches the server — which reads the host's name in the `Host` header, as a server behind a shared
 * address must.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { serveHttp } from "@nouride/runtime";
import type { Attachment, ToolContext } from "@nouride/shared";
import { postWebhook } from "@/modules/cron/webhook.ts";
import { hubBytes } from "@/modules/skills-hub/fetch.ts";
import { createSendFileTool } from "@/modules/tools/builtins/attach.ts";
import { createWebFetchTool } from "@/modules/tools/builtins/web/fetch.ts";
import type { checkUrl } from "@/modules/tools/url-safety.ts";

const posted: { host: string | null; body: string }[] = [];
const redirectedTo: string[] = [];

const server = serveHttp({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const host = req.headers.get("host");
    if (path === "/robots.txt") return new Response(`User-agent: *\nSitemap: http://${host}/sitemap.xml\n`);
    if (path === "/page") {
      return new Response(`<html><head><title>Judged</title></head><body><article><h1>Served to ${host}</h1><p>${"Read me. ".repeat(40)}</p></article></body></html>`, {
        headers: { "content-type": "text/html" },
      });
    }
    if (path === "/photo.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
    if (path === "/skill.tar") return new Response("tarball bytes");
    if (path === "/hook") {
      posted.push({ host, body: await req.text() });
      return new Response(null, { status: 204 });
    }
    if (path === "/moved") return new Response(null, { status: 301, headers: { location: `http://${host}/elsewhere` } });
    if (path === "/elsewhere") {
      redirectedTo.push(req.method);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

/** A PNG's signature and enough after it to be read as one. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);

/** Where the check says the name is: the test server, whatever a second lookup of the name would answer. */
const judged = "127.0.0.1";
const at = (name: string, path: string) => `http://${name}:${server.port}${path}`;
const judgedCheck: typeof checkUrl = async () => ({ allowed: true, addresses: [judged] });

const ctx = { agentId: "nouva", sessionId: "s", chatId: "c", gateway: "web", gatewayId: "web:dashboard", senderId: "u", workspaceDir: "/tmp", agentDir: "/tmp", workspaceRoots: ["/tmp"], signal: new AbortController().signal } as ToolContext;

describe("web_fetch", () => {
  test("reads the page from the judged address, the host's name in its Host header — and the site's robots.txt the same way", async () => {
    const tool = createWebFetchTool({ urlPolicy: { allowPrivate: false }, checkUrlImpl: judgedCheck });
    const result = await tool.execute({ url: at("rebind.invalid", "/page") }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`Served to rebind.invalid:${server.port}`);
    // The sitemap line is read from robots.txt, a second request: it too went to the judged address.
    expect(result.content).toContain(`sitemap: "http://rebind.invalid:${server.port}/sitemap.xml"`);
  });

  test("a check that allowed a URL without saying where it goes is not connected on", async () => {
    const tool = createWebFetchTool({ urlPolicy: { allowPrivate: false }, checkUrlImpl: async () => ({ allowed: true }) });
    const result = await tool.execute({ url: at("rebind.invalid", "/page") }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no checked address");
  });
});

describe("send_file", () => {
  test("downloads from the judged address", async () => {
    const sent: Attachment[] = [];
    const tool = createSendFileTool({
      send: async (_ctx, attachment) => (sent.push(attachment), { ids: ["m1"], delivered: true }),
      maxBytes: 1024 * 1024,
      urlPolicy: { allowPrivate: false },
      checkUrlImpl: judgedCheck,
    });
    const result = await tool.execute({ url: at("cdn.invalid", "/photo.png") }, ctx);
    expect(result.isError).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe("the skills hub", () => {
  test("downloads from the judged address", async () => {
    const bytes = await hubBytes(at("hub.invalid", "/skill.tar"), { checkUrlImpl: judgedCheck }, { maxBytes: 1024 });
    expect(new TextDecoder().decode(bytes)).toBe("tarball bytes");
  });
});

describe("a scheduled run's webhook", () => {
  test("is posted to the judged address, with the host's name in its Host header", async () => {
    posted.length = 0;
    await postWebhook(at("hook.invalid", "/hook"), { job: "daily" }, { allowPrivate: false }, judgedCheck);
    expect(posted).toEqual([{ host: `hook.invalid:${server.port}`, body: '{"job":"daily"}' }]);
  });

  test("is not redirected: the redirect is refused with where it pointed, and nothing reaches where it pointed", async () => {
    redirectedTo.length = 0;
    const sent = postWebhook(at("hook.invalid", "/moved"), { job: "daily" }, { allowPrivate: false }, judgedCheck);
    await expect(sent).rejects.toThrow(`a redirect to http://hook.invalid:${server.port}/elsewhere`);
    expect(redirectedTo).toEqual([]);
  });
});
