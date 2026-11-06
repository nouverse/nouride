/**
 * What is not a secret about a login, on a database migrated as the daemon's is (`069_baseline.sql`): kept per agent
 * and server, replaced by the next login, renewed in place, removed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { McpLoginStore, type McpLogin } from "@/modules/mcp-oauth/logins.store.ts";
import { tempDir } from "../helpers.ts";

let dir = "";
let db: SqliteDb;
beforeEach(async () => {
  dir = tempDir("mcp-logins");
  db = await openAndMigrate(join(dir, "t.db"));
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const login = (over: Partial<McpLogin> = {}): McpLogin => ({
  agentId: "nouva",
  server: "notion",
  discovery: { resource: "https://mcp.notion.com/mcp", issuer: "https://mcp.notion.com", authorizationEndpoint: "https://mcp.notion.com/authorize", tokenEndpoint: "https://mcp.notion.com/token", scope: "read" },
  clientId: "client-1",
  tokenMethod: null,
  expiresAt: 5_000,
  scope: "read",
  loggedInBy: "gading",
  loggedInAt: 1_000,
  ...over,
});

describe("a login's row", () => {
  test("is kept per agent and server, the discovery read back whole", () => {
    const store = new McpLoginStore(db);
    store.put(login());
    store.put(login({ agentId: "nix", clientId: "client-2" }));
    expect(store.get("nouva", "notion")).toEqual(login());
    expect(store.get("nix", "notion")?.clientId).toBe("client-2");
    expect(store.get("nouva", "linear")).toBeUndefined();
  });

  test("is replaced by the next login, and renewed in place", () => {
    const store = new McpLoginStore(db);
    store.put(login());
    store.put(login({ clientId: "client-3", tokenMethod: "client_secret_post", loggedInBy: "sam", loggedInAt: 2_000 }));
    store.renewed("nouva", "notion", 9_000, null);
    expect(store.get("nouva", "notion")).toEqual(login({ clientId: "client-3", tokenMethod: "client_secret_post", loggedInBy: "sam", loggedInAt: 2_000, expiresAt: 9_000, scope: null }));
  });

  test("is removed, once", () => {
    const store = new McpLoginStore(db);
    store.put(login());
    expect(store.remove("nouva", "notion")).toBe(true);
    expect(store.remove("nouva", "notion")).toBe(false);
    expect(store.get("nouva", "notion")).toBeUndefined();
  });
});
