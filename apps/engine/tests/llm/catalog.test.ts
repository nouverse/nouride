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

/**
 * What the endpoint last said, kept across a restart. The first turns after a boot (the messages that waited while
 * the daemon was down among them) and every turn while a listing could not be read were budgeted by the table's
 * guess: 200,000 for Opus 5.5, which the box's gateway lists at a million. A coding agent's history was compacted twice
 * at that guess, and a tool result it was still using was cut.
 */
describe("the windows kept across a restart", () => {
  /** The daemon's state row as a test holds it: what was saved, read back by the next catalog. */
  function row(initial: Record<string, { address: string; windows: Record<string, number | null> }> = {}) {
    let kept = structuredClone(initial);
    const saves: unknown[] = [];
    return { remembered: { load: () => structuredClone(kept), save: (windows: typeof kept) => void (saves.push(windows), (kept = structuredClone(windows))) }, saves, kept: () => kept };
  }
  const listed = [
    { id: "claudecode:claude-opus-5-5", context_window: 1_000_000 },
    { id: "kiro:claude-opus-5-5", context_window: 1_000_000 },
    { id: "copilot:gpt-6" },
  ];

  test("a listing that was read is kept, and the next boot answers from it before its own listing is back", async () => {
    const store = row();
    const first = new ModelCatalog({ endpointFor: () => ENDPOINT, fetchImpl: gateway(listed).fetchImpl, remembered: store.remembered });
    await first.listing("nougate");
    expect(store.kept()).toEqual({ nougate: { address: "https://gw.test/v1", windows: { "claudecode:claude-opus-5-5": 1_000_000, "kiro:claude-opus-5-5": 1_000_000, "copilot:gpt-6": null } } });

    // The next boot: a gateway that has not answered yet.
    const never = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const next = new ModelCatalog({ endpointFor: () => ENDPOINT, fetchImpl: never, remembered: store.remembered });
    expect(next.windowNow("nougate", "claude-opus-5-5")).toBe(1_000_000);
    expect(next.windowNow("nougate", "claudecode:claude-opus-5-5")).toBe(1_000_000);
    // What was said of a model with no window is kept as that: a route that says nothing, for a bare id, is none.
    expect(next.windowNow("nougate", "gpt-6")).toBeNull();
    expect(next.windowNow("nougate", "nobody:serves-this")).toBeNull();
  });

  test("while a listing cannot be read, what was said before answers, not the table's guess", async () => {
    const store = row({ nougate: { address: "https://gw.test/v1", windows: { "claudecode:claude-opus-5-5": 1_000_000 } } });
    const down = gateway(() => new Response("bad gateway", { status: 502 }));
    const c = new ModelCatalog({ endpointFor: () => ENDPOINT, fetchImpl: down.fetchImpl, remembered: store.remembered });
    await c.listing("nougate");
    expect(c.windowNow("nougate", "claude-opus-5-5")).toBe(1_000_000);
    // A listing that failed writes nothing over what was kept.
    expect(store.saves).toEqual([]);
  });

  test("what the endpoint says now wins, and is kept in its place; the same answer again is not written again", async () => {
    const store = row({ nougate: { address: "https://gw.test/v1", windows: { "claudecode:claude-opus-5-5": 200_000 } } });
    const clock = { at: 1_000_000 };
    const c = new ModelCatalog({ endpointFor: () => ENDPOINT, fetchImpl: gateway(listed).fetchImpl, remembered: store.remembered, now: () => clock.at });
    expect(c.windowNow("nougate", "claude-opus-5-5")).toBe(200_000);
    await c.listing("nougate");
    expect(c.windowNow("nougate", "claude-opus-5-5")).toBe(1_000_000);
    expect(store.kept().nougate?.windows["claudecode:claude-opus-5-5"]).toBe(1_000_000);
    clock.at += 61 * 60 * 1000;
    await c.listing("nougate");
    expect(store.saves).toHaveLength(1);
  });

  test("only for the address it was said by: a profile moved elsewhere is not answered from it, and forgetting it drops it", async () => {
    const store = row({ nougate: { address: "https://gw.test/v1", windows: { "claudecode:claude-opus-5-5": 1_000_000 } } });
    const never = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const moved = new ModelCatalog({ endpointFor: () => ({ ...ENDPOINT, baseUrl: "https://other.test/v1" }), fetchImpl: never, remembered: store.remembered });
    expect(moved.windowNow("nougate", "claude-opus-5-5")).toBeNull();

    const same = new ModelCatalog({ endpointFor: () => ENDPOINT, fetchImpl: never, remembered: store.remembered });
    same.forget("nougate");
    expect(same.windowNow("nougate", "claude-opus-5-5")).toBeNull();
    expect(store.kept()).toEqual({});
  });

  test("a profile that cannot be reached is answered from nothing kept, and nothing is written", async () => {
    const store = row({ gone: { address: "https://gw.test/v1", windows: { "a:m": 64_000 } } });
    const c = new ModelCatalog({
      endpointFor: () => {
        throw new Error("no such profile");
      },
      remembered: store.remembered,
    });
    expect(c.windowNow("gone", "a:m")).toBeNull();
    await c.listing("gone");
    expect(store.saves).toEqual([]);
  });
});

describe("the windows kept, in the daemon's own state", () => {
  test("a real database's row: what one registry's catalog was told, the next registry's catalog answers from", async () => {
    const { modelWindowsState } = await import("@/commons/daemon-state.ts");
    const { stateRows } = await import("../helpers.ts");
    // The daemon's own store over a migrated database, as the boot hands it to the registry (`boot/stores.ts`).
    const rows = stateRows();
    const secrets = { require: () => "k", has: () => true } as unknown as SecretStore;
    const profiles = { nougate: { kind: "openai" as const, baseUrl: "https://gw.test/v1", apiKeySecret: "nougate_key" } };

    const first = new ProviderRegistry(profiles, secrets, { fetchImpl: gateway([{ id: "claudecode:claude-opus-5-5", context_window: 1_000_000 }]).fetchImpl }, undefined, modelWindowsState(rows));
    await first.catalog.listing("nougate");

    const never = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const next = new ProviderRegistry(profiles, secrets, { fetchImpl: never }, undefined, modelWindowsState(rows));
    expect(next.catalog.windowNow("nougate", "claude-opus-5-5")).toBe(1_000_000);
  });

  test("a row that does not read as windows is left out, entry by entry, and the rest is kept", async () => {
    const { modelWindowsState } = await import("@/commons/daemon-state.ts");
    const stored = JSON.stringify({
      good: { address: "https://gw.test/v1", windows: { "a:m": 64_000, "b:m": null, "c:m": -1, "d:m": 1.5, "e:m": "big" } },
      noAddress: { windows: { "a:m": 64_000 } },
      noWindows: { address: "https://gw.test/v1" },
    });
    const state = modelWindowsState({ get: () => stored, set: () => {} });
    expect(state.load()).toEqual({ good: { address: "https://gw.test/v1", windows: { "a:m": 64_000, "b:m": null } } });
    expect(modelWindowsState({ get: () => "[1,2]", set: () => {} }).load()).toEqual({});
    expect(modelWindowsState({ get: () => null, set: () => {} }).load()).toEqual({});
  });
});
