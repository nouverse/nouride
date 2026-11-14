/**
 * A provider's extra headers through the routes its two forms post to (the Models page's and the first-run setup's):
 * what the form sent reaches the one writer as it was sent, a saved header's missing value as "keep it", and a
 * client that sends no `headers` at all is not read as one that sent none. What the writer does with them is
 * `config/settings-service.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { providerHeaders } from "@/modules/web/control/payloads.ts";
import { registerProviderRoutes } from "@/modules/web/control/routes/providers.ts";
import { registerSetupRoutes } from "@/modules/web/control/routes/setup.ts";

type Register = (control: never, deps: never) => void;

/** One route mounted alone, as an admin, with writers that record what they were handed. */
async function post(register: Register, path: string, body: unknown): Promise<{ status: number; handed: Record<string, unknown>[] }> {
  const handed: Record<string, unknown>[] = [];
  const take = async (input: Record<string, unknown>) => {
    handed.push(input);
    return { ok: true, restartRequired: false, models: [], secret: "x_api_key" };
  };
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "admin", role: "admin", user: { id: "usr_admin", username: "admin" } });
    await next();
  });
  register(control as never, { settings: { saveProvider: take }, setup: { saveProvider: take } } as never);
  const res = await control.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, handed };
}

describe("a provider's extra headers, as a form posts them", () => {
  test("each name with its value, and a name with none as one to keep", () => {
    expect(providerHeaders({ "x-opencode-session": "{session}", "x-gateway-key": null, "x-odd": 7 })).toEqual({ "x-opencode-session": "{session}", "x-gateway-key": null, "x-odd": null });
    expect(providerHeaders({})).toEqual({});
  });

  test("absent, or not that shape: not read as an empty set, which would remove every header the provider has", () => {
    for (const raw of [undefined, null, "x-a: 1", ["x-a"], 3]) expect(providerHeaders(raw)).toBeUndefined();
  });

  test("the Models page's save hands them to the writer; a save without the field hands none", async () => {
    const withHeaders = await post(registerProviderRoutes as Register, "/providers", { name: "go", kind: "openai", baseUrl: "https://go.test/v1", apiKey: "k", headers: { "x-opencode-session": "{session}", "x-kept": null } });
    expect(withHeaders.status).toBe(200);
    expect(withHeaders.handed[0]).toMatchObject({ name: "go", headers: { "x-opencode-session": "{session}", "x-kept": null } });

    const without = await post(registerProviderRoutes as Register, "/providers", { name: "go", kind: "openai", baseUrl: "https://go.test/v1", apiKey: "k" });
    expect(without.handed[0]).not.toHaveProperty("headers");
    // An empty set is a set: the form's way to say "none any more".
    const emptied = await post(registerProviderRoutes as Register, "/providers", { name: "go", kind: "openai", baseUrl: "https://go.test/v1", headers: {} });
    expect(emptied.handed[0]).toMatchObject({ headers: {} });
  });

  test("the setup's save hands them on the same way", async () => {
    const withHeaders = await post(registerSetupRoutes as Register, "/setup/provider", { kind: "openai", name: "opencode-go", base_url: "https://go.test/v1", api_key: "k", headers: { "x-opencode-session": "{session}" } });
    expect(withHeaders.status).toBe(200);
    expect(withHeaders.handed[0]).toMatchObject({ name: "opencode-go", baseUrl: "https://go.test/v1", headers: { "x-opencode-session": "{session}" } });
    const without = await post(registerSetupRoutes as Register, "/setup/provider", { kind: "openai", base_url: "https://go.test/v1", api_key: "k" });
    expect(without.handed[0]).not.toHaveProperty("headers");
  });
});
