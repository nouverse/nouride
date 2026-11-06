/**
 * The connections and the logins together, against a server behind the fake authorization server: a remote server with
 * no credential is reported as waiting for a login rather than as failed; logged in, it connects and its tools are
 * offered; a login lost at a call is said to the agent and, once, to the operator; an outage stays an outage.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { McpManager } from "@/modules/tools/mcp.ts";
import { fakeAgent } from "../helpers.ts";
import { approve, challengeOf, loginBench, type LoginBench } from "./fixture.ts";

const benches: LoginBench[] = [];
const managers: McpManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

async function setUp(...args: Parameters<typeof loginBench>): Promise<{ b: LoginBench; manager: McpManager; connect: () => Promise<void> }> {
  const b = await loginBench(...args);
  benches.push(b);
  const manager = new McpManager({ connectWaitMs: 10_000, timeoutMs: 5_000, logins: b.logins });
  managers.push(manager);
  // What the daemon does on every reload of the pack (`onReloaded` in `index.ts`).
  const connect = () => manager.connectAgent(fakeAgent({ config: { id: "nouva", mcpServers: [b.server()] } as never }));
  return { b, manager, connect };
}

/** A person logging it in, as `logins.test.ts` does it — with the challenge the connection kept. */
async function logIn(b: LoginBench): Promise<void> {
  const started = await b.logins.start({ holder: b.holder, server: "fake", by: "user:gading" });
  if ("error" in started) throw new Error(started.error);
  const finished = await b.logins.finish(await approve(started.url), "user:gading", "gading");
  if ("error" in finished) throw new Error(finished.error);
}

const call = (manager: McpManager) => manager.toolsFor("nouva").get("fake__echo")!.execute({ text: "hi" }, { agentId: "nouva" } as ToolContext);

describe("a remote server with no credential of its own", () => {
  test("is tried with none, and its 401 makes it wait for a login — reported so, with no tools offered", async () => {
    const { b, manager, connect } = await setUp();
    await connect();
    expect(manager.status()).toEqual([{ agentId: "nouva", server: "fake", connected: false, tools: 0, schemaBytes: 0, needsLogin: true }]);
    expect(manager.toolsFor("nouva").size).toBe(0);
    // Sent nothing: the request reached the server with no Authorization at all.
    expect(b.servers.mcpRequests.find((r) => r.method === "POST")?.headers.authorization).toBeUndefined();
    // Nobody is told a login was lost: there never was one.
    expect(b.alerts).toEqual([]);
    // The challenge was kept: the login finds its authorization server through it.
    await logIn(b);
  });

  test("logged in, connects with its token on the reload, and its tools are offered", async () => {
    const { b, manager, connect } = await setUp();
    await connect();
    await logIn(b);
    await connect();
    expect(manager.status()).toEqual([{ agentId: "nouva", server: "fake", connected: true, tools: 1, schemaBytes: expect.any(Number) }]);
    expect((await call(manager)).content).toContain("hi");
  });
});

describe("a server that connects", () => {
  test("waits for nobody, whatever said it was waiting before", async () => {
    const { b, manager, connect } = await setUp();
    await connect();
    await logIn(b);
    // Said to wait meanwhile — by a call that met a 401, say — and then connected with what it holds.
    b.logins.refused("nouva", "fake", null);
    await connect();
    expect(manager.status()).toEqual([{ agentId: "nouva", server: "fake", connected: true, tools: 1, schemaBytes: expect.any(Number) }]);
  });
});

describe("a login lost while the server is in use", () => {
  test("is said to the agent — a person has to log in again, and where — and to the operator once", async () => {
    const { b, manager, connect } = await setUp();
    await connect();
    await logIn(b);
    await connect();
    b.servers.refuseRefreshes();
    b.servers.revokeAll();

    const first = await call(manager);
    expect(first.isError).toBe(true);
    expect(first.content).toContain('The MCP server "fake" needs a person to log in again');
    expect(first.content).toContain("/dashboard/mcp");
    expect(manager.status()[0]).toMatchObject({ server: "fake", needsLogin: true });
    expect((await call(manager)).isError).toBe(true);
    expect(b.alerts.map((alert) => alert.key)).toEqual(["mcp_login:shared:fake"]);
  });

  test("an authorization server out of reach is an outage: the call fails with why, and nobody is asked to log in", async () => {
    let down = false;
    const { b, manager, connect } = await setUp({}, { fetch: (input, init) => (down && String(input).includes("/token") ? Promise.reject(new TypeError("connection refused")) : fetch(input, init)) });
    await connect();
    await logIn(b);
    await connect();
    down = true;
    b.servers.revokeAll();

    const result = await call(manager);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("connection refused");
    expect(result.content).not.toContain("log in");
    expect(manager.status()[0]).not.toHaveProperty("needsLogin");
    expect(b.alerts).toEqual([]);
  });
});

describe("the challenge a login starts from", () => {
  test("is the one the connection's 401 carried", async () => {
    const { b, connect } = await setUp();
    await connect();
    const before = b.servers.mcpRequests.length;
    await logIn(b);
    // Discovery read the resource metadata where the 401 pointed, not from a fresh probe of its own.
    const asked = b.servers.mcpRequests.slice(before).map((r) => r.path);
    expect(asked[0]).toBe("/meta/resource");
    expect(await challengeOf(b.servers.mcpUrl)).toContain("resource_metadata");
  });
});
