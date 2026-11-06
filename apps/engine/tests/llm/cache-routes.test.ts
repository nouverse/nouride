/**
 * Routes that lose the provider's cache (TOKEN_SAVINGS §3.1, 0.8.13). Measured on the live box: Gemini Flash through
 * one profile cached 1 % of its input at $0.77 a million, through another 94 % at $0.15 — half the spend went through
 * the two poor pairs, and nothing said so. Found from the usage rows: the same model, two routes, one far below.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { cacheWarnings, ENOUGH_REQUESTS, type UsageRoute } from "@/modules/llm/cache-routes.ts";

const route = (provider: string, model: string, requests: number, input: number, cached: number, usd: number | null = null): UsageRoute => ({
  provider, model, requests, inputTokens: input, cachedInputTokens: cached, reportedInputTokens: input, usd,
});

test("a route of a model caching far below another route of it is named, with what each costs", () => {
  const warnings = cacheWarnings([
    route("profile-b", "flash", 400, 100_000_000, 1_000_000, 77),
    route("profile-a", "flash", 300, 50_000_000, 47_000_000, 7.5),
    route("profile-a", "sonnet", 300, 50_000_000, 40_000_000, 32),
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({ model: "flash", poor: { provider: "profile-b" }, better: { provider: "profile-a" } });
  expect(warnings[0]!.said).toBe(
    "flash through profile-b cached 1 % of its input at $0.77 a million input; through profile-a, 94 % at $0.15 a million input. " +
      "The agents on profile-b pay that difference on every request: give them profile-a for flash.",
  );
});

test("nothing is said for one route alone, a close second, a route with too few requests, or one that reports no cache", () => {
  expect(cacheWarnings([route("profile-a", "flash", 400, 1_000_000, 10_000)])).toEqual([]);
  expect(cacheWarnings([route("a", "flash", 400, 1_000_000, 900_000), route("b", "flash", 400, 1_000_000, 600_000)])).toEqual([]);
  expect(cacheWarnings([route("a", "flash", 400, 1_000_000, 900_000), route("b", "flash", ENOUGH_REQUESTS - 1, 1_000_000, 0)])).toEqual([]);
  // A provider that reported nothing has no share to compare: "did not say" is not "0 %".
  expect(cacheWarnings([route("a", "flash", 400, 1_000_000, 900_000), { ...route("b", "flash", 400, 1_000_000, 0), reportedInputTokens: 0 }])).toEqual([]);
});

let dir: string;
let db: SqliteDb;
beforeEach(async () => {
  dir = join(tmpdir(), `nouride-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  db = openDatabase(join(dir, "test.db"));
  await migrate(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the ledger adds each profile and model up — a CLI's prompts, embeddings and an unreported cache kept apart", () => {
  const store = new UsageStore(db, () => 1_000);
  const call = (provider: string, model: string, input: number, cached: number | undefined, extra: Record<string, unknown> = {}) =>
    store.record({ agentId: "nouva", provider, model, inputTokens: input, outputTokens: 10, ...(cached === undefined ? {} : { cachedInputTokens: cached }), ...extra } as never);
  call("profile-a", "flash", 1_000, 900);
  call("profile-a", "flash", 1_000, undefined);
  call("profile-b", "flash", 2_000, 20);
  call("codex", "gpt", 9_000, 9_000, { cli: true });
  call("profile-a", "embed", 500, undefined, { purpose: "embedding" });
  const routes = store.routes(0);
  expect(routes.map((one) => [one.provider, one.model, one.requests, one.inputTokens, one.cachedInputTokens, one.reportedInputTokens])).toEqual([
    ["profile-a", "flash", 2, 2_000, 900, 1_000],
    ["profile-b", "flash", 1, 2_000, 20, 2_000],
  ]);
});
