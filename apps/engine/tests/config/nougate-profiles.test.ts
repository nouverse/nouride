/**
 * The gateway a build carries as two provider profiles every new install has (`config/nougate-profiles.ts`): written at
 * a new install's first start with the gateway off, given their key once it runs, and said off, with no account, or
 * ready. An install that was there before keeps its profiles as they are.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "@nouride/shared";
import { SecretStore } from "@nouride/secrets";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { bundledOrigin, bundledState, keyBundledProfiles, nougateProfilesAtFirstStart, writeNougateProfiles } from "@/modules/config/nougate-profiles.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nr-nougate-profiles-"));
  configPath = join(dir, "config.toml");
  config = structuredClone(DEFAULT_CONFIG);
  config.providers = {};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A gateway that hands back a key it still holds, and mints one otherwise. */
function gateway(holds: string[] = []) {
  const asked: (string | null | undefined)[] = [];
  let minted = 0;
  return {
    asked,
    url: bundledOrigin(config),
    ensureHostKey: async (_name: string, current?: string | null) => {
      asked.push(current);
      if (current && holds.includes(current)) return { key: current, minted: false };
      minted += 1;
      return { key: `sk-nou-${minted}`, minted: true };
    },
  };
}

function store(held: Record<string, string> = {}) {
  const values = { ...held };
  return { values, resolve: (name: string) => values[name], set: async (name: string, value: string) => void (values[name] = value) };
}

describe("a new install's first start", () => {
  test("both profiles, on the gateway's loopback port, one secret between them, written with the gateway off", async () => {
    await nougateProfilesAtFirstStart({ newInstall: true, carried: true, configPath, config });
    const file = readFileSync(configPath, "utf8");
    expect(file).toContain('[providers.nougate-openai]\nkind = "openai"\nbase_url = "http://127.0.0.1:18256/openai/v1"\napi_key = "nougate_local_key"');
    expect(file).toContain('[providers.nougate-anthropic]\nkind = "anthropic"\nbase_url = "http://127.0.0.1:18256/anthropic/v1"\napi_key = "nougate_local_key"');
    // The gateway left as it was: off.
    expect(file).not.toContain("in_process");
    // And the running config has them, for the Models page now.
    expect(Object.keys(config.providers)).toEqual(["nougate-openai", "nougate-anthropic"]);
  });

  test("an install that was there before, or a build that carries no gateway, is given nothing", async () => {
    await nougateProfilesAtFirstStart({ newInstall: false, carried: true, configPath, config });
    await nougateProfilesAtFirstStart({ newInstall: true, carried: false, configPath, config });
    expect(() => readFileSync(configPath, "utf8")).toThrow();
    expect(config.providers).toEqual({});
  });

  test("a profile of either name already there is left as it was: another Nougate, the person's own", async () => {
    // The owner's box has a `nougate-anthropic` on a Nougate of its own, on another machine.
    writeFileSync(configPath, '[providers.nougate-anthropic]\nkind = "anthropic"\nbase_url = "http://10.0.0.6:3000/anthropic/v1"\napi_key = "theirs"\n');
    config.providers["nougate-anthropic"] = { kind: "anthropic", baseUrl: "http://10.0.0.6:3000/anthropic/v1", apiKeySecret: "theirs" };
    expect(await writeNougateProfiles({ configPath, config })).toEqual({ ok: true, written: ["nougate-openai"] });
    expect(readFileSync(configPath, "utf8")).toContain('base_url = "http://10.0.0.6:3000/anthropic/v1"\napi_key = "theirs"');
    expect(await writeNougateProfiles({ configPath, config })).toEqual({ ok: true, written: [] });
  });
});

describe("their key, once the gateway runs", () => {
  test("minted once into the one secret both name; a profile on another Nougate is not given it", async () => {
    await writeNougateProfiles({ configPath, config });
    config.providers.elsewhere = { kind: "openai", baseUrl: "http://10.0.0.6:3000/openai/v1", apiKeySecret: "elsewhere_key" };
    const running = gateway();
    const secrets = store();
    expect(await keyBundledProfiles({ config, gateway: running, secrets })).toEqual(["nougate_local_key"]);
    expect(secrets.values).toEqual({ nougate_local_key: "sk-nou-1" });
    expect(running.asked).toEqual([null]);
  });

  test("a key it still holds is kept, so a start with it on mints nothing new", async () => {
    await writeNougateProfiles({ configPath, config });
    const secrets = store({ nougate_local_key: "sk-nou-kept" });
    expect(await keyBundledProfiles({ config, gateway: gateway(["sk-nou-kept"]), secrets })).toEqual([]);
    expect(secrets.values.nougate_local_key).toBe("sk-nou-kept");
    // One it no longer holds (its database made anew) is replaced.
    expect(await keyBundledProfiles({ config, gateway: gateway(), secrets })).toEqual(["nougate_local_key"]);
    expect(secrets.values.nougate_local_key).toBe("sk-nou-1");
  });
});

describe("a key to another Nougate in the environment", () => {
  test("is not read as theirs: a start with the gateway on mints no new key each time", async () => {
    // `NOUGATE_API_KEY`, a key to a Nougate on another machine, was read in place of a secret named `nougate_api_key`,
    // refused by this gateway, and a new key minted at every start (seen on a fresh install with it set).
    await writeNougateProfiles({ configPath, config });
    const secrets = await SecretStore.open(join(dir, "data"), { NOUGATE_API_KEY: "sk-another-nougate" });
    const minted: string[] = [];
    const running = {
      url: bundledOrigin(config),
      ensureHostKey: async (_name: string, current?: string | null) => {
        if (current && minted.includes(current)) return { key: current, minted: false };
        minted.push(`sk-nou-${minted.length + 1}`);
        return { key: minted.at(-1)!, minted: true };
      },
    };
    await keyBundledProfiles({ config, gateway: running, secrets });
    expect(await keyBundledProfiles({ config, gateway: running, secrets })).toEqual([]);
    expect(minted).toEqual(["sk-nou-1"]);
  });
});

describe("where a profile on it stands", () => {
  const origin = "http://127.0.0.1:18256";
  test("off, on with no account, ready: by the gateway, never by the profile's name", () => {
    expect(bundledState(`${origin}/openai/v1`, { origin, running: null })).toBe("off");
    expect(bundledState(`${origin}/anthropic/v1`, { origin, running: { connectedModels: () => [] } })).toBe("no-account");
    expect(bundledState(`${origin}/openai/v1`, { origin, running: { connectedModels: () => ["codex:gpt-5.1"] } })).toBe("ready");
  });

  test("another endpoint, or a build that carries none, is not one", () => {
    expect(bundledState("http://10.0.0.6:3000/openai/v1", { origin, running: null })).toBeNull();
    expect(bundledState("http://127.0.0.1:18257/openai/v1", { origin, running: null })).toBeNull();
    expect(bundledState(`${origin}/openai/v1`, { origin: null, running: null })).toBeNull();
  });
});
