/**
 * `GET /providers` says where each profile on the Nougate this build carries stands — off, on with no account signed
 * in there, ready — which the Models page marks it by and an agent's model picker reads before it offers one. Any other
 * profile says nothing of it.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerProviderRoutes } from "@/modules/web/control/routes/providers.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

const PROFILES = [
  { name: "nougate-openai", kind: "openai", baseUrl: "http://127.0.0.1:18256/openai/v1", apiKeySecret: "nougate_local_key", hasCredential: false, builtIn: false, headers: {} },
  { name: "elsewhere", kind: "openai", baseUrl: "http://10.0.0.6:3000/openai/v1", apiKeySecret: "elsewhere", hasCredential: true, builtIn: false, headers: {} },
];

async function listed(gateway: { carried: boolean; models?: string[] } | null): Promise<Record<string, unknown>[]> {
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "admin", role: "admin", user: { id: "usr_admin", username: "admin" } });
    await next();
  });
  const llmGateway = gateway && { carried: gateway.carried, current: () => (gateway.models ? { connectedModels: () => gateway.models! } : null) };
  registerProviderRoutes(control as never, { settings: { providerProfiles: () => PROFILES }, ctx: { config: DEFAULT_CONFIG }, ...(llmGateway ? { llmGateway } : {}) } as never);
  return ((await (await control.request("/providers")).json()) as { providers: Record<string, unknown>[] }).providers;
}

describe("a profile on the Nougate this build carries", () => {
  test("off, on with no account, then ready; another Nougate's profile says nothing", async () => {
    const off = await listed({ carried: true });
    expect(off.map((profile) => profile.bundled)).toEqual(["off", undefined]);
    expect((await listed({ carried: true, models: [] }))[0]!.bundled).toBe("no-account");
    expect((await listed({ carried: true, models: ["codex:gpt-5.1"] }))[0]!.bundled).toBe("ready");
  });

  test("a build that carries none, or a daemon with no gateway at all, says nothing of any profile", async () => {
    expect((await listed({ carried: false })).map((profile) => profile.bundled)).toEqual([undefined, undefined]);
    expect((await listed(null)).map((profile) => profile.bundled)).toEqual([undefined, undefined]);
  });
});
