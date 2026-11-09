/**
 * `GET` and `PUT /llm-gateway`: the switch the setup wizard and the LLM Gateway page turn (`routes/llm-gateway.ts`).
 *
 * What it must get right: an admin's alone; on answers once the gateway runs; off writes the setting and asks the one
 * restart there is, saying in the page's words what happens next, including when nothing would start Nouride again;
 * and the agents named that stop answering.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { LlmGatewaySwitched, LlmGatewayView } from "@nouride/wire";
import type { GatewayPort, TurnedOff, TurnedOn } from "@/boot/gateway-switch.ts";
import type { EmbeddedGateway } from "@/modules/gateways/nougate-inproc.ts";
import type { RestartOutcome, RestartRequest } from "@/modules/update/restart.ts";
import { registerLlmGatewayRoutes } from "@/modules/web/control/routes/llm-gateway.ts";

const PORT = 18256;

/** A switch that answers as told and records what it was asked. */
function gatewaySwitch(over: { carried?: boolean; running?: boolean; decidedBy?: "environment" | null; on?: TurnedOn; off?: TurnedOff } = {}) {
  const asked: string[] = [];
  const port: GatewayPort = {
    carried: over.carried ?? true,
    decidedBy: over.decidedBy ?? null,
    current: () => (over.running ? ({ url: `http://127.0.0.1:${PORT}` } as EmbeddedGateway) : null),
    credentialSharing: () => undefined,
    turnOn: async () => (asked.push("on"), over.on ?? { ok: true, started: true, saved: true }),
    turnOff: async () => (asked.push("off"), over.off ?? { ok: true, running: over.running ?? false }),
  };
  return { port, asked };
}

const agent = (id: string, provider: string, fallbacks: string[] = []) => ({
  config: { id, displayName: id[0]!.toUpperCase() + id.slice(1), llm: { provider, fallbacks: fallbacks.map((name) => ({ provider: name, model: "m" })) } },
});

function app(input: { role?: "admin" | "operator"; gateway?: GatewayPort; restart?: (request: RestartRequest) => RestartOutcome; restarts?: boolean } = {}) {
  const restarts: RestartRequest[] = [];
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role: input.role ?? "admin" });
    await next();
  });
  registerLlmGatewayRoutes(control as never, {
    ctx: { config: { nougate: { port: PORT } } },
    ...(input.gateway ? { llmGateway: input.gateway } : {}),
    providers: {
      available: () => [
        { name: "nougate", baseUrl: `http://127.0.0.1:${PORT}/openai/v1` },
        { name: "local-anthropic", baseUrl: `http://localhost:${PORT}/anthropic/v1` },
        { name: "openai", baseUrl: "https://api.openai.com/v1" },
        // Another gateway on this machine, at another port: not this one.
        { name: "other", baseUrl: "http://127.0.0.1:3000/openai/v1" },
      ],
    },
    registry: { all: () => [agent("nouva", "nougate"), agent("kuro", "openai", ["local-anthropic"]), agent("nix", "openai"), agent("nox", "other")] },
    supervisor: () => ({ kind: "systemd", restartsOnExit: input.restarts ?? true }),
    ...(input.restart
      ? { restart: { request: (request: RestartRequest) => (restarts.push(request), input.restart!(request)) } }
      : {}),
  } as never);
  const put = (body: unknown) => control.request("/llm-gateway", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { control, put, restarts };
}

describe("GET /llm-gateway", () => {
  test("whether it is carried and runs, who holds the switch, and the agents it would take away", async () => {
    const { control } = app({ gateway: gatewaySwitch({ running: true }).port });
    const view = (await (await control.request("/llm-gateway")).json()) as LlmGatewayView;
    expect(view).toEqual({
      carried: true,
      on: true,
      decidedBy: null,
      // Its own provider, or a fallback's, at this machine's gateway port, in either wire format.
      usedBy: [
        { id: "nouva", name: "Nouva" },
        { id: "kuro", name: "Kuro" },
      ],
      restarts: true,
    });
  });

  test("off, under the environment's hand, and on a server nothing restarts", async () => {
    const { control } = app({ gateway: gatewaySwitch({ decidedBy: "environment" }).port, restarts: false });
    expect(await (await control.request("/llm-gateway")).json()).toMatchObject({ carried: true, on: false, decidedBy: "environment", restarts: false });
  });

  test("a daemon with no gateway at all says it carries none", async () => {
    const { control } = app();
    expect(await (await control.request("/llm-gateway")).json()).toMatchObject({ carried: false, on: false, decidedBy: null });
  });

  test("an admin's alone: the gateway holds every upstream account", async () => {
    const { control } = app({ role: "operator", gateway: gatewaySwitch().port });
    expect((await control.request("/llm-gateway")).status).toBe(403);
  });
});

describe("PUT /llm-gateway, on", () => {
  test("answers once it runs, without a restart", async () => {
    const gateway = gatewaySwitch();
    const { put, restarts } = app({ gateway: gateway.port, restart: () => ({ ok: true, supervisor: "systemd", waiting: false, note: "" }) });
    const res = await put({ on: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as LlmGatewaySwitched).toEqual({ on: true, saved: true, plain: "Nougate is on." });
    expect(gateway.asked).toEqual(["on"]);
    expect(restarts).toEqual([]);
  });

  test("on but not saved says it is off again after a restart", async () => {
    const { put } = app({ gateway: gatewaySwitch({ on: { ok: true, started: true, saved: false, error: "read-only" } }).port });
    expect(await (await put({ on: true })).json()).toEqual({ on: true, saved: false, plain: "Nougate is on, but the setting was not saved, so it is off again after Nouride restarts." });
  });

  test("each refusal in the page's words, its own under them", async () => {
    const environment = app({ gateway: gatewaySwitch({ on: { ok: false, why: "environment", error: "NOUGATE_IN_PROCESS is set" } }).port });
    const res = await environment.put({ on: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "NOUGATE_IN_PROCESS is set", plain: "Whether Nougate runs is set on the server itself, so it cannot be changed here. Whoever runs the server can change it there." });

    const failed = app({ gateway: gatewaySwitch({ on: { ok: false, why: "failed", error: "port in use" } }).port });
    const no = await failed.put({ on: true });
    expect(no.status).toBe(500);
    expect(await no.json()).toEqual({ error: "port in use", plain: "Nougate did not start. Restart Nouride to try again." });
  });

  test("a build that does not carry it is refused before the switch is asked", async () => {
    const gateway = gatewaySwitch({ carried: false });
    const { put } = app({ gateway: gateway.port });
    const res = await put({ on: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ plain: "This version of Nouride does not include Nougate." });
    expect(gateway.asked).toEqual([]);
  });

  test("not an admin, or not a yes or no, is refused and nothing is switched", async () => {
    const gateway = gatewaySwitch();
    expect((await app({ role: "operator", gateway: gateway.port }).put({ on: true })).status).toBe(403);
    expect((await app({ gateway: gateway.port }).put({ on: "yes" })).status).toBe(400);
    expect(gateway.asked).toEqual([]);
  });
});

describe("PUT /llm-gateway, off", () => {
  test("writes it off, then asks for the restart that stops it, and says when", async () => {
    const gateway = gatewaySwitch({ running: true });
    const { put, restarts } = app({ gateway: gateway.port, restart: () => ({ ok: true, supervisor: "systemd", waiting: false, note: "restarting now: systemd is expected to start it again" }) });
    const res = await put({ on: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      on: true,
      saved: true,
      restart: { waiting: false, note: "restarting now: systemd is expected to start it again" },
      plain: "Nougate stops as Nouride restarts now.",
    });
    expect(gateway.asked).toEqual(["off"]);
    expect(restarts.map((request) => request.by)).toEqual(["gading"]);
  });

  test("while something runs, it says it waits for it", async () => {
    const waiting = app({ gateway: gatewaySwitch({ running: true }).port, restart: () => ({ ok: true, supervisor: "systemd", waiting: true, note: "n" }) });
    expect(await (await waiting.put({ on: false })).json()).toMatchObject({ restart: { waiting: true }, plain: "Nougate stops as Nouride restarts, as soon as nothing is running." });
    const jobs = app({ gateway: gatewaySwitch({ running: true }).port, restart: () => ({ ok: true, supervisor: "systemd", waiting: false, note: "n", waitingFor: "one background job" }) });
    expect(await (await jobs.put({ on: false })).json()).toMatchObject({ plain: "Nougate stops as Nouride restarts, once its background work is done." });
  });

  test("where nothing would start Nouride again, the setting is kept and the page says who restarts it", async () => {
    const { put } = app({
      gateway: gatewaySwitch({ running: true }).port,
      restart: () => ({ ok: false, error: "nothing would restart this daemon", why: "no-restarter", supervisor: "docker", note: "inside a container: use `docker restart <container>`" }),
    });
    const res = await put({ on: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      on: true,
      saved: true,
      note: "inside a container: use `docker restart <container>`",
      plain:
        "Saved. Nougate stops the next time Nouride starts: nothing on this server would start Nouride again by itself, so it was not restarted now. Whoever runs the server can restart it there.",
    });
  });

  test("already off: written, and no restart asked for nothing", async () => {
    const { put, restarts } = app({ gateway: gatewaySwitch({ running: false }).port, restart: () => ({ ok: true, supervisor: "systemd", waiting: false, note: "" }) });
    expect(await (await put({ on: false })).json()).toEqual({ on: false, saved: true, plain: "Nougate is off." });
    expect(restarts).toEqual([]);
  });

  test("not while the environment holds it, and not when the setting could not be written", async () => {
    const environment = app({ gateway: gatewaySwitch({ running: true, off: { ok: false, why: "environment", error: "e" } }).port, restart: () => ({ ok: true, supervisor: "systemd", waiting: false, note: "" }) });
    const held = await environment.put({ on: false });
    expect(held.status).toBe(409);
    expect(environment.restarts).toEqual([]);
    const unsaved = app({ gateway: gatewaySwitch({ running: true, off: { ok: false, why: "not-saved", error: "read-only" } }).port, restart: () => ({ ok: true, supervisor: "systemd", waiting: false, note: "" }) });
    const no = await unsaved.put({ on: false });
    expect(no.status).toBe(400);
    expect(await no.json()).toEqual({ error: "read-only", plain: "Nothing was saved. Check what you entered, and try again." });
    expect(unsaved.restarts).toEqual([]);
  });
});
