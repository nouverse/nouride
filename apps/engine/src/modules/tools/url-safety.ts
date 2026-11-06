import { fetchAt, isIP, resolveHostAddresses } from "@nouride/runtime";
/**
 * SSRF guard for anything the agent fetches.
 *
 * The attack: a page the agent reads, or a message someone sends it, talks it into fetching an
 * address only the *server* can reach. On a cloud VM `169.254.169.254` hands out IAM credentials;
 * on any box, `127.0.0.1` and the LAN are full of services that assumed nobody outside could ask.
 * Neither needs a compromised daemon — a prompt is enough.
 *
 * Verified against our own code before this existed: `web_fetch` happily read a loopback service
 * and returned its body to the model.
 *
 * **DNS rebinding, closed in 0.7.9 (S12).** This file used to resolve and judge a name and then hand the URL to
 * `fetch`, which resolved it again — two answers, and a resolver answering with a TTL of 0 could give the check a
 * public address and the connection a private one. Now the check's answer is what is connected to: `fetchJudged`
 * reaches one of the addresses `checkUrl` judged, through `fetchAt`, which keeps the host's name in the `Host` header,
 * the TLS server name and the certificate check. It was written off as something Bun's `fetch` could not do; it can.
 */


/**
 * Hostnames that are never a legitimate target, blocked even when private addresses are allowed.
 *
 * A cloud metadata service exists to hand credentials to the instance. There is no configuration
 * in which an agent fetching it is what the operator meant.
 */
const ALWAYS_BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/**
 * Metadata addresses, blocked regardless of the private-address setting.
 *
 * Held in one spelling per address — see `canonicalAddress` — because `::ffff:a9fe:a9fe` is
 * `169.254.169.254` and a set of strings would have called it a different key.
 */
const ALWAYS_BLOCKED_IPS = new Set(
  [
    "169.254.169.254", // AWS, GCP, Azure, DigitalOcean, Oracle
    "169.254.170.2", // AWS ECS task metadata — serves task IAM credentials
    "169.254.169.253", // Azure IMDS wire server
    "fd00:ec2::254", // AWS IPv6 metadata
  ].map(canonicalAddress),
);

export type AddressClass = "public" | "loopback" | "private" | "link-local" | "special";

/**
 * Classify an IP literal without a dependency.
 *
 * Pure and exported so the ranges can be tested directly — the ranges are the whole security
 * property, and a subtle mistake in one of them is invisible from the outside.
 */
export function classifyAddress(address: string): AddressClass {
  const version = isIP(address);
  if (version === 4) return classifyIPv4(address);
  if (version === 6) return classifyIPv6(address);
  return "special";
}

function classifyIPv4(address: string): AddressClass {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return "special";
  const [a = 0, b = 0] = parts;

  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local";
  // Carrier-grade NAT and the benchmarking range: not routable to us, and both show up inside
  // consumer routers and corporate networks.
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "private";
  if (a === 0 || a >= 224) return "special";
  return "public";
}

/**
 * By the numbers, never by the spelling.
 *
 * The version this replaced matched text: `::ffff:` followed by a dotted quad. That is the spelling a
 * person writes, and not the one a request arrives in — WHATWG `URL` serialises
 * `http://[::ffff:127.0.0.1]/` with the hostname `[::ffff:7f00:1]`, and `[::ffff:169.254.169.254]` as
 * `[::ffff:a9fe:a9fe]`. Both classified `public`, so the loopback and metadata rules were one bracket
 * away from not applying (checked with `bun -e`, 2026-10-15).
 */
function classifyIPv6(address: string): AddressClass {
  const groups = ipv6Groups(address);
  if (!groups) return "special";
  const [first = 0, second = 0, third = 0] = groups;

  // `::1`, and `::` — which, connected to, reaches a listener on this host.
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) <= 1) return "loopback";

  // Every range whose purpose is to carry an IPv4 address inherits that address's verdict. Otherwise
  // each rule in `classifyIPv4` is walked around by writing the same host in a v6 shape.
  const carried = embeddedIPv4(groups);
  if (carried) return classifyIPv4(carried);

  if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10, not only the `fe80:` spelling
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 — unique local
  if ((first & 0xffc0) === 0xfec0) return "private"; // fec0::/10 — site-local: deprecated, still routed inside some sites
  // 64:ff9b:1::/48 — NAT64 for local use (RFC 8215). Where the IPv4 sits inside it depends on a prefix
  // length only the operator knows, and by definition the translator is inside their network.
  if (first === 0x64 && second === 0xff9b && third === 1) return "private";
  if ((first & 0xff00) === 0xff00) return "special"; // multicast
  return "public";
}

/**
 * An IPv6 literal as its eight 16-bit groups, or null when it is not one.
 *
 * Parsed rather than matched, because one address has many spellings and only the numbers are the
 * address: `::`, a trailing dotted quad, leading zeros and case all change the text and none of them
 * change where a connection goes.
 */
function ipv6Groups(address: string): number[] | null {
  // A zone id names the interface to send from, not the destination.
  let text = address.toLowerCase().replace(/%.*$/, "");

  const tail: number[] = [];
  const dotted = /(?:^|:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    text = text.slice(0, text.length - (dotted[0].length - (dotted[0].startsWith(":") ? 1 : 0)));
    // `::ffff:1.2.3.4` leaves `::ffff:`; the colon was the separator, not a group of its own.
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const rest = parse(halves[1] ?? "");
  if (!head || !rest) return null;

  const written = head.length + rest.length + tail.length;
  if (halves.length === 1) return written === 8 ? [...head, ...tail] : null;
  // `::` stands for at least one group of zeros.
  if (written > 7) return null;
  return [...head, ...new Array<number>(8 - written).fill(0), ...rest, ...tail];
}

/**
 * The IPv4 address an IPv6 one carries, for the ranges that exist to carry one — or null.
 *
 * Each of these reaches an IPv4 host when it is connected to, so each is judged as that host.
 */
function embeddedIPv4(groups: readonly number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  const zero = (...values: (number | undefined)[]) => values.every((value) => value === 0);

  let carried: [number, number] | null = null;
  // ::ffff:0:0/96 — IPv4-mapped. The shape `URL` gives `[::ffff:127.0.0.1]`.
  if (zero(g0, g1, g2, g3, g4) && g5 === 0xffff) carried = [g6, g7];
  // ::ffff:0:0:0/96 — IPv4-translated (SIIT).
  else if (zero(g0, g1, g2, g3, g5) && g4 === 0xffff) carried = [g6, g7];
  // ::/96 — IPv4-compatible. Deprecated, and still a spelling: `[::127.0.0.1]` becomes `[::7f00:1]`.
  // `::` and `::1` are not in it; they are this host, and the caller has already said so.
  else if (zero(g0, g1, g2, g3, g4, g5) && !(g6 === 0 && g7 <= 1)) carried = [g6, g7];
  // 64:ff9b::/96 — NAT64's well-known prefix: behind a translator, this *is* that IPv4 host.
  else if (g0 === 0x64 && g1 === 0xff9b && zero(g2, g3, g4, g5)) carried = [g6, g7];
  // 2002::/16 — 6to4, the IPv4 address in the second and third groups.
  else if (g0 === 0x2002) carried = [g1 ?? 0, g2 ?? 0];

  if (!carried) return null;
  const [high, low] = carried;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * One spelling per address, so a set lookup cannot be walked around by writing an address another way.
 *
 * An address that carries an IPv4 one is that IPv4 address; any other IPv6 address is its eight groups
 * in plain hex. IPv4 already arrives in one spelling: `new URL` and the resolver both normalise it.
 */
function canonicalAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address.toLowerCase();
  return embeddedIPv4(groups) ?? groups.map((group) => group.toString(16)).join(":");
}

export interface UrlPolicy {
  /**
   * Permit private, loopback and CGNAT addresses.
   *
   * For networks where DNS resolves legitimate names into private ranges — a home router, a
   * corporate proxy, a VPN. Metadata addresses stay blocked either way.
   */
  allowPrivate: boolean;
}

export interface UrlVerdict {
  allowed: boolean;
  /** Present when refused — safe to show the model so it can adapt. */
  reason?: string;
  /** The addresses the hostname resolved to: what the fetch connects to (`fetchJudged`), and the audit trail's. */
  addresses?: string[];
}

/**
 * How a URL that `checkUrl` allowed is fetched: from the addresses it judged. `fetchJudged` in the daemon; a test's
 * double through `judgedFetch`, which has no connection to pin.
 */
export type JudgedFetch = (url: string, init: RequestInit, addresses: readonly string[]) => Promise<Response>;

/** The daemon's fetch, or a test's double — which answers for the network as a whole and is handed no addresses. */
export function judgedFetch(double?: typeof fetch): JudgedFetch {
  return double ? (url, init) => double(url, init) : fetchJudged;
}

/**
 * Fetch a URL from one of the addresses its check judged — never from a second lookup of its name (S12).
 *
 * In the order the resolver gave them, as a connection by name would try them; the next only for a read, so a POST
 * that may have reached a server is never sent to a second one. No address means nothing was judged, and nothing is
 * fetched: a check that allowed a URL without saying where it goes is not one to connect on.
 */
async function fetchJudged(url: string, init: RequestInit, addresses: readonly string[]): Promise<Response> {
  if (addresses.length === 0) throw new Error(`no checked address to connect to for ${new URL(url).host}`);
  const retries = init.method === undefined || init.method === "GET" || init.method === "HEAD";
  let failure: unknown;
  for (const address of retries ? addresses : addresses.slice(0, 1)) {
    try {
      return await fetchAt(url, address, init);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      failure = err;
    }
  }
  throw failure;
}

/**
 * Decide whether one URL may be fetched.
 *
 * Called for the initial URL *and* for every redirect hop, because a redirect is the obvious way
 * to turn an allowed public URL into an internal one. `resolve` is the system's resolver; a test of what a failed lookup
 * does gives its own, as a real lookup of a name that does not exist took over five seconds on CI's runner (0.8.13).
 */
export async function checkUrl(raw: string, policy: UrlPolicy, resolve: (host: string) => Promise<string[]> = resolveHostAddresses): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: `not a valid URL: ${raw}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // `file:` and `data:` would turn a web tool into an arbitrary-read tool that bypasses the
    // workspace sandbox entirely.
    return { allowed: false, reason: `only http and https are allowed, got ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");

  if (ALWAYS_BLOCKED_HOSTS.has(host)) {
    return { allowed: false, reason: `${host} is a cloud metadata endpoint` };
  }
  // `.internal` and `.local` are not public names; whatever answers them is on this network.
  if (host.endsWith(".internal") || host.endsWith(".local") || host === "localhost") {
    if (host !== "localhost") {
      return { allowed: false, reason: `${host} is an internal name` };
    }
    if (!policy.allowPrivate) {
      // Named, not generic. `127.0.0.1` already came back with the setting to change, and `localhost`
      // is the spelling an agent reaches for when it wants to check a service it just started — so
      // this was the one refusal that told the model a door was shut without saying it has a key.
      return {
        allowed: false,
        reason: `localhost is an internal name: set [security.web] allow_private_urls to permit it`,
      };
    }
  }

  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) {
    // Refuse rather than hand it to fetch and hope: an unresolvable name cannot be validated,
    // and "fail open on error" is how guards stop guarding.
    return { allowed: false, reason: `could not resolve ${host}` };
  }

  for (const address of addresses) {
    if (ALWAYS_BLOCKED_IPS.has(canonicalAddress(address))) {
      return { allowed: false, reason: `${address} is a cloud metadata address`, addresses };
    }

    const kind = classifyAddress(address);
    if (kind === "public") continue;
    // Link-local and "special" are refused even with allowPrivate: the escape hatch exists for
    // networks that legitimately use private ranges, not for 169.254 or multicast.
    if (kind === "link-local" || kind === "special") {
      return { allowed: false, reason: `${address} is ${kind}`, addresses };
    }
    if (!policy.allowPrivate) {
      return {
        allowed: false,
        reason: `${address} is ${kind}: set [security.web] allow_private_urls to permit it`,
        addresses,
      };
    }
  }

  return { allowed: true, addresses };
}
