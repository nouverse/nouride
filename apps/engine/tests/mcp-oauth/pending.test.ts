/**
 * A login waiting for its redirect: given out once, for ten minutes, only to the person who started it — and never
 * more than a handful at a time.
 */

import { describe, expect, test } from "bun:test";
import { PENDING_LOGIN_MS, PendingLogins, type PendingLogin } from "@/modules/mcp-oauth/pending.ts";

const login = (state: string, startedBy = "user:gading"): Omit<PendingLogin, "expiresAt"> => ({
  state,
  verifier: `verifier-${state}`,
  redirectUri: "http://127.0.0.1:18254/dashboard/oauth/mcp/callback",
  discovery: { resource: "https://mcp.example.com/mcp", issuer: "https://auth.example.com", authorizationEndpoint: "https://auth.example.com/a", tokenEndpoint: "https://auth.example.com/t" },
  client: { clientId: "c" },
  holder: "nouva",
  server: "notion",
  startedBy,
});

describe("a pending login", () => {
  test("is given out once", () => {
    const pending = new PendingLogins();
    pending.add(login("s-1"));
    expect(pending.take("s-1", "user:gading")?.verifier).toBe("verifier-s-1");
    expect(pending.take("s-1", "user:gading")).toBeUndefined();
  });

  test("only to the person who started it — and stays theirs when somebody else asks", () => {
    const pending = new PendingLogins();
    pending.add(login("s-1", "user:gading"));
    expect(pending.take("s-1", "token:cli")).toBeUndefined();
    expect(pending.take("s-1", "user:sam")).toBeUndefined();
    expect(pending.take("s-1", "user:gading")?.state).toBe("s-1");
  });

  test("for ten minutes", () => {
    let now = 1_000_000;
    const pending = new PendingLogins(() => now);
    pending.add(login("s-1"));
    pending.add(login("s-2"));
    now += PENDING_LOGIN_MS - 1;
    expect(pending.take("s-1", "user:gading")).toBeDefined();
    now += 1;
    expect(pending.take("s-2", "user:gading")).toBeUndefined();
  });

  test("never more than 32 at once: the oldest goes first", () => {
    const pending = new PendingLogins();
    for (let n = 0; n < 40; n += 1) pending.add(login(`s-${n}`));
    expect(pending.take("s-7", "user:gading")).toBeUndefined();
    expect(pending.take("s-8", "user:gading")).toBeDefined();
    expect(pending.take("s-39", "user:gading")).toBeDefined();
  });
});
