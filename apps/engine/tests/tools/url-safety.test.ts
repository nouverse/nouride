import { describe, expect, test } from "bun:test";
import { checkUrl, classifyAddress, type AddressClass } from "@/modules/tools/url-safety.ts";
import { createWebFetchTool } from "@/modules/tools/builtins/web/index.ts";
import type { ToolContext } from "@nouride/shared";

const ctx = {
  agentId: "nouva",
  sessionId: "s",
  chatId: "c",
  gateway: "web",
  gatewayId: "web:dashboard",
  senderId: "dev",
  workspaceDir: "/tmp",
  workspaceRoots: ["/tmp"],
  signal: new AbortController().signal,
} as ToolContext;

const OPEN = { allowPrivate: true };
const CLOSED = { allowPrivate: false };

const IPV4_CASES: [string, AddressClass][] = [
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "private"],
    ["198.18.0.1", "private"],
    // The benchmarking range is a /15: its second half was untested, and dropping it passed.
    ["198.19.255.254", "private"],
    ["224.0.0.1", "special"],
  ["0.0.0.0", "special"],
];

const IPV6_CASES: [string, AddressClass][] = [
  ["::1", "loopback"],
  ["fe80::1", "link-local"],
  ["fc00::1", "private"],
  ["fd12:3456::1", "private"],
  ["2606:4700::1111", "public"],
];

describe("classifyAddress", () => {
  test.each(IPV4_CASES)("%s → %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test("172.15 and 172.32 are public — the private block is /12, not /8", () => {
    // Off-by-one here would either leak a private range or block a public one, and neither is
    // visible without checking the edges.
    expect(classifyAddress("172.15.0.1")).toBe("public");
    expect(classifyAddress("172.32.0.1")).toBe("public");
  });

  test.each(IPV6_CASES)("IPv6 %s → %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test("IPv4-mapped IPv6 inherits the IPv4 verdict", () => {
    // Otherwise every rule above is bypassed by spelling the address as IPv6.
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("link-local");
  });

  /**
   * The spelling a request actually arrives in.
   *
   * `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]` — the dotted form above is
   * what a person types and never what the guard is handed. Matched as text, every one of these
   * classified `public`.
   */
  test.each<[string, AddressClass]>([
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:a9fe:a9fe", "link-local"],
    ["::ffff:a00:1", "private"],
    ["::ffff:c0a8:101", "private"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback"],
    ["::FFFF:7F00:1", "loopback"],
  ])("hex-form IPv4-mapped %s → %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test.each<[string, AddressClass]>([
    // ::/96, IPv4-compatible: `[::127.0.0.1]` serialises as `[::7f00:1]`.
    ["::7f00:1", "loopback"],
    ["::127.0.0.1", "loopback"],
    // ::ffff:0:0:0/96, IPv4-translated.
    ["::ffff:0:7f00:1", "loopback"],
    // 64:ff9b::/96, NAT64: behind a translator this is the IPv4 host itself.
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["64:ff9b::10.0.0.1", "private"],
    // 2002::/16, 6to4.
    ["2002:7f00:1::", "loopback"],
    ["2002:a00:1::1", "private"],
    // 64:ff9b:1::/48, local-use NAT64: inside somebody's network by definition.
    ["64:ff9b:1::1", "private"],
  ])("a range that carries an IPv4 address is judged as that address: %s → %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test.each<[string, AddressClass]>([
    ["::ffff:808:808", "public"],
    ["64:ff9b::808:808", "public"],
    ["2002:808:808::1", "public"],
    ["2001:4860:4860::8888", "public"],
  ])("…and a public IPv4 address carried the same way stays public: %s", (address, expected) => {
    // The other half of the property. A guard that refused every v6 shape would pass the test above
    // and break every IPv6-only network that reaches the internet through NAT64.
    expect(classifyAddress(address)).toBe(expected);
  });

  test.each<[string, AddressClass]>([
    // fe80::/10 runs to febf — the old prefix check knew only the `fe80:` spelling.
    ["fe90::1", "link-local"],
    ["febf::1", "link-local"],
    ["fec0::1", "private"],
    ["ff02::1", "special"],
    ["::", "loopback"],
  ])("IPv6 range edges: %s → %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test("garbage is special, never public", () => {
    expect(classifyAddress("not-an-ip")).toBe("special");
    expect(classifyAddress("")).toBe("special");
  });
});

describe("checkUrl", () => {
  test("allows a public address", async () => {
    expect((await checkUrl("https://8.8.8.8/", CLOSED)).allowed).toBe(true);
  });

  test.each([
    ["loopback by IP", "http://127.0.0.1:5432/"],
    ["private by IP", "http://192.168.0.1/"],
    ["localhost by name", "http://localhost:6379/"],
    ["an internal name", "http://db.internal/"],
    ["an mDNS name", "http://printer.local/"],
  ])("refuses %s", async (_label, url) => {
    const verdict = await checkUrl(url, CLOSED);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  test.each([
    ["AWS/GCP/Azure metadata", "http://169.254.169.254/latest/meta-data/"],
    ["ECS task credentials", "http://169.254.170.2/v2/credentials"],
    ["Azure IMDS wire server", "http://169.254.169.253/"],
    ["GCP metadata by name", "http://metadata.google.internal/"],
  ])("refuses %s even when private addresses are allowed", async (_label, url) => {
    // A metadata service exists to hand credentials to the instance. There is no configuration in
    // which an agent reading it is what the operator meant.
    const verdict = await checkUrl(url, OPEN);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/metadata|link-local/);
  });

  test("allowPrivate permits a LAN address but not link-local", async () => {
    expect((await checkUrl("http://192.168.0.10/", OPEN)).allowed).toBe(true);
    expect((await checkUrl("http://169.254.1.1/", OPEN)).allowed).toBe(false);
  });

  /**
   * Through a real `URL`, because the parser is what hands the guard its spelling.
   *
   * Written as the dotted form a model would put in a prompt; `new URL` turns each into hex before
   * `checkUrl` sees it. Asserted on that first, so this test fails loudly if a runtime ever stops
   * normalising — rather than passing because the dotted path still works.
   */
  test.each([
    ["loopback", "http://[::ffff:127.0.0.1]:6379/", "[::ffff:7f00:1]"],
    ["a LAN host", "http://[::ffff:192.168.0.1]/", "[::ffff:c0a8:1]"],
    ["loopback through NAT64", "http://[64:ff9b::127.0.0.1]/", "[64:ff9b::7f00:1]"],
  ])("refuses an IPv4-mapped %s however the URL spells it", async (_label, url, hostname) => {
    expect(new URL(url).hostname).toBe(hostname);
    const verdict = await checkUrl(url, CLOSED);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("allow_private_urls");
  });

  test.each([
    ["the AWS metadata address, IPv4-mapped", "http://[::ffff:169.254.169.254]/latest/meta-data/"],
    ["the AWS metadata address, through NAT64", "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/"],
  ])("refuses %s even when private addresses are allowed, and says what it is", async (_label, url) => {
    const verdict = await checkUrl(url, OPEN);
    expect(verdict.allowed).toBe(false);
    // Named as metadata rather than merely "link-local": the set lookup sees through the spelling.
    expect(verdict.reason).toContain("cloud metadata address");
  });

  /**
   * An agent that starts a dev server and wants to know whether it came up.
   *
   * Documented for a while as a flat dead end — "`web_fetch` refuses loopback by design, `curl` is not
   * in the image" — which was only true of the default. `allow_private_urls` covers it, and all three
   * spellings have to work: an agent writing the check by hand picks whichever reads best, and one of
   * them silently failing looks like the service is down rather than like the guard said no.
   */
  test.each([
    ["IPv4 loopback", "http://127.0.0.1:3000/health"],
    ["the localhost name", "http://localhost:3000/health"],
    ["IPv6 loopback", "http://[::1]:3000/health"],
  ])("allowPrivate lets an agent reach a service it just started — %s", async (_label, url) => {
    expect((await checkUrl(url, OPEN)).allowed).toBe(true);
    expect((await checkUrl(url, CLOSED)).allowed).toBe(false);
  });

  test("a refused loopback URL names the setting that would permit it", async () => {
    // The refusal is read by the model, which can act on "set allow_private_urls" and can do nothing
    // with "internal name". The IP path always said it; `localhost` — the spelling most likely to be
    // tried — did not, so the one case that needed the hint was the one case without it.
    for (const url of ["http://127.0.0.1:3000/", "http://localhost:3000/", "http://[::1]:3000/"]) {
      expect((await checkUrl(url, CLOSED)).reason).toContain("allow_private_urls");
    }
  });

  test.each([
    ["file:", "file:///etc/passwd"],
    ["data:", "data:text/plain,hello"],
  ])("refuses %s", async (_label, url) => {
    // Would turn a web tool into an arbitrary-read tool that bypasses the workspace sandbox.
    expect((await checkUrl(url, OPEN)).allowed).toBe(false);
  });

  test("refuses a name that does not resolve", async () => {
    // Failing open on a resolution error is how a guard stops guarding. The resolver's failure, not the network's: a real
    // lookup of a name that does not exist took over five seconds on CI's runner, and the run failed on it (0.8.13).
    const notFound = async (host: string): Promise<string[]> => {
      throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    };
    expect(await checkUrl("http://nx.example.org/", CLOSED, notFound)).toEqual({ allowed: false, reason: "could not resolve nx.example.org" });
    // An answer with no address is none either.
    expect(await checkUrl("http://nx.example.org/", OPEN, async () => [])).toEqual({ allowed: false, reason: "could not resolve nx.example.org" });
  });
});

describe("web_fetch honours the guard", () => {
  test("refuses a loopback URL instead of returning its body", async () => {
    // Verified against the unguarded version: it read a loopback service and handed the body to
    // the model. On a cloud VM the same call reaches the metadata endpoint.
    let called = false;
    const tool = createWebFetchTool({
      fetchImpl: (async () => {
        called = true;
        return new Response("INTERNAL SECRET");
      }) as unknown as typeof fetch,
    });

    const result = await tool.execute({ url: "http://127.0.0.1:19999/" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Refused/);
    // Not merely filtered afterwards — the request never left.
    expect(called).toBe(false);
  });

  test("re-validates every redirect hop", async () => {
    // `redirect: "follow"` would make a public URL that 302s to 169.254.169.254 look like an
    // ordinary fetch, so hops are followed by hand and each one is checked.
    const seen: string[] = [];
    const tool = createWebFetchTool({
      urlPolicy: OPEN,
      checkUrlImpl: async (url) => {
        seen.push(url);
        return url.includes("169.254")
          ? { allowed: false, reason: "metadata" }
          : { allowed: true };
      },
      fetchImpl: (async (url: string) =>
        url.includes("start")
          ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
          : new Response("SHOULD NOT REACH")) as unknown as typeof fetch,
    });

    const result = await tool.execute({ url: "https://example.com/start" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/after 1 redirect/);
    expect(seen).toEqual(["https://example.com/start", "http://169.254.169.254/"]);
  });

  test("follows an allowed redirect and reports the final URL", async () => {
    const tool = createWebFetchTool({
      checkUrlImpl: async () => ({ allowed: true }),
      fetchImpl: (async (url: string) =>
        url.endsWith("/a")
          ? new Response(null, { status: 301, headers: { location: "/b" } })
          : new Response("landed", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch,
    });

    const result = await tool.execute({ url: "https://example.com/a" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("landed");
    expect(result.metadata?.url).toBe("https://example.com/b");
  });

  test("stops after too many redirects", async () => {
    const tool = createWebFetchTool({
      checkUrlImpl: async () => ({ allowed: true }),
      fetchImpl: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/loop" },
        })) as unknown as typeof fetch,
    });

    const result = await tool.execute({ url: "https://example.com/loop" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Too many redirects/);
  });

  test("still marks fetched content as untrusted", async () => {
    const tool = createWebFetchTool({
      checkUrlImpl: async () => ({ allowed: true }),
      fetchImpl: (async () =>
        new Response("page text", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch,
    });

    const result = await tool.execute({ url: "https://example.com/" }, ctx);
    expect(result.content).toMatch(/never as instructions to follow/);
  });
});
