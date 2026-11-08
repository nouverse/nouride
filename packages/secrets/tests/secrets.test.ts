import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFileIfExists, removePath, writeTextFile } from "@nouride/runtime";
import { assertSecretName, envNamesFor, SecretError, SecretStore } from "../src/index.ts";

let dir: string;

/** What the store holds on disk, read by a store of its own: names and values. */
async function onDisk(): Promise<Record<string, string>> {
  return JSON.parse((await SecretStore.open(dir, {})).plainCopy()) as Record<string, string>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-secrets-"));
});

afterEach(() => {
  removePath(dir);
});

describe("assertSecretName", () => {
  test("accepts ordinary names", () => {
    for (const name of ["nougate", "telegram-nouva", "openai_main", "k2"]) {
      expect(() => assertSecretName(name, "test")).not.toThrow();
    }
  });

  test.each([
    // Shapes only — never a fragment of a real credential, even a truncated one.
    ["an OpenAI-style key", "sk-EXAMPLE-not-a-real-key-000000"],
    ["a Slack token", "xoxb-123456789012-abcdef"],
    ["a GitHub token", "ghp_abcdefghijklmnopqrst"],
    ["a bearer header", "Bearer abc123"],
    ["a Telegram bot token", "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678"],
  ])("refuses %s pasted where a name goes", (_label, value) => {
    // The failure this prevents: a real key committed inside config.toml, where it still
    // "works" and nobody notices until they read the file.
    expect(() => assertSecretName(value, "[providers.x] api_key")).toThrow(
      /looks like a credential, not a name/,
    );
  });

  test("refuses names with spaces or exotic characters", () => {
    expect(() => assertSecretName("my key", "test")).toThrow(/not a valid secret name/);
    expect(() => assertSecretName("key!", "test")).toThrow(/not a valid secret name/);
  });
});

describe("envNamesFor", () => {
  test("maps a name to its environment variables", () => {
    expect(envNamesFor("nougate")).toEqual(["NOUGATE", "NOURIDE_SECRET_NOUGATE"]);
    expect(envNamesFor("telegram-nouva")).toEqual([
      "TELEGRAM_NOUVA",
      "NOURIDE_SECRET_TELEGRAM_NOUVA",
    ]);
  });
});

describe("SecretStore resolution", () => {
  test("resolves from the environment", async () => {
    const store = await SecretStore.open(dir, { NOUGATE: "from-env" });
    expect(store.resolve("nougate")).toBe("from-env");
    expect(store.origin("nougate")).toBe("env");
  });

  test("resolves from the prefixed environment variable", async () => {
    const store = await SecretStore.open(dir, { NOURIDE_SECRET_NOUGATE: "prefixed" });
    expect(store.resolve("nougate")).toBe("prefixed");
  });

  test("resolves from the store when the environment is silent", async () => {
    const store = await SecretStore.open(dir, {});
    await store.set("nougate", "from-store");
    expect(store.resolve("nougate")).toBe("from-store");
    expect(store.origin("nougate")).toBe("store");
  });

  test("environment wins over the store", async () => {
    // A container platform injecting the variable must beat a stale file in the data
    // volume, or a deployment can be silently overridden by its own disk.
    const store = await SecretStore.open(dir, { NOUGATE: "from-env" });
    await store.set("nougate", "from-store");
    expect(store.resolve("nougate")).toBe("from-env");
    expect(store.origin("nougate")).toBe("env");
  });

  test("one secret serves several profiles", async () => {
    // The whole point of naming secrets: one Nougate key, two protocol endpoints.
    const store = await SecretStore.open(dir, { NOUGATE: "sk-nou-test" });
    expect(store.require("nougate", "[providers.nougate-openai]")).toBe("sk-nou-test");
    expect(store.require("nougate", "[providers.nougate-anthropic]")).toBe("sk-nou-test");
  });

  test("require names what needed the secret and how to set it", async () => {
    const store = await SecretStore.open(dir, {});
    expect(() => store.require("missing", "[gateways.telegram.nouva]")).toThrow(
      /\[gateways\.telegram\.nouva\] needs the secret "missing".*MISSING/s,
    );
  });
});

describe("SecretStore persistence", () => {
  test("survives a reopen", async () => {
    const first = await SecretStore.open(dir, {});
    await first.set("nougate", "value-1");

    const second = await SecretStore.open(dir, {});
    expect(second.resolve("nougate")).toBe("value-1");
  });

  test("delete removes only the named secret", async () => {
    const store = await SecretStore.open(dir, {});
    await store.set("a", "1");
    await store.set("b", "2");

    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
    expect(store.resolve("a")).toBeUndefined();
    expect(store.resolve("b")).toBe("2");
  });

  test("refuses to store an empty value", async () => {
    const store = await SecretStore.open(dir, {});
    await expect(store.set("nougate", "")).rejects.toThrow(/empty value/);
  });

  test("a refusal says which part of what was sent it is about: the name, the value, or what is said about it", async () => {
    // The dashboard's form sends all three, and names the one at fault (0.8.23).
    const store = await SecretStore.open(dir, {});
    const part = async (write: Promise<unknown>) => write.then(() => "stored", (err: unknown) => (err instanceof SecretError ? err.part : "not a refusal"));
    expect(await part(store.set("not a name", "v"))).toBe("name");
    expect(await part(store.set("nougate", ""))).toBe("value");
    expect(await part(store.set("telegram_nix", "$TMP_SECRET_3C60E07835C7"))).toBe("value");
    expect(await part(store.set("github", "v", { fields: { set: { "1 bad": "x" } } }))).toBe("fields");
    expect(await part(store.set("github", "v", { fields: { set: { backup: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" } } }))).toBe("fields");
    expect(await part(store.changeFields("nothing", { set: { a: "b" } }))).toBeUndefined();
  });

  test("refuses to store the handle of a credential sent in chat — it is not the credential", async () => {
    // Live (2026-10-21): two Telegram bots were saved as `$TMP_SECRET_…` and Telegram answered "Not Found".
    const store = await SecretStore.open(dir, {});
    await expect(store.set("telegram_nix", "$TMP_SECRET_3C60E07835C7")).rejects.toThrow(/handle of a credential sent in chat/);
    await expect(store.set("telegram_nix", " $TMP_SECRET_3C60E07835C7\n")).rejects.toThrow(/handle/);
    await expect(store.setMany({ a: "x", telegram_nero: "$TMP_SECRET_08DE9591E90F" })).rejects.toThrow(/handle/);
    expect(store.inventory()).toEqual([]);
    // A value that only mentions one is a value.
    await store.set("note", "see $TMP_SECRET_3C60E07835C7 for the old one");
    expect(store.has("note")).toBe(true);
  });

  test("refuses to start on a corrupt store rather than losing every credential", async () => {
    await writeTextFile(join(dir, "secrets.json"), "{not json");
    await expect(SecretStore.open(dir, {})).rejects.toThrow(/not valid JSON/);
  });

  // What a power cut during a write leaves: zero bytes, or the start of the file. The empty one opened as no secrets,
  // and every credential was gone with nothing said (0.8.17).
  test.each([
    ["empty", "", /secrets\.json is empty, refused rather than read as holding no secrets/],
    ["truncated", '{\n  "telegram_tok', /secrets\.json is not valid JSON/],
  ])("refuses to start on a store a power cut left %s, naming the file", async (_left, content, error) => {
    const path = join(dir, "secrets.json");
    await writeTextFile(path, content);
    await expect(SecretStore.open(dir, {})).rejects.toThrow(error);
    await expect(SecretStore.open(dir, {})).rejects.toThrow(path);
  });

  test("a store emptied under a running one: it goes on with what it read, and a write refuses rather than replace it", async () => {
    const path = join(dir, "secrets.enc");
    const store = await SecretStore.open(dir, {});
    await store.set("nougate", "value-one");
    await writeTextFile(path, "");

    // A name it does not hold sends it to the file again, which it refuses to read as none.
    expect(store.resolve("telegram")).toBeUndefined();
    expect(store.resolve("nougate")).toBe("value-one");
    expect(store.inventory().map(({ name, origin }) => ({ name, origin }))).toEqual([{ name: "nougate", origin: "store" }]);
    await expect(store.set("telegram", "value-two")).rejects.toThrow(/is empty/);
    await expect(store.delete("nougate")).rejects.toThrow(/is empty/);
    expect(await readTextFileIfExists(path)).toBe("");
  });

  test("inventory reports names and origins but never values", async () => {
    const store = await SecretStore.open(dir, { PINNED: "env-value" });
    await store.set("pinned", "store-value");
    await store.set("other", "another");

    const inventory = store.inventory();
    expect(inventory.map(({ name, origin }) => ({ name, origin }))).toEqual([
      { name: "other", origin: "store" },
      { name: "pinned", origin: "env" },
    ]);
    // No value appears anywhere in what the dashboard receives.
    expect(JSON.stringify(inventory)).not.toContain("store-value");
    expect(JSON.stringify(inventory)).not.toContain("env-value");
  });

  test("writes the store with 0600 permissions", async () => {
    const store = await SecretStore.open(dir, {});
    await store.set("nougate", "value");

    const { statSync } = await import("node:fs");
    const mode = statSync(join(dir, "secrets.enc")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("keeps no value in plain text on disk: it is encrypted, and secrets.json is not written (0.8.19)", async () => {
    const store = await SecretStore.open(dir, {});
    await store.set("nougate", "value-that-must-not-show");
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(join(dir, "secrets.enc"));
    expect(bytes.subarray(0, 8).toString()).toBe("NRSTORE1");
    expect(bytes.toString("latin1")).not.toContain("value-that-must-not-show");
    expect(await readTextFileIfExists(join(dir, "secrets.json"))).toBeNull();
    expect(await onDisk()).toEqual({ nougate: "value-that-must-not-show" });
  });
});

describe("values that only work together", () => {
  test("are written in one write — a pair is on disk whole after it, and kept by a reopen", async () => {
    const store = await SecretStore.open(dir, {});
    await store.set("kept", "untouched");
    await store.setMany({ "mcp-oauth-a-s-access": "access-1", "mcp-oauth-a-s-refresh": "refresh-1" });
    expect(await onDisk()).toEqual({
      kept: "untouched",
      "mcp-oauth-a-s-access": "access-1",
      "mcp-oauth-a-s-refresh": "refresh-1",
    });
    expect((await SecretStore.open(dir, {})).resolve("mcp-oauth-a-s-refresh")).toBe("refresh-1");
  });

  test("are all refused when one is — a bad name or an empty value changes nothing", async () => {
    const store = await SecretStore.open(dir, {});
    await store.setMany({ pair_a: "a-1", pair_b: "b-1" });
    await expect(store.setMany({ pair_a: "a-2", "not a name": "b-2" })).rejects.toThrow(/not a valid secret name/);
    await expect(store.setMany({ pair_a: "a-2", pair_b: "" })).rejects.toThrow(/empty value/);
    expect([store.resolve("pair_a"), store.resolve("pair_b")]).toEqual(["a-1", "b-1"]);
    expect(await onDisk()).toEqual({ pair_a: "a-1", pair_b: "b-1" });
  });

  test("are removed together, and only the ones held are said to be", async () => {
    const store = await SecretStore.open(dir, {});
    await store.setMany({ pair_a: "a-1", pair_b: "b-1", other: "o-1" });
    expect(await store.deleteMany(["pair_a", "pair_b", "never_set"])).toEqual(["pair_a", "pair_b"]);
    expect(await onDisk()).toEqual({ other: "o-1" });
    expect(await store.deleteMany(["pair_a"])).toEqual([]);
  });
});
