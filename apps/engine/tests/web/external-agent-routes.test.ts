/**
 * An external agent's CLI from the dashboard and `nouride agents` (0.8.1): its routes answer only for an external
 * agent, and hand a typed answer to the sign-in only as a line of text.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import type { LoadedAgent } from "@nouride/shared";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import { registerExternalAgentRoutes } from "@/modules/web/control/routes/external-agents.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";
import type { ExternalAgents } from "@/modules/external-agents/index.ts";

const TOKEN = "control-token-for-tests-0000000000";

/** `wayBack`: the version its CLI's update check offers back, where a new version failed it (0.8.24). */
function app(wayBack: string | null = null, moved?: { accounts?: string[]; on?: string; moveAt?: number; saysUse?: boolean }) {
  const seen: string[] = [];
  const audits: { action: string; actor?: string; details?: Record<string, unknown> }[] = [];
  const agents: Record<string, LoadedAgent> = {
    coder: { config: { id: "coder", external: { cli: "codex", profile: "work", ...(moved?.accounts ? { accounts: moved.accounts } : {}), ...(moved?.moveAt !== undefined ? { moveAt: moved.moveAt } : {}) }, llm: { effort: "high" } } } as unknown as LoadedAgent,
    nouva: { config: { id: "nouva" } } as unknown as LoadedAgent,
  };
  const login = { running: true, output: "Open https://x.test", links: ["https://x.test"], exitCode: null };
  const externalAgents = {
    room: () => ({ enough: true, bytes: 2 ** 31, needs: 2 ** 29 }),
    rotation: { accountOf: () => moved?.on },
    scan: async () => [{ id: "codex", name: "Codex", command: "codex-acp", installed: false, install: "npm i -g", login: true }],
    unavailable: () => (wayBack ? "Codex 2.6.0 did not pass Nouride's check: it no longer offers steering" : "Codex is not signed in"),
    updates: { wayBack: () => wayBack },
    models: { of: () => [{ value: "gpt-5.5-codex" }, { value: "gpt-5.5-mini", name: "GPT-5.5 mini" }] },
    efforts: { of: () => [{ value: "low" }, { value: "high", current: "high" }] },
    preset: () => "risky",
    login: (key: string) => (key.startsWith("@") ? (seen.push(`view ${key}`), login) : null),
    accountList: async (agents: LoadedAgent[], fresh: boolean) => (seen.push(`accounts ${agents.length}${fresh ? " fresh" : ""}`), [{ id: "claude-code", accounts: [] }]),
    accounts: {
      add: (cli: string, name: string) => (seen.push(`add ${cli} ${name}`), name === "Bad" ? { ok: false, error: "bad name" } : { ok: true }),
      remove: async (cli: string, name: string) =>
        (seen.push(`remove ${cli} ${name}`),
        name === "spare" ? { ok: true, tokenRemoved: true } : name === "stuck" ? { ok: true, tokenRemoved: false, tokenError: "read-only file system" } : { ok: false, error: "Coder uses it", users: ["Coder"] }),
    },
    useOf: async (row: { id: string }, name: string, agents: LoadedAgent[]) => (
      seen.push(`use ${row.id} ${name} ${agents.length}`),
      name === "team" ? { seen: { use: { limits: [] }, at: 5 } } : name === "solo" ? { seen: null, agents: [{ id: "coder", seen: { use: { limits: [] }, at: 7, said: true } }, { id: "nox", seen: null }] } : { seen: null }
    ),
    startAccountLogin: (cli: string, name: string, actor: string) => (seen.push(`account login ${cli} ${name} by ${actor}`), login),
    row: (id: string) => (id === "codex" || id === "claude-code" ? { id, profileEnv: "CODEX_HOME", ...(moved?.saysUse ? { use: { meta: "m", windows: "w", used: "u", resets: "r" } } : {}) } : undefined),
    profiles: async (agent: LoadedAgent, fresh: boolean) => (seen.push(`profiles ${agent.config.id}${fresh ? " fresh" : ""}`), [{ name: "work", inUse: true, signedIn: false, reason: "Codex is not signed in" }]),
    startLogin: (agent: LoadedAgent, profile?: string) => (seen.push(`start ${agent.config.id}${profile ? ` on ${profile}` : ""}`), login),
    answerLogin: (id: string, text: string) => (seen.push(`answer ${id} ${text}`), login),
    stopLogin: (id: string) => void seen.push(`stop ${id}`),
  } as unknown as ExternalAgents;
  const setup = {
    setExternal: async (input: { agentId: string; settings: Record<string, unknown> }) => (seen.push(`set ${input.agentId} ${JSON.stringify(input.settings)}`), { ok: true as const }),
    setAnsweredBy: async (input: { agentId: string; cli: string | null; profile?: string }) => (seen.push(`answered ${input.agentId} ${input.cli} ${input.profile ?? ""}`.trim()), { ok: true as const }),
    setEffort: async (input: { agentId: string; effort: string }) => (seen.push(`effort ${input.agentId} ${input.effort}`), { ok: true as const }),
  };
  const scoped = new Hono();
  mountControlRoutes(scoped, {
    setup,
    ctx: { config: { llm: { defaults: { effort: "medium" } } }, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
    token: TOKEN,
    registry: { get: (id: string) => agents[id], all: () => Object.values(agents) } as unknown as AgentRegistry,
    externalAgents,
    audit: { record: (entry: (typeof audits)[number]) => void audits.push(entry) },
  } as unknown as ControlDeps);
  const call = (method: string, path: string, body?: unknown) =>
    scoped.request(`/api/control${path}`, { method, headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { clientAddress: "203.0.113.10" });
  return { call, seen, audits };
}

describe("an external agent's CLI routes", () => {
  test("after its CLI's new version failed its check, the version before is offered back, in the page's words (0.8.24)", async () => {
    const { call } = app("2.5.0");
    expect(await (await call("GET", "/agents/coder/cli")).json()).toMatchObject({
      unavailable: "Codex 2.6.0 did not pass Nouride's check: it no longer offers steering",
      plain: "Its coding CLI was updated to a version that does not work with this Nouride. The version before can be put back.",
      wayBack: "2.5.0",
    });
  });

  test("show its settings and status, and run its sign-in", async () => {
    const { call, seen } = app();
    // Why it cannot answer, in its CLI's words, and that it cannot, in the page's (0.8.23).
    expect(await (await call("GET", "/agents/coder/cli")).json()).toEqual({ cli: "codex", profile: "work", permissions: "risky", model: null, models: [{ value: "gpt-5.5-codex" }, { value: "gpt-5.5-mini", name: "GPT-5.5 mini" }], effort: "high", efforts: [{ value: "low" }, { value: "high", current: "high" }], effortChoices: ["low", "medium", "high", "xhigh", "max"], effortDefault: "medium", unavailable: "Codex is not signed in", plain: "It cannot answer right now. Whoever runs the server can see why under Details.", wayBack: null, login: null });
    expect((await call("POST", "/agents/coder/cli/login")).status).toBe(200);
    expect((await call("POST", "/agents/coder/cli/login/answer", { text: "CODE-1" })).status).toBe(200);
    expect((await call("POST", "/agents/coder/cli/login/stop")).status).toBe(200);
    expect(seen).toEqual(["start coder", "answer coder CODE-1", "stop coder"]);
    expect(((await (await call("GET", "/external-clis")).json()) as { clis: unknown[] }).clis).toHaveLength(1);
  });

  test("its profiles, asked fresh where the tab asks; a sign-in on the one named, a name no folder could carry refused (0.8.1)", async () => {
    const { call, seen } = app();
    expect(await (await call("GET", "/agents/coder/cli/profiles?fresh=1")).json()).toEqual({
      profiles: [{ name: "work", inUse: true, signedIn: false, reason: "Codex is not signed in" }],
      separate: true,
      models: [{ value: "gpt-5.5-codex" }, { value: "gpt-5.5-mini", name: "GPT-5.5 mini" }],
    });
    expect((await call("POST", "/agents/coder/cli/login", { profile: "spare" })).status).toBe(200);
    expect((await call("POST", "/agents/coder/cli/login", { profile: "../nouva" })).status).toBe(400);
    expect((await call("GET", "/agents/nouva/cli/profiles")).status).toBe(404);
    expect(seen).toEqual(["profiles coder fresh", "start coder on spare"]);
  });

  test("its settings reach the pack's writer as text, the preset only as one of the three", async () => {
    const { call, seen } = app();
    expect((await call("POST", "/agents/coder/cli", { permissions: "all", model: "" })).status).toBe(200);
    expect((await call("POST", "/agents/coder/cli", { permissions: "anything" })).status).toBe(400);
    expect((await call("POST", "/agents/coder/cli", { model: 5 })).status).toBe(400);
    expect(seen).toEqual(['set coder {"model":"","permissions":"all"}']);
    // Its effort (0.8.7): set, back to the install's, or refused before anything is written.
    seen.length = 0;
    expect((await call("POST", "/agents/coder/cli", { effort: "xhigh" })).status).toBe(200);
    expect((await call("POST", "/agents/coder/cli", { effort: "default" })).status).toBe(200);
    expect((await call("POST", "/agents/coder/cli", { effort: "huge", model: "x" })).status).toBe(400);
    expect(seen).toEqual(["set coder {}", "effort coder xhigh", "set coder {}", "effort coder default"]);
  });

  test("show the accounts it moves through, and the one it is on now where it has moved", async () => {
    const moved = await (await app(undefined, { accounts: ["work", "spare"], on: "spare" }).call("GET", "/agents/coder/cli")).json();
    expect(moved).toMatchObject({ profile: "work", accounts: ["work", "spare"], on: "spare" });
    // On its first account, or not started yet: nothing said of another.
    const home = (await (await app(undefined, { accounts: ["work", "spare"], on: "work" }).call("GET", "/agents/coder/cli")).json()) as Record<string, unknown>;
    expect(home.accounts).toEqual(["work", "spare"]);
    expect("on" in home).toBe(false);
    expect("on" in ((await (await app(undefined, { accounts: ["work", "spare"] }).call("GET", "/agents/coder/cli")).json()) as Record<string, unknown>)).toBe(false);
    // An agent with the one account has no list to show.
    expect("accounts" in ((await (await app().call("GET", "/agents/coder/cli")).json()) as Record<string, unknown>)).toBe(false);
  });

  test("its accounts to move through reach the writer as the list given, each a name once; anything else is refused", async () => {
    const { call, seen } = app();
    expect((await call("POST", "/agents/coder/cli", { profile: ["rina", "work"] })).status).toBe(200);
    expect(seen).toContain('set coder {"profile":["rina","work"]}');
    for (const bad of [[], ["rina", "rina"], ["rina", "Not A Name"], ["rina", 7]]) {
      const refused = await call("POST", "/agents/coder/cli", { profile: bad });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe("profile as a list is one or more account names, lowercase letters, digits and dashes, each once");
    }
    expect(seen.filter((line) => line.startsWith("set coder"))).toHaveLength(1);
  });

  test("moving on before a limit: its mark is shown where it set one, with whether its CLI says an account's use; set and turned off by the same field", async () => {
    const shown = (await (await app(undefined, { accounts: ["work", "spare"], moveAt: 90, saysUse: true }).call("GET", "/agents/coder/cli")).json()) as Record<string, unknown>;
    expect(shown).toMatchObject({ moveAt: 90, saysUse: true });
    // No mark set, and a CLI that says nothing of an account's use: neither is said.
    const plain = (await (await app(undefined, { accounts: ["work", "spare"] }).call("GET", "/agents/coder/cli")).json()) as Record<string, unknown>;
    expect(["moveAt" in plain, "saysUse" in plain]).toEqual([false, false]);
    // With the one account still, what its CLI can say is said all the same: the page then offers the setting.
    expect(await (await app(undefined, { saysUse: true }).call("GET", "/agents/coder/cli")).json()).toMatchObject({ saysUse: true });
    const { call, seen } = app();
    expect((await call("POST", "/agents/coder/cli", { move_at: 85 })).status).toBe(200);
    expect((await call("POST", "/agents/coder/cli", { move_at: null })).status).toBe(200);
    expect(seen.filter((line) => line.startsWith("set coder"))).toEqual(['set coder {"moveAt":85}', 'set coder {"moveAt":null}']);
    for (const bad of [0, 100, 85.5, "85", true]) {
      const refused = await call("POST", "/agents/coder/cli", { move_at: bad });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe("the share of a limit to move on at is a whole number from 1 to 99, or nothing to turn it off");
    }
    expect(seen.filter((line) => line.startsWith("set coder"))).toHaveLength(2);
  });

  test("its sign-in's terminal is an admin's to read, as the sign-in is — an operator sees the rest", async () => {
    // What a sign-in prints can be the code that signs the account in; `GET /agents/:id/cli` handed it to an operator.
    const login = { running: true, output: "Enter the code ABCD-1234 at https://x.test/device", links: ["https://x.test/device"], exitCode: null };
    const answer = async (role: "admin" | "operator") => {
      const scoped = new Hono();
      scoped.use("*", async (c, next) => {
        c.set("principal" as never, { kind: "session", actor: role, role } as never);
        await next();
      });
      registerExternalAgentRoutes(scoped as never, {
        registry: { get: () => ({ config: { id: "coder", external: { cli: "codex" } } }) },
        ctx: { config: { llm: { defaults: {} } } },
        externalAgents: { preset: () => "risky", models: { of: () => [] }, efforts: { of: () => [] }, unavailable: () => null, login: () => login, row: () => undefined },
      } as never);
      return (await (await scoped.request("/agents/coder/cli")).json()) as { login: unknown; cli: string };
    };
    // One that can answer has nothing to say about it, in either words.
    expect(await answer("admin")).toMatchObject({ cli: "codex", login, unavailable: null, plain: null });
    expect(await answer("operator")).toMatchObject({ cli: "codex", login: null });
  });

  test("answer only for an external agent, and take a line of text only", async () => {
    const { call, seen } = app();
    expect((await call("GET", "/agents/nouva/cli")).status).toBe(404);
    expect((await call("POST", "/agents/nouva/cli/login")).status).toBe(404);
    expect((await call("GET", "/agents/ghost/cli")).status).toBe(404);
    expect((await call("POST", "/agents/coder/cli/login/answer", { text: 42 })).status).toBe(400);
    expect((await call("POST", "/agents/coder/cli/login/answer", { text: "x".repeat(2001) })).status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("coding-CLI accounts (0.8.1)", () => {
  test("listed with their agents, added, removed while unused, and a shared one signed in, keyed by the account", async () => {
    const { call, seen } = app();
    expect(await (await call("GET", "/cli-accounts?fresh=1")).json()).toEqual({ clis: [{ id: "claude-code", accounts: [] }] });
    expect((await call("POST", "/cli-accounts", { cli: "claude-code", name: "team" })).status).toBe(200);
    expect((await call("POST", "/cli-accounts", { cli: "claude-code", name: "Bad" })).status).toBe(400);
    expect((await call("POST", "/cli-accounts", { cli: "cursor", name: "team" })).status).toBe(400);
    const used = await call("DELETE", "/cli-accounts/claude-code/team");
    expect(used.status).toBe(409);
    // The page's words, from the agents the refusal names; the CLI's stay as the domain said them (0.8.20).
    expect(await used.json()).toEqual({ error: "Coder uses it", plain: "Coder still uses this account. Move it to another one first." });
    expect((await call("POST", "/cli-accounts/claude-code/team/login")).status).toBe(200);
    expect((await call("POST", "/cli-accounts/claude-code/Team!/login")).status).toBe(400);
    expect((await call("GET", "/cli-accounts/claude-code/team/login")).status).toBe(200);
    expect((await call("POST", "/cli-accounts/claude-code/team/login/answer", { text: "CODE" })).status).toBe(200);
    expect((await call("POST", "/cli-accounts/claude-code/team/login/stop")).status).toBe(200);
    expect(seen).toEqual(["accounts 2 fresh", "add claude-code team", "add claude-code Bad", "remove claude-code team", "account login claude-code team by cli", "view @claude-code/team", "answer @claude-code/team CODE", "stop @claude-code/team"]);
  });

  test("an account's use is asked on its own, with every agent the account may have; not known is null, a CLI not here is refused", async () => {
    const { call, seen } = app();
    expect(await (await call("GET", "/cli-accounts/claude-code/team/use")).json()).toEqual({ use: { limits: [] }, at: 5 });
    expect(await (await call("GET", "/cli-accounts/codex/work/use")).json()).toEqual({ use: null, at: null });
    // Each agent signed in by itself: each one's own, the CLI's word said as such.
    expect(await (await call("GET", "/cli-accounts/codex/solo/use")).json()).toEqual({ use: null, at: null, agents: [{ id: "coder", use: { limits: [] }, at: 7, said: true }, { id: "nox", use: null, at: null }] });
    expect((await call("GET", "/cli-accounts/cursor/work/use")).status).toBe(404);
    // A name that is no account's is no folder's either: refused before anything is read.
    expect((await call("GET", "/cli-accounts/codex/..%2F..%2Fetc/use")).status).toBe(400);
    expect(seen).toEqual(["use claude-code team 2", "use codex work 2", "use codex solo 2"]);
  });

  test("an account added and removed is audited with who did it, and whether its token went — what failed is not (0.8.9)", async () => {
    // An account vanished from the page with its secret still kept, and nothing said who or what.
    const { call, audits } = app();
    expect((await call("POST", "/cli-accounts", { cli: "claude-code", name: "team" })).status).toBe(200);
    expect((await call("POST", "/cli-accounts", { cli: "claude-code", name: "Bad" })).status).toBe(400);
    expect((await call("DELETE", "/cli-accounts/claude-code/team")).status).toBe(409);
    expect((await call("DELETE", "/cli-accounts/claude-code/spare")).status).toBe(200);
    // Off the list, its token kept by a store that failed: written down and said, not lost with a thrown error.
    const stuck = await call("DELETE", "/cli-accounts/claude-code/stuck");
    expect(stuck.status).toBe(500);
    expect(((await stuck.json()) as { error: string }).error).toBe("stuck is removed, but its token stayed in the secret store: read-only file system");
    expect(audits).toEqual([
      { action: "cli_account_added", actor: "cli", details: { cli: "claude-code", account: "team" } },
      { action: "cli_account_removed", actor: "cli", details: { cli: "claude-code", account: "spare", tokenRemoved: true } },
      { action: "cli_account_removed", actor: "cli", details: { cli: "claude-code", account: "stuck", tokenRemoved: false, tokenError: "read-only file system" } },
    ]);
  });
});

describe("which CLI answers an agent that exists (0.8.1)", () => {
  test("one not installed here is refused before anything is written; none is the model again", async () => {
    const { call, seen } = app();
    const refused = await call("POST", "/agents/nouva/answered-by", { cli: "codex" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("Codex is not installed on this machine");
    expect((await call("POST", "/agents/coder/answered-by", { cli: null })).status).toBe(200);
    expect(seen).toEqual(["answered coder null"]);
  });
});

