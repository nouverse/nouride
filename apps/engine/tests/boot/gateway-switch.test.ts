/**
 * The LLM gateway's switch (`boot/gateway-switch.ts`): on after boot without a restart, once per process; the setting
 * written only once it answers; off written, for the restart that stops it; and nothing moved while the environment
 * holds it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlobalConfig } from "@nouride/shared";
import { gatewayDecision, type BundledGateway } from "@/boot/embedded-gateway.ts";
import { gatewaySaver, GatewaySwitch, type GatewaySwitchDeps } from "@/boot/gateway-switch.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import type { EmbeddedGateway } from "@/modules/gateways/nougate-inproc.ts";
import { tempDir } from "../temp-dirs.ts";

/** A gateway that records being stopped, and a start that counts its calls. */
function harness(over: Partial<GatewaySwitchDeps> & { fail?: string } = {}) {
  const calls = { start: 0, stop: 0, saved: [] as boolean[] };
  const gateway = { url: "http://127.0.0.1:18256", stop: async () => void (calls.stop += 1) } as unknown as EmbeddedGateway;
  const sw = new GatewaySwitch({
    carried: true,
    decidedBy: null,
    start: async (): Promise<BundledGateway> => {
      calls.start += 1;
      // Not settled at once, so a second caller can arrive while it runs.
      await Promise.resolve();
      if (over.fail) throw new Error(over.fail);
      return { gateway, credentialSharing: "environment" };
    },
    save: async (on) => {
      calls.saved.push(on);
      return { ok: true };
    },
    ...over,
  });
  return { sw, calls, gateway };
}

describe("turned on after boot", () => {
  test("starts it, then writes the setting, and it is the gateway every reader gets from then on", async () => {
    const { sw, calls, gateway } = harness();
    expect(sw.current()).toBeNull();
    expect(await sw.turnOn("admin")).toEqual({ ok: true, started: true, saved: true });
    expect(sw.current()).toBe(gateway);
    expect(sw.credentialSharing()).toBe("environment");
    expect(calls).toMatchObject({ start: 1, saved: [true] });
  });

  test("once per process: a second press, or two at once, starts nothing more", async () => {
    // The gateway registers its providers as it boots, and a second boot in one process registers each twice.
    const { sw, calls } = harness();
    const [a, b] = await Promise.all([sw.turnOn("admin"), sw.turnOn("admin")]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(await sw.turnOn("admin")).toEqual({ ok: true, started: false, saved: true });
    expect(calls.start).toBe(1);
  });

  test("a gateway that does not start is not written as on, and is not tried again until a restart", async () => {
    // Written first, a gateway that then failed to start would fail the next boot too.
    const { sw, calls } = harness({ fail: "port 18256 is in use" });
    const first = await sw.turnOn("admin");
    expect(first).toMatchObject({ ok: false, why: "failed" });
    expect(first.ok === false && first.error).toContain("port 18256 is in use");
    expect(calls.saved).toEqual([]);
    const again = await sw.turnOn("admin");
    expect(again).toMatchObject({ ok: false, why: "failed" });
    expect(again.ok === false && again.error).toContain("only after a restart");
    expect(calls.start).toBe(1);
    expect(sw.current()).toBeNull();
  });

  test("on while the environment says off is refused, and nothing is started or written", async () => {
    const { sw, calls } = harness({ decidedBy: "environment" });
    expect(await sw.turnOn("admin")).toMatchObject({ ok: false, why: "environment" });
    expect(calls).toMatchObject({ start: 0, saved: [] });
  });

  test("a build that does not carry it is refused, not started into an import that fails", async () => {
    const { sw, calls } = harness({ carried: false });
    expect(await sw.turnOn("admin")).toMatchObject({ ok: false, why: "not-carried" });
    expect(calls.start).toBe(0);
  });

  test("a setting that could not be written still leaves it on, and says it is off again after a restart", async () => {
    const { sw } = harness({ save: async () => ({ ok: false, error: "read-only file system" }) });
    expect(await sw.turnOn("admin")).toEqual({ ok: true, started: true, saved: false, error: "read-only file system" });
    expect(sw.current()).not.toBeNull();
  });
});

describe("turned off", () => {
  test("writes it off and says it still runs, for the restart that stops it", async () => {
    const { sw, calls } = harness();
    await sw.turnOn("admin");
    expect(await sw.turnOff("admin")).toEqual({ ok: true, running: true });
    expect(calls.saved).toEqual([true, false]);
  });

  test("while off, writes it off and says nothing runs", async () => {
    const { sw, calls } = harness();
    expect(await sw.turnOff("admin")).toEqual({ ok: true, running: false });
    expect(calls.saved).toEqual([false]);
  });

  test("not while the environment holds it", async () => {
    const { sw, calls } = harness({ decidedBy: "environment" });
    await sw.boot(true);
    expect(await sw.turnOff("admin")).toMatchObject({ ok: false, why: "environment" });
    expect(calls.saved).toEqual([]);
  });

  test("a setting that could not be written is said, and no restart follows it", async () => {
    const { sw } = harness({ save: async () => ({ ok: false, error: "read-only file system" }) });
    expect(await sw.turnOff("admin")).toEqual({ ok: false, why: "not-saved", error: "read-only file system" });
  });
});

describe("at boot and at shutdown", () => {
  test("boot starts it only when asked, and through the same one start", async () => {
    const off = harness();
    expect(await off.sw.boot(false)).toEqual({});
    expect(off.calls.start).toBe(0);
    const on = harness();
    await on.sw.boot(true);
    expect(await on.sw.turnOn("admin")).toEqual({ ok: true, started: false, saved: true });
    expect(on.calls.start).toBe(1);
  });

  test("a boot whose gateway does not start fails, as it always did", async () => {
    const { sw } = harness({ fail: "this build does not carry the gateway" });
    await expect(sw.boot(true)).rejects.toThrow("does not carry the gateway");
  });

  test("shutdown stops the gateway turned on after boot", async () => {
    const { sw, calls } = harness();
    await sw.stop();
    expect(calls.stop).toBe(0);
    await sw.turnOn("admin");
    await sw.stop();
    expect(calls.stop).toBe(1);
  });
});

describe("who decides", () => {
  const config = (inProcess: boolean) => ({ nougate: { inProcess, port: 18256 } }) as unknown as GlobalConfig;

  test("the file, while the environment says nothing", () => {
    expect(gatewayDecision(config(true), {})).toEqual({ on: true, decidedBy: null });
    expect(gatewayDecision(config(false), {})).toEqual({ on: false, decidedBy: null });
  });

  test("NOUGATE_IN_PROCESS over the file, either way, and then the dashboard cannot move it", () => {
    expect(gatewayDecision(config(false), { NOUGATE_IN_PROCESS: "1" })).toEqual({ on: true, decidedBy: "environment" });
    expect(gatewayDecision(config(false), { NOUGATE_IN_PROCESS: "true" })).toEqual({ on: true, decidedBy: "environment" });
    expect(gatewayDecision(config(true), { NOUGATE_IN_PROCESS: "0" })).toEqual({ on: false, decidedBy: "environment" });
  });
});

describe("the setting, written", () => {
  test("into config.toml with the rest of the file as it was, the running config following, and the switch audited", async () => {
    const dir = tempDir("gateway-switch");
    const configPath = join(dir, "config.toml");
    const text = '# mine\n[daemon]\nname = "rumah"\n';
    writeFileSync(configPath, text);
    const live = structuredClone(DEFAULT_CONFIG) as GlobalConfig;
    live.daemon.dataDir = join(dir, "data");
    const audited: unknown[] = [];
    const save = gatewaySaver({ config: live, configPath, audit: { record: (entry) => void audited.push(entry) } });

    expect(await save(true, "admin")).toEqual({ ok: true });
    expect(readFileSync(configPath, "utf8")).toBe(`${text}\n[nougate]\nin_process = true\n`);
    expect(live.nougate.inProcess).toBe(true);

    expect(await save(false, "admin")).toEqual({ ok: true });
    expect(readFileSync(configPath, "utf8")).toBe(`${text}\n[nougate]\nin_process = false\n`);
    expect(live.nougate.inProcess).toBe(false);
    expect(audited).toEqual([
      { action: "llm_gateway_switched", actor: "admin", details: { on: true } },
      { action: "llm_gateway_switched", actor: "admin", details: { on: false } },
    ]);
  });
});
