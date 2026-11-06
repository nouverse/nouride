/**
 * Where the dashboard sends a visitor — the order of the first-run screens.
 *
 * It was wrong on the first Nouride Box: the setup wizard (models, agents) came before the screen
 * that replaces the first-login password, and the owner asked for the account to come first.
 */

import { describe, expect, test } from "bun:test";
import { nextOf, redirectFor, safeNext, sessionFrom } from "@/commons/lib/session";
import { ApiError } from "@/commons/lib/api.client";
import type { Principal, SetupState } from "@/commons/lib/api";

const unfinished = { complete: false } as SetupState;
const finished = { complete: true } as SetupState;
const firstLogin = { kind: "user", role: "admin", user: { username: "admin", mustChangePassword: true } } as unknown as Principal;
const settled = { kind: "user", role: "admin", user: { username: "admin", mustChangePassword: false } } as unknown as Principal;

describe("first-run order", () => {
  test("a first-login password is replaced before the setup wizard", () => {
    expect(redirectFor(firstLogin, unfinished, "/")).toBe("/welcome");
    expect(redirectFor(firstLogin, unfinished, "/setup")).toBe("/welcome");
  });

  test("on /welcome it stays there, even though setup is not finished", () => {
    expect(redirectFor(firstLogin, unfinished, "/welcome")).toBeNull();
  });

  test("then the setup wizard", () => {
    expect(redirectFor(settled, unfinished, "/")).toBe("/setup");
    expect(redirectFor(settled, unfinished, "/setup")).toBeNull();
  });

  test("signed out goes to the login page, and a finished install lets them in", () => {
    expect(redirectFor(null, unfinished, "/")).toBe("/login");
    expect(redirectFor(settled, finished, "/login")).toBe("/");
    expect(redirectFor(settled, finished, "/box")).toBeNull();
  });
});

/**
 * A daemon restarting under a signed-in page — from Overview, a save that needs one, an update. Read as signed out,
 * whoever switched back to the tab landed on the login form, and their unsaved edits went with the page.
 */
describe("a failed /auth/me", () => {
  test("from a daemon not answering keeps who was signed in, and says it is reconnecting", () => {
    for (const status of [0, 503, 502, 504, 522]) {
      expect(sessionFrom(settled, new ApiError(status, "nouride is starting"))).toEqual({ principal: settled, offline: true });
    }
  });

  test("a 401 or 403 is the daemon saying so — that alone signs out", () => {
    expect(sessionFrom(settled, new ApiError(401, "sign in"))).toEqual({ principal: null, offline: false });
    expect(sessionFrom(settled, new ApiError(403, "forbidden"))).toEqual({ principal: null, offline: false });
    expect(redirectFor(sessionFrom(settled, new ApiError(401, "sign in")).principal, finished, "/agents")).toBe("/login?next=%2Fagents");
  });

  test("any other failure keeps the last answer too, without calling the daemon gone", () => {
    expect(sessionFrom(settled, new ApiError(500, "boom"))).toEqual({ principal: settled, offline: false });
    expect(sessionFrom(undefined, new ApiError(503, "nouride is starting"))).toEqual({ principal: null, offline: true });
  });
});

/**
 * A dashboard link from a chat, opened signed out (0.8.11): it went to the login form and then to Overview, and the page
 * it named was lost. Only a path inside the dashboard is kept, or `next` is an open redirect.
 */
describe("signing in keeps the page a link opened", () => {
  test("signed out, a page goes to the login form with itself, its search with it, as `next`; Overview needs none", () => {
    expect(redirectFor(null, finished, "/missions/msn_x", "?tab=1")).toBe(`/login?next=${encodeURIComponent("/missions/msn_x?tab=1")}`);
    expect(redirectFor(null, finished, "/schedule", "?job=job_1")).toBe(`/login?next=${encodeURIComponent("/schedule?job=job_1")}`);
    expect(redirectFor(null, finished, "/")).toBe("/login");
  });

  test("signed in on the login form, the visitor goes on to `next`; without one, to Overview", () => {
    expect(redirectFor(settled, finished, "/login", `?next=${encodeURIComponent("/missions/msn_x?tab=1")}`)).toBe("/missions/msn_x?tab=1");
    expect(redirectFor(settled, finished, "/login", "")).toBe("/");
  });

  test("another site, a scheme, a backslash or a control character, and the login page itself are dropped", () => {
    for (const next of ["//evil.example", "https://evil.example", "javascript:alert(1)", "/\\evil.example", "/\t/evil.example", "/login", "/Login?next=/x", "evil.example", ""]) {
      expect(safeNext(next)).toBeNull();
      expect(redirectFor(settled, finished, "/login", `?next=${encodeURIComponent(next)}`)).toBe("/");
    }
    expect(nextOf(`?next=${encodeURIComponent("/missions/msn_x?tab=1")}`)).toBe("/missions/msn_x?tab=1");
  });

  test("a first-login password and an unfinished setup still come first", () => {
    const next = `?next=${encodeURIComponent("/missions/msn_x")}`;
    expect(redirectFor(firstLogin, unfinished, "/login", next)).toBe("/welcome");
    expect(redirectFor(settled, unfinished, "/login", next)).toBe("/setup");
  });
});
