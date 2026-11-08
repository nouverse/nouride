/**
 * Network adapter (TD-001).
 *
 * DNS, and a fetch that does not do its own: the SSRF guard has to know what a hostname actually resolves to before
 * anything connects to it, and then has to connect to *that* — not to whatever the name says a moment later.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

/**
 * This machine's own IPv4 addresses on its networks — not loopback, not link-local. For telling a person
 * where a daemon bound to every interface can be opened from another device.
 */
export function localIPv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
}

/**
 * Every address a hostname resolves to, v4 and v6.
 *
 * All of them, not the first: a name that answers with one public and one private address must be
 * judged on the private one, and `lookup` without `all` would hide it.
 */
export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * Whether a string is already a literal IP address, and which family.
 *
 * `0` for "not an IP", `4` or `6` otherwise. The SSRF guard needs it to tell a hostname that has to
 * be resolved from an address that can be judged as it stands.
 */
export { isIP };

/**
 * Fetch a URL from one address — the one a check already resolved and judged — rather than resolving its name again.
 *
 * A check that resolves a name and a fetch that resolves it again are two answers, and a resolver that answers with a
 * TTL of 0 can give the check a public address and the connection `127.0.0.1` or the cloud's metadata service. So the
 * connection goes to `address`, and everything that names the host goes on naming it: the `Host` header, the TLS
 * server name, and the name the certificate is checked against — so a page served by a CDN still gets its own
 * certificate, and an address that is not the host's cannot pass as it.
 *
 * Redirects are never followed here. The next hop is another name, and another check; the caller walks them.
 * A URL whose host is already an address has nothing to pin and is fetched as it is.
 */
export async function fetchAt(url: string, address: string, init: BunFetchRequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const options: BunFetchRequestInit = { ...init, redirect: "manual" };
  if (isIP(host)) return await fetch(url, options);

  const pinned = new URL(url);
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  const headers = new Headers(init.headers);
  // `host` includes a port that is not the scheme's own, which is what the server expects to read.
  headers.set("host", target.host);
  return await fetch(pinned.toString(), {
    ...options,
    headers,
    ...(target.protocol === "https:"
      ? {
          tls: {
            ...init.tls,
            // The name the server picks its certificate by, and the one that certificate has to be for. Bun keys a
            // pooled connection by the server name, so a connection is only reused for the name it was checked for.
            serverName: host,
            checkServerIdentity: (_address: string, cert: PeerCertificate) => checkServerIdentity(host, cert),
          },
        }
      : {}),
  });
}
