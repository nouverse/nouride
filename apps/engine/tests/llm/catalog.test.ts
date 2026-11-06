/**
 * A profile's model listing, kept for hearing and for the context window (`llm/catalog.ts`): asked at most hourly, a
 * minute after it failed, once for any number of readers at once — and never waited for by a turn.
 */

import { describe, expect, test } from "bun:test";
import { ModelCatalog } from "@/modules/llm/catalog.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { SecretStore } from "@nouride/secrets";
import { eventually } from "../wait.ts";

const ENDPOINT = { kind: "openai" as const, baseUrl: "https://gw.test/v1", apiKey: "k" };

function gateway(models: Record<string, unknown>[] | (() => Response)) {
  let asked = 0;
  const fetchImpl = (async () => {
    asked += 1;
    return typeof models === "function" ? models() : Response.json({ data: models });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked: () => asked };
}

function catalog(fetchImpl: typeof fetch, clock = { at: 1_000_000 }) {
  return { catalog: new ModelCatalog({ endpointFor: () => ENDPOINT, fetchImpl, now: () => clock.at }), clock };
}

describe("the window a gateway states", () => {
  test("is not waited for: the first turn gets nothing and asks, the next one has it", async () => {
    const gw = gateway([{ id: "kiro:claude-opus-5.5", context_window: 1_000_000 }]);
    const { catalog: c } = catalog(gw.fetchImpl);

    expect(c.windowNow("nougate", "kiro:claude-opus-5.5")).toBeNull();
    await eventually(() => gw.asked() === 1, 2_000, "the listing to be asked for");
    await eventually(() => c.windowNow("nougate", "kiro:claude-opus-5.5") === 1_000_000, 2_000, "the window to be known");
  });

  test("for a bare id, is the smallest of every route that serves it — and none when one of them states none", async () => {
    const gw = gateway([
      { id: "kiro:claude-opus-5.5", context_window: 1_000_000 },
      { id: "claudecode:claude-opus-5.5", context_window: 200_000 },
      { id: "kiro:minimax-m3", context_window: 196_608 },
      { id: "copilot:minimax-m3" },
      { id: "custom:renamed", legacy_id: "old-name", context_length: 131_072 },
    ]);
    const { catalog: c } = catalog(gw.fetchImpl);
    await c.listing("nougate");

    expect(c.windowNow("nougate", "claude-opus-5.5")).toBe(200_000);
    expect(c.windowNow("nougate", "minimax-m3")).toBeNull();
    expect(c.windowNow("nougate", "kiro:minimax-m3")).toBe(196_608);
    expect(c.windowNow("nougate", "old-name")).toBe(131_072);
    expect(c.windowNow("nougate", "nobody:serves-this")).toBeNull();
  });
});

describe("the listing", () => {
  test("is asked once for readers that ask at once, and again only after an hour", async () => {
    const gw = gateway([{ id: "a:m", context_window: 64_000 }]);
    const { catalog: c, clock } = catalog(gw.fetchImpl);

    await Promise.all([c.listing("nougate"), c.listing("nougate"), c.listing("nougate")]);
    expect(gw.asked()).toBe(1);
    clock.at += 59 * 60_000;
    await c.listing("nougate");
    expect(gw.asked()).toBe(1);
    clock.at += 2 * 60_000;
    await c.listing("nougate");
    expect(gw.asked()).toBe(2);
  });

  test("that could not be read is asked again after a minute, not an hour — and says nothing meanwhile", async () => {
    let up = false;
    const gw = gateway(() => (up ? Response.json({ data: [{ id: "a:m", context_window: 64_000 }] }) : new Response("down", { status: 502 })));
    const { catalog: c, clock } = catalog(gw.fetchImpl);

    expect(await c.listing("nougate")).toBeNull();
    up = true;
    clock.at += 30_000;
    expect(await c.listing("nougate")).toBeNull();
    clock.at += 31_000;
    expect((await c.listing("nougate"))?.get("a:m")?.contextWindow).toBe(64_000);
    expect(gw.asked()).toBe(2);
  });

  test("of a profile whose endpoint changed is forgotten, and asked again", async () => {
    const gw = gateway([{ id: "a:m" }]);
    const { catalog: c } = catalog(gw.fetchImpl);
    await c.listing("nougate");
    c.forget("nougate");
    await c.listing("nougate");
    expect(gw.asked()).toBe(2);
  });

  test("of a profile that cannot be reached is none, without a request", async () => {
    const gw = gateway([{ id: "a:m" }]);
    const c = new ModelCatalog({
      endpointFor: () => {
        throw new Error('provider profile "gone" is not defined');
      },
      fetchImpl: gw.fetchImpl,
    });
    expect(await c.listing("gone")).toBeNull();
    expect(c.windowNow("gone", "a:m")).toBeNull();
    expect(gw.asked()).toBe(0);
  });
});

describe("the daemon's catalog", () => {
  test("is the provider registry's, and a profile the registry forgets — its URL or key changed — is asked again", async () => {
    const gw = gateway([{ id: "a:m" }]);
    const secrets = { require: () => "k", has: () => true } as unknown as SecretStore;
    const providers = new ProviderRegistry({ nougate: { kind: "openai", baseUrl: "https://gw.test/v1", apiKeySecret: "KEY" } } as never, secrets, { fetchImpl: gw.fetchImpl });

    await providers.catalog.listing("nougate");
    await providers.catalog.listing("nougate");
    expect(gw.asked()).toBe(1);
    providers.forget("nougate");
    await providers.catalog.listing("nougate");
    expect(gw.asked()).toBe(2);
  });
});
