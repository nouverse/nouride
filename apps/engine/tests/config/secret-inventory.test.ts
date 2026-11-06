/**
 * What the Secrets screen is allowed to know.
 *
 * Two properties, and the first is the one that matters: **no value ever leaves this function.** The
 * store exists so a config file can name a credential instead of holding one, and an inventory that
 * returned values would hand every authenticated caller — the dashboard, the CLI, and through the CLI
 * an agent — every token on the box in one request.
 *
 * The second is why the screen is worth having at all. A list of names answers "what is stored"; the
 * question somebody arrives with is "is the Discord token for Nox set" — and a name cannot answer
 * that, because the name is whatever was typed into `config.toml` a year ago.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseToml } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { deleteSecret, secretInventory, setSecret } from "@/modules/config/settings/secrets.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";

let dir: string;
let config: GlobalConfig;

beforeEach(() => {
  dir = join(tmpdir(), `nouride-secret-inventory-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = dir;
  config.gateways = [];
  config.providers = {};
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The inventory over one store and one config. `env` stands in for the process environment. */
async function inventory(env: Record<string, string | undefined> = {}) {
  const secrets = await SecretStore.open(dir, env);
  return {
    secrets,
    list: () => secretInventory({ config, secrets } as unknown as SettingsDeps),
  };
}

describe("what it reports", () => {
  test("a stored credential, without its value", async () => {
    const { secrets, list } = await inventory();
    await secrets.set("nougate", "sk-this-must-never-come-back");

    const entries = list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "nougate", origin: "store" });
    // The property the whole design rests on, asserted on the serialized shape rather than on a
    // field name — a value added under any key would fail this.
    expect(JSON.stringify(entries)).not.toContain("sk-this-must-never-come-back");
  });

  test("names what each credential is for", async () => {
    // The name is whatever somebody typed into the config; this is what makes it identifiable.
    config.providers = { nougate: { apiKeySecret: "gate-key" } as never };
    config.gateways = [
      { id: "discord:nox", tokenSecret: "discord_nox_token" } as never,
      { id: "whatsapp:nouva", tokenSecret: "wa", encryptionKeySecret: "wa_session" } as never,
    ];

    const { list } = await inventory();
    const by = Object.fromEntries(list().map((entry) => [entry.name, entry.usedBy]));

    expect(by["gate-key"]).toEqual(["provider nougate"]);
    expect(by["discord_nox_token"]).toEqual(["gateway discord:nox"]);
    expect(by["wa_session"]).toEqual(["gateway whatsapp:nouva (session encryption)"]);
  });

  test("one credential used by two things lists both", async () => {
    config.gateways = [
      { id: "discord:nox", tokenSecret: "shared" } as never,
      { id: "discord:nero", tokenSecret: "shared" } as never,
    ];

    const { list } = await inventory();
    expect(list()[0]?.usedBy).toEqual(["gateway discord:nox", "gateway discord:nero"]);
  });
});

describe("what is missing", () => {
  test("a name the config references and nobody sets", async () => {
    /**
     * The entry an operator most needs and the one a store-only listing cannot produce. A missing
     * credential surfaces as a gateway that will not connect, hours later, saying nothing about
     * which secret is absent.
     */
    config.gateways = [{ id: "discord:nox", tokenSecret: "discord_nox_token" } as never];

    const { list } = await inventory();
    expect(list()).toEqual([
      { name: "discord_nox_token", origin: "missing", usedBy: ["gateway discord:nox"], shadowed: false, fields: {} },
    ]);
  });

  test("a stored credential nothing refers to is still listed, with nothing to show for it", async () => {
    // A leftover, or a name that does not match the config — and the second is a typo that looks
    // exactly like a working setup until something tries to authenticate.
    const { secrets, list } = await inventory();
    await secrets.set("orphan", "v");

    expect(list()[0]).toMatchObject({ name: "orphan", origin: "store", usedBy: [] });
  });
});

describe("when the environment wins", () => {
  test("a name provided only by the environment reports it", async () => {
    config.providers = { nougate: { apiKeySecret: "nougate" } as never };

    const { list } = await inventory({ NOUGATE: "from-the-deployment" });
    expect(list()[0]).toMatchObject({ name: "nougate", origin: "env", shadowed: false });
  });

  test("stored *and* in the environment is flagged, because the stored value does nothing", async () => {
    /**
     * The afternoon this saves. Resolution reads the environment first, so storing a value under a
     * shadowed name succeeds and changes nothing — a silent no-op indistinguishable from the new
     * value simply not working.
     */
    const { secrets, list } = await inventory({ NOUGATE: "from-the-deployment" });
    await secrets.set("nougate", "from-the-dashboard");

    expect(list()[0]).toMatchObject({ name: "nougate", origin: "env", shadowed: true });
  });

  test("the prefixed spelling counts too", async () => {
    // `NOURIDE_SECRET_NOUGATE` exists for names generic enough to collide with something else in the
    // environment, and it shadows exactly as the bare form does.
    const { secrets, list } = await inventory({ NOURIDE_SECRET_NOUGATE: "x" });
    await secrets.set("nougate", "y");

    expect(list()[0]).toMatchObject({ origin: "env", shadowed: true });
  });
});

describe("storing and removing one", () => {
  // What an agent's `nouride secret set` reaches. Nothing tested either refusal: both could be deleted with the suite green.
  test("a blank name or an empty value is refused, and nothing is stored", async () => {
    const { secrets } = await inventory();
    const deps = { config, secrets } as unknown as SettingsDeps;
    expect(await setSecret(deps, { name: "   ", value: "v" })).toEqual({ ok: false, error: "secret name is required" });
    expect(await setSecret(deps, { name: "token", value: "" })).toEqual({ ok: false, error: "a secret with no value is not a secret" });
    expect(secrets.inventory()).toEqual([]);
  });

  test("a name is trimmed both ways, so what was stored can be removed by the name it was typed with", async () => {
    const { secrets } = await inventory();
    const deps = { config, secrets } as unknown as SettingsDeps;
    expect(await setSecret(deps, { name: " token ", value: "v" })).toMatchObject({ ok: true });
    expect(secrets.resolve("token")).toBe("v");
    expect(await deleteSecret(deps, { name: "token " })).toBe(true);
    expect(secrets.resolve("token")).toBeUndefined();
  });
});

describe("an agent's commands", () => {
  /** Packs on disk, as the daemon's registry hands them over: where each is, how it reloads, the names it hands its commands. */
  function packs(files: Record<string, string>) {
    const reloads: string[] = [];
    const list = Object.entries(files).map(([agentId, text]) => {
      const configPath = join(dir, `${agentId}.toml`);
      writeFileSync(configPath, text);
      return {
        agentId,
        configPath,
        reload: async () => void reloads.push(agentId),
        secrets: () => {
          const security = parseToml<{ security?: { exec_secrets?: unknown } }>(readFileSync(configPath, "utf8")).security;
          return Object.keys((security?.exec_secrets as object | undefined) ?? {});
        },
      };
    });
    return {
      reloads,
      read: (agentId: string) => readFileSync(join(dir, `${agentId}.toml`), "utf8"),
      deps: (secrets: SecretStore) =>
        ({ config, secrets, packs: () => list.map((pack) => ({ ...pack, secrets: pack.secrets() })) }) as unknown as SettingsDeps,
    };
  }

  test("are listed among what uses a secret — and one they name that is not set shows as missing", async () => {
    const { secrets } = await inventory();
    await secrets.set("github_token", "ghp_x");
    const { deps } = packs({ nouva: `[security.exec_secrets]\nstirling_api_key = ["*"]\ngithub_token = ["gh"]\n` });
    expect(secretInventory(deps(secrets))).toEqual([
      { name: "github_token", origin: "store", usedBy: ["agent nouva's commands"], shadowed: false, fields: {}, addedAt: expect.any(String) },
      { name: "stirling_api_key", origin: "missing", usedBy: ["agent nouva's commands"], shadowed: false, fields: {} },
    ]);
  });

  test("lose it when it is deleted — the rest of each pack kept, each agent that named it reloaded", async () => {
    const { secrets } = await inventory();
    await secrets.set("stirling_api_key", "s3cr3t-value-1");
    const { deps, read, reloads } = packs({
      nouva: `[agent]\nname = "Nouva"\n\n[security]\nsecret_guard = false\n\n[security.exec_secrets]\nstirling_api_key = ["*"]\ngithub_token = ["gh"]\n`,
      nix: `[security.exec_secrets]\nstirling_api_key = ["curl"]\npypi_token = ["twine upload"]\n`,
      nero: `[security.exec_secrets]\ngithub_token = ["gh"]\n`,
    });
    expect(await deleteSecret(deps(secrets), { name: "stirling_api_key" })).toBe(true);
    expect(read("nouva")).toBe(`[agent]\nname = "Nouva"\n\n[security]\nsecret_guard = false\n\n[security.exec_secrets]\ngithub_token = ["gh"]\n`);
    expect(read("nix")).toBe(`[security.exec_secrets]\npypi_token = ["twine upload"]\n`);
    expect(read("nero")).toBe(`[security.exec_secrets]\ngithub_token = ["gh"]\n`);
    expect(reloads.sort()).toEqual(["nix", "nouva"]);
    expect(secrets.resolve("stirling_api_key")).toBeUndefined();
  });

  test("a name only a pack still names — deleted by hand from the store — is taken out of it by a delete too", async () => {
    const { secrets } = await inventory();
    const { deps, read } = packs({ nouva: `[security.exec_secrets]\nstirling_api_key = ["*"]\ngithub_token = ["gh"]\n` });
    expect(await deleteSecret(deps(secrets), { name: "stirling_api_key" })).toBe(true);
    expect(read("nouva")).toBe(`[security.exec_secrets]\ngithub_token = ["gh"]\n`);
  });

  test("keep it while the environment still sets it: only the stored copy goes", async () => {
    const { secrets } = await inventory({ STIRLING_API_KEY: "from-the-deployment" });
    await secrets.set("stirling_api_key", "stored-copy-1");
    const { deps, read, reloads } = packs({ nouva: `[security.exec_secrets]\nstirling_api_key = ["*"]\n` });
    expect(await deleteSecret(deps(secrets), { name: "stirling_api_key" })).toBe(true);
    expect(read("nouva")).toBe(`[security.exec_secrets]\nstirling_api_key = ["*"]\n`);
    expect(reloads).toEqual([]);
  });
});
