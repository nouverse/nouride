/**
 * A save turned down for one field of its form names that field on the page (0.8.23), in the words the page uses for
 * it: "Nothing was saved. Check the connection's name, and try again." A form of several fields said "check what you
 * entered", and left the person to guess which. The route's own `error` stays what the CLI prints.
 *
 * Each route here is mounted alone and handed writers that refuse, naming the field asked for; where a refusal names
 * none (a file that would not load, a race), the words stay the generic ones. That the words pass the dashboard's rule is
 * `contracts/plain-replies.test.ts`; which field each writer names is the writers' own tests.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { TITLE_MAX } from "@/modules/memory/index.ts";
import { CronValidationError } from "@/modules/cron/validate.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { registerAccessRoutes } from "@/modules/web/control/routes/access.ts";
import { registerAgentRoutes } from "@/modules/web/control/routes/agents.ts";
import { registerAgentToolRoutes } from "@/modules/web/control/routes/agent-tools.ts";
import { registerCronRoutes } from "@/modules/web/control/routes/cron.ts";
import { registerDelegateRoutes } from "@/modules/web/control/routes/delegate.ts";
import { registerDiagnosticRoutes } from "@/modules/web/control/routes/diagnostics.ts";
import { registerDraftRoutes } from "@/modules/web/control/routes/drafts.ts";
import { registerExternalAgentRoutes } from "@/modules/web/control/routes/external-agents.ts";
import { registerGatewayRoutes } from "@/modules/web/control/routes/gateways.ts";
import { registerJobQuietRoutes } from "@/modules/web/control/routes/job-quiet.ts";
import { registerKnowledgeRoutes } from "@/modules/web/control/routes/knowledge.ts";
import { registerMcpRoutes } from "@/modules/web/control/routes/mcp.ts";
import { registerMemoryRoutes } from "@/modules/web/control/routes/memory.ts";
import { registerMentionRoutes } from "@/modules/web/control/routes/mentions.ts";
import { registerMissionSettingsRoutes } from "@/modules/web/control/routes/mission-settings.ts";
import { registerPeopleRoutes } from "@/modules/web/control/routes/people.ts";
import { registerPolicyRoutes } from "@/modules/web/control/routes/policy.ts";
import { registerProviderRoutes } from "@/modules/web/control/routes/providers.ts";
import { registerSecretRoutes } from "@/modules/web/control/routes/secrets.ts";
import { registerTierRoutes } from "@/modules/web/control/routes/tiers.ts";
import { registerWebSearchRoutes } from "@/modules/web/control/routes/web-search.ts";

type Register = (control: never, deps: never) => void;

/** The field the writers name in their refusal, for the case being run; undefined for none. */
let naming: string | undefined;

const refusal = () => ({ ok: false, error: "the writer's own words, for the CLI", ...(naming ? { field: naming } : {}) });
const refuse = async () => refusal();
const thrown = () => {
  throw new CronValidationError("the scheduler's own words", naming as never);
};

/** One daemon cut down to what these routes reach: every writer refuses, every agent is there. */
function daemon(): Record<string, unknown> {
  const settings = new Proxy({ webSearchSettings: () => ({ effective: "free" }), modelTiers: () => ({}) }, {
    get: (fakes, name) => (name in fakes ? fakes[name as keyof typeof fakes] : refuse),
  });
  return {
    ctx: { config: structuredClone(DEFAULT_CONFIG) },
    settings,
    files: {},
    setup: { setLook: refuse, setAnsweredBy: refuse },
    memory: { knowledge: { enabled: () => true } },
    cron: { timezone: "UTC", store: { create: thrown, update: thrown, get: () => ({ id: "cron_1" }) } },
    registry: {
      get: (id: string) => ({ dir: `/packs/${id}`, config: { id, mcp: {}, tools: { enabled: [] } } }),
      all: () => [],
      enabled: () => [],
      active: () => [],
      reload: async () => {},
    },
    audit: { record: () => {} },
  };
}

async function send(register: Register, method: string, path: string, body: unknown): Promise<{ status: number; error?: string; plain?: string }> {
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "admin", role: "admin", user: { id: "usr_admin", username: "admin" } });
    await next();
  });
  register(control as never, daemon() as never);
  const res = await control.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, ...((await res.json()) as { error?: string; plain?: string }) };
}

const said = (what: string) => `Nothing was saved. Check ${what}, and try again.`;
const GENERIC = "Nothing was saved. Check what you entered, and try again.";

/** A route, a body it takes to its writer, and a field the writer may name with the words the page uses for it. */
const FORMS: [string, Register, string, string, unknown, string, string][] = [
  ["the install's model tiers", registerTierRoutes as Register, "POST", "/llm/tiers", { passModel: "m" }, "passModel", "the model for the nightly memory pass"],
  ["an agent's own pair of tiers", registerTierRoutes as Register, "POST", "/agents/nix/tiers", { small: "m" }, "smallModel", "the small model"],
  ["a connector in the library", registerMcpRoutes as Register, "POST", "/mcp/library", { name: "gh", transport: "stdio", command: "npx" }, "command", "the program it starts"],
  ["an agent's word on a connector", registerMcpRoutes as Register, "PUT", "/agents/nix/mcp/gh", { tools: [" "] }, "tools", "the tools"],
  ["a connector added for an agent", registerMcpRoutes as Register, "POST", "/agents/nix/mcp", { name: "gh", transport: "streamable-http", url: "x" }, "url", "the connector's address"],
  ["web search", registerWebSearchRoutes as Register, "POST", "/web-search", { mode: "searxng" }, "endpoint", "the address"],
  ["a provider", registerProviderRoutes as Register, "POST", "/providers", { name: "x", kind: "openai", baseUrl: "https://x" }, "apiKey", "the API key"],
  ["skill learning", registerDraftRoutes as Register, "POST", "/skills/learning", { mode: "always" }, "mode", "what an agent may do with what it learns"],
  ["a connection", registerGatewayRoutes as Register, "POST", "/gateways", { platform: "telegram", name: "my bot" }, "name", "the connection's name"],
  ["a person", registerPeopleRoutes as Register, "POST", "/people", { name: "Sam", key: "Sam" }, "key", "the person key"],
  ["a person's morning line", registerPeopleRoutes as Register, "POST", "/people/sam/morning", { at: "07:00", to: "telegram:9" }, "to", "where the morning line goes"],
  ["a secret", registerSecretRoutes as Register, "PUT", "/secrets/github", { value: "v" }, "fields", "the details"],
  ["a secret's details", registerSecretRoutes as Register, "PATCH", "/secrets/github/fields", { set: { a: "b" } }, "fields", "the details"],
  ["the missions' limits", registerMissionSettingsRoutes as Register, "POST", "/policy/missions", { limitHours: 0.1 }, "limitHours", "the hours limit"],
  ["a scheduled job", registerCronRoutes as Register, "POST", "/cron", { agentId: "nix", name: "x", every: "5m", payload: { kind: "systemEvent", text: "hi" } }, "schedule", "when it runs"],
  ["a scheduled job, changed", registerCronRoutes as Register, "POST", "/cron/cron_1", { name: "x" }, "name", "the name"],
  ["a webhook", registerCronRoutes as Register, "POST", "/webhooks", { agentId: "nix", name: "x", payload: { kind: "agentTurn", message: " " } }, "message", "what to ask the agent"],
  ["memory's settings", registerMemoryRoutes as Register, "PUT", "/memory/settings", { passAt: "25:00" }, "passAt", "the time of the nightly pass"],
  ["an agent's look", registerAgentToolRoutes as Register, "POST", "/agents/nix/look", { hat: "crown" }, "hat", "the hat"],
  ["an agent's model", registerAgentRoutes as Register, "POST", "/agents/nix/model", { provider: "ghost", model: "m" }, "provider", "the provider"],
  ["who answers an agent", registerExternalAgentRoutes as Register, "POST", "/agents/nix/answered-by", { cli: null }, "cli", "who answers it"],
];

/** A route whose form has one field: named whatever the writer said, as there is no other to have meant. */
const ONE_FIELD: [string, Register, string, string, unknown, string][] = [
  ["the quiet-job wait", registerJobQuietRoutes as Register, "POST", "/policy/job-quiet", { minutes: 5 }, "the minutes for quiet background jobs"],
  ["an agent's quiet-job wait", registerJobQuietRoutes as Register, "POST", "/agents/nix/job-quiet", { minutes: 5 }, "the minutes for quiet background jobs"],
  ["the spend cap", registerPolicyRoutes as Register, "POST", "/policy/spend", { maxDailyCostUsd: 5 }, "the daily spend cap"],
  ["the tool budget", registerPolicyRoutes as Register, "POST", "/policy/tool-iterations", { maxToolIterations: 5 }, "the tool budget"],
  ["the turn budget", registerPolicyRoutes as Register, "POST", "/policy/turn-seconds", { turnSeconds: 60 }, "the turn budget"],
  ["an agent's helpers in the background", registerDelegateRoutes as Register, "POST", "/agents/nix/delegate", { maxBackground: 2 }, "the number of helpers in the background"],
  ["an agent's missions at once", registerMissionSettingsRoutes as Register, "POST", "/agents/nix/missions", { perAgent: 2 }, "the number of missions at once"],
  ["the group context", registerAccessRoutes as Register, "POST", "/group-context", { messages: 5 }, "the number of messages replayed"],
  ["a retention window", registerDiagnosticRoutes as Register, "PUT", "/retention/log", { days: 5 }, "the number of days"],
  ["the hop limit", registerMentionRoutes as Register, "POST", "/mentions", { mentionMaxHops: 3 }, "the hop limit"],
  ["an agent's fallbacks", registerAgentRoutes as Register, "POST", "/agents/nix/fallbacks", { fallbacks: [] }, "the fallbacks"],
  ["an agent's turn budget", registerAgentRoutes as Register, "POST", "/agents/nix/turn-seconds", { turnSeconds: 60 }, "the turn budget"],
  ["an agent's tool budget", registerAgentRoutes as Register, "POST", "/agents/nix/tool-iterations", { maxToolIterations: 5 }, "the tool budget"],
  ["a document's title", registerKnowledgeRoutes as Register, "PATCH", "/knowledge/legal/documents?path=a.md", { title: "x".repeat(TITLE_MAX + 1) }, "the title"],
];

describe("a save refused for one field names it, in the page's words", () => {
  for (const [what, register, method, path, body, field, words] of FORMS) {
    test(`${what}: ${field} is "${words}"; no field, what was entered`, async () => {
      naming = field;
      const named = await send(register, method, path, body);
      expect(named.status).toBe(400);
      expect(named.plain).toBe(said(words));
      naming = undefined;
      expect((await send(register, method, path, body)).plain).toBe(GENERIC);
    });
  }

  for (const [what, register, method, path, body, words] of ONE_FIELD) {
    test(`${what}: its one field, "${words}"`, async () => {
      naming = undefined;
      const refused = await send(register, method, path, body);
      expect(refused.status).toBe(400);
      expect(refused.plain).toBe(said(words));
    });
  }

  test("the CLI's words are the route's own, beside them", async () => {
    naming = "name";
    expect(await send(registerGatewayRoutes as Register, "POST", "/gateways", { platform: "telegram", name: "my bot" })).toEqual({
      status: 400,
      error: "the writer's own words, for the CLI",
      plain: said("the connection's name"),
    });
  });
});
