/**
 * The proxy the environment names, for the connections Bun does not route through it by itself.
 *
 * Bun's `fetch` reads `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`; its `WebSocket`, and the `ws` it puts in place of
 * the npm package, read none of them. A hosted pod reaches the internet only through its egress proxy, so there every
 * chat app on a websocket dialled straight out and timed out, while Telegram, which only fetches, worked: WhatsApp
 * closed with 408 every 20 s for as long as the pod ran.
 *
 * The variables are read as Bun's `fetch` reads them (measured on Bun 1.4.4), so a websocket and a request to the
 * same host take the same way out: an https or wss URL takes `https_proxy`, then `HTTPS_PROXY`, and never the
 * HTTP ones; an http or ws URL takes `http_proxy`, then `HTTP_PROXY`. `NO_PROXY` (or `no_proxy`) lists hosts that go
 * direct: `*` for all, a name for itself and every name under it, a leading `.` or `*.` the same, and `:port` to
 * match one port only.
 */

import { Agent, type AgentOptions } from "node:https";

type Env = Record<string, string | undefined>;

/** The proxy URL a connection to `target` goes through, or null for a direct one. */
export function proxyFor(target: string | URL, env: Env = process.env): string | null {
  const url = new URL(target);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const named = (secure ? (env.https_proxy ?? env.HTTPS_PROXY) : (env.http_proxy ?? env.HTTP_PROXY))?.trim();
  if (!named || bypassed(url, env.no_proxy ?? env.NO_PROXY ?? "")) return null;
  // A proxy written without a scheme is an HTTP one, as `fetch` takes it.
  return named.includes("://") ? named : `http://${named}`;
}

function bypassed(url: URL, noProxy: string): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const withPort = /^(.+):(\d+)$/.exec(entry);
    if (withPort && withPort[2] !== port) continue;
    const name = (withPort ? withPort[1]! : entry).replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

/**
 * An agent for Bun's `ws`, carrying the proxy a connection to `target` goes through; undefined when it goes direct.
 *
 * Bun's `ws` takes no proxy from the environment, and reads one off the agent it is handed instead (its
 * `options.proxy`, the shape `https-proxy-agent` has), then tunnels with CONNECT. That is how a library that only
 * passes an `agent` through to `ws` — Baileys does — is given the proxy.
 */
export function proxyAgentFor(target: string, env: Env = process.env): Agent | undefined {
  const proxy = proxyFor(target, env);
  // `proxy` is not one of Node's agent options; it is the one Bun's `ws` reads.
  return proxy ? new Agent({ proxy } as AgentOptions) : undefined;
}
