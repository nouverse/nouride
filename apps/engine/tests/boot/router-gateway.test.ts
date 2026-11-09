/**
 * A Router install keeps its LLM gateway on through the update to the Community build, which has it off until asked
 * (`boot/router-gateway.ts`). What decides it is on disk — the config file says nothing, and the gateway's database is
 * in its own folder — so each case is a folder laid out as a real install's.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlobalConfig } from "@nouride/shared";
import { keepRouterGatewayOn } from "@/boot/router-gateway.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { tempDir } from "../temp-dirs.ts";

/** An install as the Router build left it: `config.toml`, and the gateway's database where it keeps it. */
function install(configText: string, gateway: "database" | "empty" | "other-file" | "none" = "database", home?: string) {
  const root = tempDir("router-gateway");
  const dataDir = join(root, ".nouride", "data");
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(root, ".nouride", "config.toml");
  writeFileSync(configPath, configText);
  const gatewayData = join(home ?? join(root, ".nouride", "nougate"), "data");
  if (gateway !== "none") mkdirSync(gatewayData, { recursive: true });
  // Named by its kind, not the gateway's own filename: the engine names no file of the gateway's (`nougate-inproc.test.ts`).
  if (gateway === "database") writeFileSync(join(gatewayData, "gateway.db"), "");
  if (gateway === "other-file") writeFileSync(join(gatewayData, "config.json"), "{}");
  const config = structuredClone(DEFAULT_CONFIG) as GlobalConfig;
  config.daemon.dataDir = dataDir;
  return { configPath, config, root };
}

const ROUTER_CONFIG = `# my box
[daemon]
name = "rumah"   # the name on the Box

[providers.nougate]
kind = "openai"
base_url = "http://127.0.0.1:18256/openai/v1"
api_key = "nougate_api_key"
`;

const keep = (at: ReturnType<typeof install>, over: Partial<Parameters<typeof keepRouterGatewayOn>[0]> = {}) =>
  keepRouterGatewayOn({ configPath: at.configPath, config: at.config, carried: true, edition: "basic", env: {}, ...over });

describe("a former Router install, on the Community build", () => {
  test("has `in_process = true` written, the rest of its file as it was, and the gateway on for this boot", async () => {
    const at = install(ROUTER_CONFIG);
    expect(await keep(at)).toBe(true);
    const after = readFileSync(at.configPath, "utf8");
    // Everything the person wrote, byte for byte, then the one table added.
    expect(after.startsWith(ROUTER_CONFIG)).toBe(true);
    expect(after.slice(ROUTER_CONFIG.length).trim()).toBe("[nougate]\nin_process = true");
    expect(at.config.nougate.inProcess).toBe(true);
  });

  test("a [nougate] table of its own gets the key under it, its port kept", async () => {
    const at = install(`${ROUTER_CONFIG}\n[nougate]\nport = 18300\n`);
    expect(await keep(at)).toBe(true);
    const after = readFileSync(at.configPath, "utf8");
    expect(after).toContain("[nougate]\nport = 18300\nin_process = true\n");
    expect(at.config.nougate.inProcess).toBe(true);
  });

  test("written once: the second start finds the key and leaves the file alone", async () => {
    const at = install(ROUTER_CONFIG);
    await keep(at);
    const first = readFileSync(at.configPath, "utf8");
    expect(await keep(at)).toBe(false);
    expect(readFileSync(at.configPath, "utf8")).toBe(first);
  });

  test("an explicit `false` is what the person meant, and is kept", async () => {
    const text = `${ROUTER_CONFIG}\n[nougate]\nin_process = false\n`;
    const at = install(text);
    expect(await keep(at)).toBe(false);
    expect(readFileSync(at.configPath, "utf8")).toBe(text);
    expect(at.config.nougate.inProcess).toBe(false);
  });

  test("in any spelling of the key: a dotted one counts as said", async () => {
    const text = `nougate.in_process = false\n${ROUTER_CONFIG}`;
    const at = install(text);
    expect(await keep(at)).toBe(false);
    expect(readFileSync(at.configPath, "utf8")).toBe(text);
  });

  test("the gateway's folder where NOUGATE_HOME points it, not the default", async () => {
    const elsewhere = join(tempDir("router-gateway-home"), "gw");
    const at = install(ROUTER_CONFIG, "database", elsewhere);
    expect(await keep(at, { env: {} })).toBe(false);
    expect(await keep(at, { env: { NOUGATE_HOME: elsewhere } })).toBe(true);
  });
});

describe("left alone", () => {
  test("a Pro install: off without the key has meant off on Pro since the gateway came to Pro", async () => {
    const at = install(ROUTER_CONFIG);
    expect(await keep(at, { edition: "pro" })).toBe(false);
    expect(readFileSync(at.configPath, "utf8")).toBe(ROUTER_CONFIG);
    expect(at.config.nougate.inProcess).toBe(false);
  });

  test("a source checkout, which ran the gateway only when its file said so", async () => {
    const at = install(ROUTER_CONFIG);
    expect(await keep(at, { edition: "unknown" })).toBe(false);
    expect(readFileSync(at.configPath, "utf8")).toBe(ROUTER_CONFIG);
  });

  test("a build that does not carry the gateway, which would then refuse to start", async () => {
    const at = install(ROUTER_CONFIG);
    expect(await keep(at, { carried: false })).toBe(false);
    expect(readFileSync(at.configPath, "utf8")).toBe(ROUTER_CONFIG);
  });

  test("an install where the gateway never ran: no folder, an empty one, or one with no database", async () => {
    for (const gateway of ["none", "empty", "other-file"] as const) {
      const at = install(ROUTER_CONFIG, gateway);
      expect({ gateway, wrote: await keep(at) }).toEqual({ gateway, wrote: false });
      expect(readFileSync(at.configPath, "utf8")).toBe(ROUTER_CONFIG);
    }
  });
});
