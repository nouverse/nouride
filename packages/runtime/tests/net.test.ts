/**
 * `fetchAt` connects to the address it is given and goes on naming the host everywhere else (S12).
 *
 * Every test here uses a name that cannot resolve — `.invalid` never does (RFC 6761) — so a fetch that looked the name
 * up again would fail, and one that reached the server can only have gone to the address. The TLS half checks the
 * other side of that: the certificate is held to the host's name, not to the address, so an address that is not the
 * host's cannot pass as it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAt } from "../src/index.ts";

const NAME = "pinned.invalid";

describe("over http", () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/away"
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
        : Response.json({ host: req.headers.get("host"), path: new URL(req.url).pathname }),
  });
  afterAll(() => server.stop(true));

  test("reaches the address, with the host's name in the Host header and the path untouched", async () => {
    const res = await fetchAt(`http://${NAME}:${server.port}/page?x=1`, "127.0.0.1");
    expect(await res.json()).toEqual({ host: `${NAME}:${server.port}`, path: "/page" });
  });

  test("never follows a redirect — the next hop is another name, for the caller to check", async () => {
    const res = await fetchAt(`http://${NAME}:${server.port}/away`, "127.0.0.1", { redirect: "follow" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://169.254.169.254/");
  });
});

/**
 * Addresses as the URL's own host, and IPv6 either side — what the 0.7.11 mutation sweep found no test reaching. A URL
 * whose host is already an address is fetched as it is, whatever address it is handed: `192.0.2.1` is TEST-NET and
 * answers nobody, so a fetch that went there instead would time out.
 */
describe("addresses", () => {
  const v6 = (() => {
    try {
      const probe = Bun.serve({ port: 0, hostname: "::1", fetch: () => new Response("") });
      probe.stop(true);
      return true;
    } catch {
      return false;
    }
  })();
  const answer = (req: Request) => Response.json({ host: req.headers.get("host") });
  const v4 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer });
  const six = v6 ? Bun.serve({ port: 0, hostname: "::1", fetch: answer }) : null;
  afterAll(() => {
    v4.stop(true);
    six?.stop(true);
  });
  const soon = () => ({ signal: AbortSignal.timeout(3_000) });

  test("a URL whose host is an IPv4 address is fetched there, not at the address handed in", async () => {
    const res = await fetchAt(`http://127.0.0.1:${v4.port}/`, "192.0.2.1", soon());
    expect(await res.json()).toEqual({ host: `127.0.0.1:${v4.port}` });
  });

  test.skipIf(!v6)("so is one whose host is a bracketed IPv6 address", async () => {
    const res = await fetchAt(`http://[::1]:${six!.port}/`, "192.0.2.1", soon());
    expect(await res.json()).toEqual({ host: `[::1]:${six!.port}` });
  });

  test.skipIf(!v6)("a name pinned to an IPv6 address connects to it in brackets, and keeps naming the host", async () => {
    const res = await fetchAt(`http://${NAME}:${six!.port}/`, "::1", soon());
    expect(await res.json()).toEqual({ host: `${NAME}:${six!.port}` });
  });
});

/** A CA and a certificate signed by it, for whatever name the test asks — made with `openssl`, kept nowhere. */
function certificateFor(dir: string, name: string): { cert: string; key: string } {
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=DNS:${name}\n`);
  run("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", `${name}.ext`);
  return { cert: readFileSync(join(dir, `${name}.crt`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8") };
}

describe("over https", () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-fetch-at-"));
  let ca = "";
  let theirs: ReturnType<typeof Bun.serve>;
  let impostor: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=nouride test CA"], { cwd: dir, stdio: "ignore" });
    ca = readFileSync(join(dir, "ca.crt"), "utf8");
    const fetch = (req: Request) => Response.json({ host: req.headers.get("host") });
    theirs = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: certificateFor(dir, NAME), fetch });
    // Another site at an address of its own, with a good certificate — for a different name.
    impostor = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: certificateFor(dir, "elsewhere.invalid"), fetch });
  });
  afterAll(() => {
    theirs.stop(true);
    impostor.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("presents the host's name to the server and checks the certificate against it", async () => {
    const res = await fetchAt(`https://${NAME}:${theirs.port}/`, "127.0.0.1", { tls: { ca } });
    expect(await res.json()).toEqual({ host: `${NAME}:${theirs.port}` });
  });

  test("an address whose certificate is for another name is refused, not trusted for being the address asked for", async () => {
    await expect(fetchAt(`https://${NAME}:${impostor.port}/`, "127.0.0.1", { tls: { ca } })).rejects.toThrow(/altnames|ALTNAME/);
  });
});
