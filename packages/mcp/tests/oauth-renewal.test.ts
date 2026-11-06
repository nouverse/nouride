/**
 * A login in use: the token sent, renewed ahead of its expiry and on a 401, handed back to be stored, refused for good,
 * and shared by requests made at once — through a real transport to a server that holds the token to what it issued.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  McpAuthRequiredError,
  McpClient,
  McpError,
  OAuthError,
  oauthAuth,
  refreshTokens,
  streamableHttpTransport,
  type McpAuth,
  type OAuthTokens,
} from "../src/index.ts";
import { loggedIn } from "./fixtures/logged-in.ts";
import type { OAuthScript } from "./fixtures/oauth-servers.ts";
import { eventually } from "./wait.ts";

let clock = 1_000_000;
const now = () => clock;
const HOUR_S = 3600;

const running: { stop(): Promise<unknown> }[] = [];
const clients: McpClient[] = [];
afterEach(async () => {
  clock = 1_000_000;
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((servers) => servers.stop()));
});

async function login(script: OAuthScript = {}) {
  const login = await loggedIn(script, now);
  running.push(login.servers);
  return login;
}

async function connected(l: Awaited<ReturnType<typeof loggedIn>>, auth: McpAuth): Promise<McpClient> {
  const client = new McpClient({ name: "remote", transport: streamableHttpTransport({ url: l.servers.mcpUrl, auth }), timeoutMs: 5_000 });
  clients.push(client);
  await client.connect();
  await eventually(() => l.servers.initialized(), 4_000, "the initialized notification to reach the server");
  return client;
}

/** The POSTs that carried `tools/call`, with the token each was sent. */
const calls = (login: Awaited<ReturnType<typeof loggedIn>>) =>
  login.servers.mcpRequests.filter((r) => r.method === "POST" && r.body?.includes('"tools/call"')).map((r) => r.headers.authorization);

describe("ahead of its expiry", () => {
  test("the token is renewed a minute before it expires — once — stored, and sent", async () => {
    const l = await login({ expiresIn: HOUR_S });
    const remote = await connected(l, l.auth());
    expect(l.servers.refreshes()).toBe(0);

    clock = l.tokens.expiresAt! - 30_000;
    expect((await remote.callTool("echo", { text: "late" })).text).toBe("late");
    expect((await remote.callTool("echo", { text: "later" })).text).toBe("later");

    expect(l.servers.refreshes()).toBe(1);
    expect(l.stored).toHaveLength(1);
    expect(l.stored[0]!.expiresAt).toBe(clock + HOUR_S * 1000);
    expect(calls(l)).toEqual([`Bearer ${l.stored[0]!.accessToken}`, `Bearer ${l.stored[0]!.accessToken}`]);
    // The refresh named the resource and the client, and spent the refresh token the login came with.
    expect(l.servers.tokenForms().at(-1)).toEqual({ grant_type: "refresh_token", refresh_token: l.tokens.refreshToken!, resource: l.servers.mcpUrl, client_id: l.client.clientId });
  });

  test("a token far from its expiry, or with none said, is not renewed", async () => {
    const l = await login({ expiresIn: HOUR_S });
    const remote = await connected(l, l.auth());
    clock = l.tokens.expiresAt! - 61_000;
    await remote.callTool("echo", { text: "still fresh" });
    expect(l.servers.refreshes()).toBe(0);

    const unsaid = await login();
    const quiet = await connected(unsaid, unsaid.auth());
    clock += 365 * 24 * HOUR_S * 1000;
    await quiet.callTool("echo", { text: "no expiry said" });
    expect(unsaid.servers.refreshes()).toBe(0);
  });
});

describe("on a 401", () => {
  test("the login is renewed once, and the request sent again with the new token", async () => {
    const l = await login();
    const remote = await connected(l, l.auth());
    l.servers.revokeAll();

    expect((await remote.callTool("echo", { text: "again" })).text).toBe("again");

    expect(l.servers.refreshes()).toBe(1);
    expect(l.stored.map((t) => t.accessToken)).toHaveLength(1);
    expect(calls(l)).toEqual([`Bearer ${l.tokens.accessToken}`, `Bearer ${l.stored[0]!.accessToken}`]);
  });

  test("a refresh the server refuses fails the call as a login needed — and later 401s ask nothing more of it", async () => {
    const l = await login({ refusesRefresh: true });
    const remote = await connected(l, l.auth());
    l.servers.revokeAll();

    const first = await remote.callTool("echo", { text: "x" }).catch((err: unknown) => err);
    expect(first).toBeInstanceOf(McpAuthRequiredError);
    expect((first as McpAuthRequiredError).challenge).toContain(`resource_metadata="${l.servers.mcpOrigin}/meta/resource"`);
    expect((first as McpAuthRequiredError).server).toBe("remote");
    expect(l.servers.refreshes()).toBe(1);

    await expect(remote.callTool("echo", { text: "y" })).rejects.toBeInstanceOf(McpAuthRequiredError);
    expect(l.servers.refreshes()).toBe(1);
    expect(l.stored).toEqual([]);
  });

  test("a login with no refresh token is a login needed at once, with nothing asked of the server", async () => {
    const l = await login();
    const { refreshToken: _dropped, ...withoutRefresh } = l.tokens;
    const remote = await connected(l, l.auth({ tokens: withoutRefresh }));
    l.servers.revokeAll();

    await expect(remote.callTool("echo", { text: "x" })).rejects.toBeInstanceOf(McpAuthRequiredError);
    expect(l.servers.refreshes()).toBe(0);
  });

  test("a renewal that fails any other way fails the call with why — not as a lost login — and the next 401 tries again", async () => {
    const l = await login();
    let outage = true;
    const remote = await connected(
      l,
      l.auth({ refresh: (current) => (outage ? Promise.reject(new OAuthError("could not reach the token endpoint at https://auth.example/token: connection refused")) : refreshTokens(l.discovery, l.client, current, { now })) }),
    );
    l.servers.revokeAll();

    const failed = await remote.callTool("echo", { text: "x" }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(McpError);
    expect(failed).not.toBeInstanceOf(McpAuthRequiredError);
    expect(String(failed)).toContain("could not reach the token endpoint");

    outage = false;
    expect((await remote.callTool("echo", { text: "back" })).text).toBe("back");
    expect(l.stored).toHaveLength(1);
  });
});

describe("requests made at once", () => {
  test("share one renewal on a 401, and every one of them succeeds", async () => {
    const l = await login();
    // Every call has met its 401 and asked before the renewal answers: each one of them could have started its own.
    let asked = 0;
    const inner = l.auth();
    const counted: McpAuth = { headers: () => inner.headers(), unauthorized: (challenge, sent) => ((asked += 1), inner.unauthorized(challenge, sent)) };
    const remote = await connected(l, counted);
    l.servers.revokeAll();
    const release = l.servers.holdRefreshes();

    const answers = Promise.all([1, 2, 3, 4, 5].map((n) => remote.callTool("echo", { text: `call ${n}` })));
    await eventually(() => asked === 5, 4_000, "every call to meet its 401");
    release();

    expect((await answers).map((a) => a.text)).toEqual(["call 1", "call 2", "call 3", "call 4", "call 5"]);
    expect(l.servers.refreshes()).toBe(1);
    expect(l.stored).toHaveLength(1);
  });

  test("a request made while a renewal runs waits for it, and goes out with the new token rather than to be refused", async () => {
    const l = await login();
    const remote = await connected(l, l.auth());
    l.servers.revokeAll();
    const release = l.servers.holdRefreshes();

    const first = remote.callTool("echo", { text: "met the 401" });
    await eventually(() => l.servers.refreshes() === 1, 4_000, "the renewal to reach the server");
    const second = remote.callTool("echo", { text: "made meanwhile" });
    release();
    await Promise.all([first, second]);

    const renewed = `Bearer ${l.stored[0]!.accessToken}`;
    expect(calls(l)).toEqual([`Bearer ${l.tokens.accessToken}`, renewed, renewed]);
  });

  test("share one renewal ahead of expiry, and none of them is refused first", async () => {
    // Made in one go, each asks for its headers before the first renewal can have answered: no hold is needed.
    const l = await login({ expiresIn: HOUR_S });
    const remote = await connected(l, l.auth());
    clock = l.tokens.expiresAt! + 1;

    await Promise.all([1, 2, 3, 4, 5].map((n) => remote.callTool("echo", { text: `call ${n}` })));

    expect(l.servers.refreshes()).toBe(1);
    expect(calls(l)).toEqual(Array(5).fill(`Bearer ${l.stored[0]!.accessToken}`));
  });
});

describe("the decision a 401 asks for", () => {
  /** An `oauthAuth` over a token endpoint that counts its renewals and hands out t1, t2 … */
  function counting(tokens: OAuthTokens) {
    let renewals = 0;
    const auth = oauthAuth({
      tokens,
      refresh: async () => ({ accessToken: `t${(renewals += 1) + 1}-access-token`, tokenType: "Bearer", refreshToken: `r${renewals + 1}-refresh-token` }),
      now,
    });
    return { auth, renewals: () => renewals };
  }
  const t1 = { accessToken: "t1-access-token", tokenType: "Bearer", refreshToken: "r1-refresh-token" };

  test("a 401 for a token already replaced is answered by retrying with the replacement, not by renewing again", async () => {
    const c = counting(t1);
    expect(await c.auth.unauthorized(null, { authorization: "Bearer t1-access-token" })).toBe(true);
    expect(c.renewals()).toBe(1);
    expect(await c.auth.headers()).toEqual({ authorization: "Bearer t2-access-token" });

    // Another request sent with t1 meanwhile: t2 has not been refused yet, so it is tried.
    expect(await c.auth.unauthorized(null, { authorization: "Bearer t1-access-token" })).toBe(true);
    expect(c.renewals()).toBe(1);
    // t2 itself refused: that is a 401 for the token in use, and it is renewed.
    expect(await c.auth.unauthorized(null, { authorization: "Bearer t2-access-token" })).toBe(true);
    expect(c.renewals()).toBe(2);
  });

  test("a login with no refresh token is never handed to refresh — not on a 401, not at its expiry", async () => {
    // A `refresh` that would answer: only oauthAuth's own rule keeps it from being asked to renew what cannot be renewed.
    let asked = 0;
    const auth = oauthAuth({
      tokens: { accessToken: "t1-access-token", tokenType: "Bearer", expiresAt: clock - 1 },
      refresh: async () => ((asked += 1), { accessToken: "t2-access-token", tokenType: "Bearer" }),
      now,
    });
    expect(await auth.headers()).toEqual({ authorization: "Bearer t1-access-token" });
    expect(await auth.unauthorized(null, { authorization: "Bearer t1-access-token" })).toBe(false);
    expect(asked).toBe(0);
  });

  test("a renewed set is stored before it is sent: the token is not handed out while onTokens is still writing", async () => {
    let release: () => void = () => {};
    const writing = new Promise<void>((resolve) => (release = resolve));
    const stored: OAuthTokens[] = [];
    const auth = oauthAuth({
      tokens: { ...t1, expiresAt: clock - 1 },
      refresh: async () => ({ accessToken: "t2-access-token", tokenType: "Bearer", refreshToken: "r2-refresh-token" }),
      onTokens: async (next) => {
        stored.push(next);
        await writing;
      },
      now,
    });
    let handed: Record<string, string> | undefined;
    const asked = auth.headers().then((headers) => (handed = headers));
    // Every step of the renewal is a promise settling, not I/O: once these have run, all of it that could has.
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();

    expect(stored.map((t) => t.accessToken)).toEqual(["t2-access-token"]);
    expect(handed).toBeUndefined();
    release();
    await asked;
    expect(handed).toEqual({ authorization: "Bearer t2-access-token" });
  });

  test("a store that throws is said, and the renewed tokens are used all the same", async () => {
    const auth = oauthAuth({
      tokens: t1,
      refresh: async () => ({ accessToken: "t2-access-token", tokenType: "Bearer" }),
      onTokens: () => Promise.reject(new Error("the disk is full")),
      now,
    });
    expect(await auth.unauthorized(null, { authorization: "Bearer t1-access-token" })).toBe(true);
    expect(await auth.headers()).toEqual({ authorization: "Bearer t2-access-token" });
  });
});
