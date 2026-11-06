/**
 * `nouride tool-budget` — the CLI half of the round-trip cap.
 *
 * The setting was reachable from the dashboard and from a hand-edited `config.toml`, which put it
 * out of reach of the one party that ever hits it: an agent holds the `nouride` tool, not a browser.
 * What these hold is the argument shape, because the two scopes mean different things and the CLI is
 * where they are easiest to confuse — a number alone is the daemon default, `--agent` is one pack's,
 * and `follow` is the only spelling of "use the default" that keeps tracking it.
 */

import { describe, expect, test } from "bun:test";
import type { Client } from "@/cli/client.ts";
import { toolBudget } from "@/cli/commands/tool-budget.ts";

function fakeClient(): Client & { posts: [string, unknown][]; gets: string[] } {
  const posts: [string, unknown][] = [];
  const gets: string[] = [];
  return {
    posts,
    gets,
    get: async <T>(path: string) => {
      gets.push(path);
      return (path === "/policy/tool-iterations"
        ? { maxToolIterations: 25, min: 5, max: 9999, editable: true }
        : { agents: [{ id: "nouva", maxToolIterations: 120 }, { id: "nox", maxToolIterations: null }] }) as T;
    },
    post: async <T>(path: string, body?: unknown) => {
      posts.push([path, body]);
      return {} as T;
    },
  } as Client & { posts: [string, unknown][]; gets: string[] };
}

describe("nouride tool-budget", () => {
  test("a bare number sets the daemon default", async () => {
    const client = fakeClient();
    await toolBudget(client, ["60"]);
    expect(client.posts).toEqual([["/policy/tool-iterations", { maxToolIterations: 60 }]]);
  });

  test("--agent sets that pack's own, leaving the daemon default alone", async () => {
    const client = fakeClient();
    await toolBudget(client, ["--agent", "nouva", "120"]);
    expect(client.posts).toEqual([["/agents/nouva/tool-iterations", { maxToolIterations: 120 }]]);
  });

  test("`follow` sends null, which is what removes the key", async () => {
    /**
     * Not the current default as a number. A pack written `120` because that is what the daemon says
     * today stops tracking the daemon tomorrow, and the two are indistinguishable afterwards.
     */
    const client = fakeClient();
    await toolBudget(client, ["--agent", "nouva", "follow"]);
    expect(client.posts).toEqual([["/agents/nouva/tool-iterations", { maxToolIterations: null }]]);
  });

  test("no arguments writes nothing and reads both scopes", async () => {
    const client = fakeClient();
    await toolBudget(client, []);
    expect(client.posts).toEqual([]);
    expect(client.gets).toEqual(["/policy/tool-iterations", "/status"]);
  });
});
