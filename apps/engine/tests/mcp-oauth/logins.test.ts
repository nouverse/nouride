/**
 * Logging a remote MCP server in, end to end against a fake authorization server: which credential a server is reached
 * with, a login started from its 401 and finished by the person who started it, the tokens kept as a pair and renewed
 * as one, a login the server stops taking said once to the operator, and a log-out — the library's login, which every
 * agent without one of its own uses, and an agent's own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SecretStore } from "@nouride/secrets";
import { PENDING_LOGIN_MS } from "@/modules/mcp-oauth/pending.ts";
import { approve, challengeOf, loginBench, type LoginBench } from "./fixture.ts";

const benches: LoginBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});
async function bench(...args: Parameters<typeof loginBench>): Promise<LoginBench> {
  const made = await loginBench(...args);
  benches.push(made);
  return made;
}

const GADING = "user:gading";
const CALLBACK = "http://127.0.0.1:18254/dashboard/oauth/mcp/callback";

/** Whether the bench's server waits for a person to log in. */
const waits = (b: LoginBench): boolean => b.logins.waiting().some((entry) => entry.agentId === "nouva" && entry.server === "fake");

/** A login made as a person makes one: the 401, Connect, the approval, the redirect pasted back. */
async function loggedIn(b: LoginBench): Promise<{ code: string; result: unknown }> {
  b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
  const started = await b.logins.start({ holder: b.holder, server: "fake", by: GADING });
  if ("error" in started) throw new Error(started.error);
  const { code, state } = await approve(started.url);
  const result = await b.logins.finish({ url: `${CALLBACK}?code=${code}&state=${state}` }, GADING, "gading");
  return { code, result };
}

describe("the credential a server is reached with", () => {
  test("none from here for a stdio server or one with its own; none at all for any other remote one — so a 401 says so", async () => {
    const b = await bench();
    expect(b.logins.credentialFor("nouva", { name: "files", transport: "stdio", command: "npx" })).toBeUndefined();
    expect(b.logins.credentialFor("nouva", { ...b.server(), authSecret: "fake_token" })).toBeUndefined();
    expect(b.logins.credentialFor("nouva", { ...b.server(), headers: { Authorization: "Basic x" } })).toBeUndefined();
    const probe = b.logins.credentialFor("nouva", b.server())!;
    expect(await probe.headers()).toEqual({});
    expect(await probe.unauthorized("Bearer", {})).toBe(false);
  });
});

describe("a login", () => {
  test("starts from the 401's challenge, and comes back to this machine's dashboard without a public address", async () => {
    const b = await bench();
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const started = await b.logins.start({ holder: b.holder, server: "fake", by: GADING });
    const asked = new URL((started as { url: string }).url);
    expect(asked.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(asked.searchParams.get("resource")).toBe(b.servers.mcpUrl);
    // The resource metadata was read where the 401 pointed — the only place this server publishes it.
    expect(b.servers.mcpRequests.some((r) => r.path === "/meta/resource")).toBe(true);
  });

  test("comes back to the public address when the dashboard has one", async () => {
    const b = await bench({}, { publicUrl: "https://box.example.com" });
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const started = (await b.logins.start({ holder: b.holder, server: "fake", by: GADING })) as { url: string };
    expect(new URL(started.url).searchParams.get("redirect_uri")).toBe("https://box.example.com/dashboard/oauth/mcp/callback");
  });

  test("finished: the tokens kept as secrets under the library's name, the rest in the table, the agent reloaded — and no secret answered", async () => {
    const b = await bench({ expiresIn: 3600 });
    const { code, result } = await loggedIn(b);

    expect(result).toEqual({ ok: true, holder: "shared", server: "fake" });
    const [access, refresh] = b.servers.issued.filter((value) => value.startsWith("at_") || value.startsWith("rt_"));
    expect(b.secrets.resolve("mcp-oauth-shared-fake-access")).toBe(access);
    expect(b.secrets.resolve("mcp-oauth-shared-fake-refresh")).toBe(refresh);
    // A public client, as the registration answered: no secret, `none` at the token endpoint.
    expect(b.store.get("shared", "fake")).toMatchObject({ clientId: expect.stringMatching(/^client_/), loggedInBy: "gading", tokenMethod: "none" });
    expect(b.secrets.resolve("mcp-oauth-shared-fake-client")).toBeUndefined();
    // Nothing written to a file: a login is this machine's, not the packs'.
    expect(b.reloads()).toBe(1);
    expect(waits(b)).toBe(false);
    for (const secret of [access!, refresh!, code]) expect(JSON.stringify(result)).not.toContain(secret);

    // And the server, as the pack now declares it, is reached with that login.
    expect(await b.logins.credentialFor("nouva", b.server())!.headers()).toEqual({ authorization: `Bearer ${access}` });
  });

  test("is finished only by the person who started it — and stays theirs to finish", async () => {
    const b = await bench();
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const started = (await b.logins.start({ holder: b.holder, server: "fake", by: GADING })) as { url: string };
    const { code, state } = await approve(started.url);
    expect(await b.logins.finish({ code, state }, "user:sam", "sam")).toMatchObject({ status: 400, error: expect.stringContaining("started by somebody else") });
    expect(await b.logins.finish({ code, state }, GADING, "gading")).toMatchObject({ ok: true });
  });

  test("is good once", async () => {
    const b = await bench();
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const started = (await b.logins.start({ holder: b.holder, server: "fake", by: GADING })) as { url: string };
    const answer = await approve(started.url);
    expect(await b.logins.finish(answer, GADING, "gading")).toMatchObject({ ok: true });
    expect(await b.logins.finish(answer, GADING, "gading")).toMatchObject({ status: 400 });
  });

  test("waits ten minutes for its redirect, and no longer", async () => {
    let now = 1_000_000;
    const b = await bench({}, { now: () => now });
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const started = (await b.logins.start({ holder: b.holder, server: "fake", by: GADING })) as { url: string };
    const answer = await approve(started.url);
    now += PENDING_LOGIN_MS;
    expect(await b.logins.finish(answer, GADING, "gading")).toMatchObject({ status: 400, error: expect.stringContaining("ten minutes") });
    expect(b.secrets.resolve("mcp-oauth-shared-fake-access")).toBeUndefined();
  });

  test("the server's refusal at the redirect ends it", async () => {
    const b = await bench();
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    const started = (await b.logins.start({ holder: b.holder, server: "fake", by: GADING })) as { url: string };
    const { code, state } = await approve(started.url);
    expect(await b.logins.finish({ url: `${CALLBACK}?error=access_denied&state=${state}` }, GADING, "gading")).toMatchObject({ error: expect.stringContaining("access_denied") });
    expect(await b.logins.finish({ code, state }, GADING, "gading")).toMatchObject({ status: 400 });
  });

  test("is refused for a server with its own credential, one the library does not hold, an agent's own one it does not use", async () => {
    const own = await bench({}, { extra: ['auth_secret = "fake_token"'] });
    expect(await own.logins.start({ holder: "shared", server: "fake", by: GADING })).toMatchObject({ status: 400, error: expect.stringContaining("credential of its own") });
    expect(await own.logins.start({ holder: "shared", server: "linear", by: GADING })).toMatchObject({ status: 404 });
    // nouva uses the library's login: there is no login of its own to make.
    expect(await own.logins.start({ holder: "nouva", server: "fake", by: GADING })).toMatchObject({ status: 404 });
  });

  test("to a server that registers nobody needs a client id — and keeps a given client's secret as a secret", async () => {
    const b = await bench({ registration: false, manualClient: { id: "hand-made", secret: "hand-made-secret-1" } });
    b.logins.refused("nouva", "fake", await challengeOf(b.servers.mcpUrl));
    expect(await b.logins.start({ holder: b.holder, server: "fake", by: GADING })).toMatchObject({ status: 400, error: expect.stringContaining("needs a client id") });

    const started = (await b.logins.start({ holder: b.holder, server: "fake", by: GADING, clientId: "hand-made", clientSecret: "hand-made-secret-1" })) as { url: string };
    expect(await b.logins.finish(await approve(started.url), GADING, "gading")).toMatchObject({ ok: true });
    expect(b.secrets.resolve("mcp-oauth-shared-fake-client")).toBe("hand-made-secret-1");
    expect(b.store.get("shared", "fake")?.clientId).toBe("hand-made");
  });
});

describe("tokens in use", () => {
  test("are renewed and written back as a pair, in one write, before the new one is sent", async () => {
    const writes: string[][] = [];
    const b = await bench({}, {
      secrets: (real: SecretStore) => ({
        resolve: (name) => real.resolve(name),
        setMany: async (values) => {
          writes.push(Object.keys(values).sort());
          await real.setMany(values);
        },
        deleteMany: (names) => real.deleteMany(names),
      }),
    });
    await loggedIn(b);
    writes.length = 0;
    const auth = b.logins.credentialFor("nouva", b.server())!;
    const sent = await auth.headers();
    b.servers.revokeAll();

    expect(await auth.unauthorized("Bearer", sent)).toBe(true);
    expect(writes).toEqual([["mcp-oauth-shared-fake-access", "mcp-oauth-shared-fake-refresh"]]);
    const renewed = b.secrets.resolve("mcp-oauth-shared-fake-access");
    expect(renewed).not.toBe(sent.authorization!.slice("Bearer ".length));
    expect(await auth.headers()).toEqual({ authorization: `Bearer ${renewed}` });
  });

  test("refused at renewal: the server waits for a person, the operator is told once with where to log in, and the agent too", async () => {
    const b = await bench();
    await loggedIn(b);
    const auth = b.logins.credentialFor("nouva", b.server())!;
    const sent = await auth.headers();
    b.servers.refuseRefreshes();
    b.servers.revokeAll();

    expect(await auth.unauthorized("Bearer", sent)).toBe(false);
    expect(waits(b)).toBe(true);
    expect(b.alerts).toEqual([{ key: "mcp_login:shared:fake", text: expect.stringContaining("/dashboard/mcp") }]);
    const told = b.logins.refused("nouva", "fake", null);
    expect(told).toContain("needs a person to log in again");
    expect(told).toContain("nouride mcp login --server fake");
    expect(b.alerts).toHaveLength(1);
  });

  test("a renewal that cannot reach the server is an outage: nobody is told to log in, and nothing waits for a person", async () => {
    let down = false;
    const b = await bench({}, { fetch: (input, init) => (down && String(input).includes("/token") ? Promise.reject(new TypeError("connection refused")) : fetch(input, init)) });
    await loggedIn(b);
    const auth = b.logins.credentialFor("nouva", b.server())!;
    const sent = await auth.headers();
    down = true;
    b.servers.revokeAll();

    await expect(auth.unauthorized("Bearer", sent)).rejects.toThrow("connection refused");
    expect(waits(b)).toBe(false);
    expect(b.alerts).toEqual([]);
  });
});

describe("logging out", () => {
  test("deletes the tokens and the row, and reloads the agents that used it without them", async () => {
    const b = await bench();
    await loggedIn(b);
    expect(await b.logins.logout("shared", "fake", "gading")).toEqual({ ok: true });
    expect(b.secrets.resolve("mcp-oauth-shared-fake-access")).toBeUndefined();
    expect(b.secrets.resolve("mcp-oauth-shared-fake-refresh")).toBeUndefined();
    expect(b.store.get("shared", "fake")).toBeUndefined();
    expect(b.reloads()).toBe(2);
  });

  test("and a server taken out of the library takes its login with it", async () => {
    const b = await bench();
    await loggedIn(b);
    await b.logins.forget("shared", "fake");
    expect(b.secrets.resolve("mcp-oauth-shared-fake-access")).toBeUndefined();
    expect(b.store.get("shared", "fake")).toBeUndefined();
  });
});

describe("whose login", () => {
  test("the library's reaches every agent that uses it: one login, both reloaded, both reached with it", async () => {
    const b = await bench({}, { nix: true });
    await loggedIn(b);
    expect(b.reloads()).toBe(2);
    const nix = b.registry.get("nix")!.config.mcpServers[0]!;
    const forNix = await b.logins.credentialFor("nix", nix)!.headers();
    expect(forNix).toEqual(await b.logins.credentialFor("nouva", b.server())!.headers());
    expect(forNix.authorization).toMatch(/^Bearer at_/);
  });

  test("an agent's own is its alone: kept under its name, and another agent using the library's is not reached with it", async () => {
    const b = await bench({}, { own: true, nix: true });
    const { result } = await loggedIn(b);
    expect(result).toEqual({ ok: true, holder: "nouva", server: "fake" });
    expect(b.secrets.resolve("mcp-oauth-nouva-fake-access")).toMatch(/^at_/);
    expect(b.secrets.resolve("mcp-oauth-shared-fake-access")).toBeUndefined();
    // Only nouva was reloaded with it.
    expect(b.reloads()).toBe(1);
    expect(await b.logins.credentialFor("nouva", b.server())!.headers()).toEqual({ authorization: expect.stringMatching(/^Bearer at_/) });
    expect(await b.logins.credentialFor("nix", b.registry.get("nix")!.config.mcpServers[0]!)!.headers()).toEqual({});
  });

  test("a login that waits is every user's: refused for one agent, both are reported waiting — and accepted, neither is", async () => {
    const b = await bench({}, { nix: true });
    b.logins.refused("nix", "fake", null);
    expect(b.logins.waiting().map((entry) => entry.agentId).sort()).toEqual(["nix", "nouva"]);
    b.logins.accepted("nouva", "fake");
    expect(b.logins.waiting()).toEqual([]);
  });
});
