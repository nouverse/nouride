/**
 * The secret store encrypted at rest (0.8.19): the file, the key's places and how far each is from the data, the move
 * from `secrets.json`, a key changed for a better one, and the refusals that keep every secret rather than lose them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { SecretStore } from "../src/index.ts";
import { findStoreKeys, forgetMadeKey, keyBytes, keyLineValue, type KeyLayout } from "../src/store-key.ts";

let root: string;
let dataDir: string;
let layout: KeyLayout;

const KEY_A = "bSc2zJBw7hmljYL7+3oooZhIb7Ur0FATBW5fWho0lVU=";
const KEY_B = "PDtsF37ASJ5AQMgzZ0Jyl9PcrIMvLI3fCFjR2KQSU8Q=";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-at-rest-"));
  const nourideDir = join(root, ".nouride");
  dataDir = join(nourideDir, "data");
  mkdirSync(dataDir, { recursive: true });
  layout = { keptKey: join(nourideDir, "encryption.key"), installEnv: join(root, ".env"), installDir: root, nourideDir, envFiles: [] };
});

afterEach(() => removePath(root));

const bytes = (name: string) => readFileSync(join(dataDir, name));
const exists = (path: string) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

describe("the file", () => {
  test("is NRSTORE1 and the key's fingerprint, then the encrypted store: no value and no name in it", async () => {
    const store = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    await store.set("telegram_bot", "123456:the-token-value", { fields: { set: { domain: "telegram.org" } } });
    const raw = bytes("secrets.enc");
    expect(raw.subarray(0, 8).toString()).toBe("NRSTORE1");
    expect(raw.subarray(8, 16).toString("hex")).toBe(findStoreKeys({ NOURIDE_ENCRYPTION_KEY: KEY_A }, layout)[0]?.fingerprint ?? "none");
    for (const word of ["the-token-value", "telegram_bot", "telegram.org"]) expect(raw.toString("latin1")).not.toContain(word);
    expect(statSync(join(dataDir, "secrets.enc")).mode & 0o777).toBe(0o600);
    expect(exists(join(dataDir, "secrets.json"))).toBe(false);
  });

  test("opened by another store with the same key, values and fields as written", async () => {
    const env = { NOURIDE_ENCRYPTION_KEY: KEY_A };
    const first = await SecretStore.open(dataDir, env, { layout });
    await first.set("github", "ghp_value", { fields: { set: { domain: "github.com", username: "gading" } }, actor: "agent:nouva" });
    const second = await SecretStore.open(dataDir, env, { layout });
    expect(second.resolve("github")).toBe("ghp_value");
    expect(second.describe("github")).toMatchObject({ name: "github", fields: { domain: "github.com", username: "gading" }, addedBy: "agent:nouva" });
  });

  test("a wrong key is refused by name, with the key it needs and the two ways out; nothing is written", async () => {
    const store = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    await store.set("nougate", "value");
    const before = bytes("secrets.enc");
    const opened = SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_B }, { layout });
    await expect(opened).rejects.toThrow(/encrypted with a key this machine does not have \(key [0-9a-f]{16}\)/);
    await expect(SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_B }, { layout })).rejects.toThrow(/nouride secret restore --stdin/);
    expect(bytes("secrets.enc").equals(before)).toBe(true);
  });

  test("no key at all for a store that needs one: refused, and no key is made over it", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("nougate", "value");
    // Its key was kept by the store; take it away, as a moved folder without its key would be.
    removePath(layout.keptKey);
    removePath(layout.installEnv as string);
    await expect(SecretStore.open(dataDir, {}, { layout })).rejects.toThrow(/No key was found here/);
    expect(exists(layout.keptKey)).toBe(false);
  });

  test("a changed byte, zero bytes, and a file that is not ours are each refused, never read as no secrets", async () => {
    const env = { NOURIDE_ENCRYPTION_KEY: KEY_A };
    const store = await SecretStore.open(dataDir, env, { layout });
    await store.set("nougate", "value");
    const raw = bytes("secrets.enc");
    raw[raw.length - 3] = (raw[raw.length - 3] ?? 0) ^ 1;
    writeFileSync(join(dataDir, "secrets.enc"), raw);
    await expect(SecretStore.open(dataDir, env, { layout })).rejects.toThrow(/could not be opened with its key .* changed or cut short/);
    writeFileSync(join(dataDir, "secrets.enc"), "");
    await expect(SecretStore.open(dataDir, env, { layout })).rejects.toThrow(/secrets\.enc is empty, refused/);
    writeFileSync(join(dataDir, "secrets.enc"), "not a store at all");
    await expect(SecretStore.open(dataDir, env, { layout })).rejects.toThrow(/is not a secret store Nouride wrote/);
  });
});

describe("where the key is", () => {
  test("the variable, said as the environment and outside the install: nothing is made", async () => {
    const store = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    await store.set("nougate", "value");
    expect(store.lock()).toEqual({ encrypted: true, key: { where: "the environment", level: "outside" } });
    expect(exists(layout.keptKey)).toBe(false);
  });

  test("none given and an install .env it can write: a line there, said as the install's", async () => {
    writeFileSync(layout.installEnv as string, "HOST=127.0.0.1\nPORT=18254", { mode: 0o600 });
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("nougate", "value");
    const env = readFileSync(layout.installEnv as string, "utf8");
    expect(env).toStartWith("HOST=127.0.0.1\nPORT=18254\n");
    expect(keyLineValue(env)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(statSync(layout.installEnv as string).mode & 0o777).toBe(0o600);
    expect(store.lock().key).toEqual({ where: layout.installEnv as string, level: "install" });
    expect(exists(layout.keptKey)).toBe(false);
    // And the next start finds it there, as systemd's EnvironmentFile would hand it over.
    expect((await SecretStore.open(dataDir, {}, { layout })).resolve("nougate")).toBe("value");
  });

  test("none given and no .env (a container's volume): its own file in the data folder, 0600, said as the data's", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("nougate", "value");
    expect(statSync(layout.keptKey).mode & 0o777).toBe(0o600);
    expect(store.lock().key).toEqual({ where: layout.keptKey, level: "data" });
  });

  test("made by root (a Box's daemon): in root's file, 0600, said as outside the install; found there again", async () => {
    const system = join(root, "etc", "nouride", "nouride.env");
    const asRoot = { ...layout, systemKeyFile: system, envFiles: [system] };
    writeFileSync(layout.installEnv as string, "PORT=18254\n");
    const store = await SecretStore.open(dataDir, {}, { layout: asRoot });
    await store.set("nougate", "value");
    expect(statSync(system).mode & 0o777).toBe(0o600);
    expect(keyLineValue(readFileSync(system, "utf8"))).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(readFileSync(layout.installEnv as string, "utf8")).toBe("PORT=18254\n");
    expect(store.lock().key).toEqual({ where: system, level: "outside" });
    expect((await SecretStore.open(dataDir, {}, { layout: asRoot })).resolve("nougate")).toBe("value");
  });

  test("a key given later: the daemon's store encrypts again with it and forgets the one it made", async () => {
    const made = await SecretStore.open(dataDir, {}, { layout });
    await made.set("nougate", "value");
    expect(exists(layout.keptKey)).toBe(true);

    // A command's store does not move it: a stray key in a shell must not lock the daemon out.
    const command = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    expect(command.lock().key?.where).toBe(layout.keptKey);
    expect(exists(layout.keptKey)).toBe(true);

    const daemon = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout, rekey: true });
    expect(daemon.lock().key).toEqual({ where: "the environment", level: "outside" });
    expect(exists(layout.keptKey)).toBe(false);
    expect((await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout })).resolve("nougate")).toBe("value");
  });

  test("forgetting a made key takes its .env line and the comment above it, and nothing else", async () => {
    writeFileSync(layout.installEnv as string, "HOST=127.0.0.1\n", { mode: 0o600 });
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("nougate", "value");
    const [key] = findStoreKeys({}, layout);
    if (!key) throw new Error("no key");
    await forgetMadeKey(key, layout);
    expect(readFileSync(layout.installEnv as string, "utf8")).toBe("HOST=127.0.0.1\n");
  });

  test("a key's text: base64, URL-safe base64 or hex, and anything else refused by where it was, never shown", () => {
    expect(keyBytes(KEY_A, "x")).toHaveLength(32);
    expect(keyBytes(KEY_A.replace(/\+/g, "-").replace(/\//g, "_").replace(/=$/, ""), "x")).toEqual(keyBytes(KEY_A, "x"));
    expect(keyBytes("ab".repeat(32), "x")).toHaveLength(32);
    expect(() => keyBytes("too-short-to-be-a-key", "/etc/nouride/nouride.env")).toThrow(/The NOURIDE_ENCRYPTION_KEY in \/etc\/nouride\/nouride\.env is not a key Nouride can use/);
    try {
      keyBytes("too-short-to-be-a-key", "x");
    } catch (err) {
      expect(String(err)).not.toContain("too-short-to-be-a-key");
    }
  });

  test("the key is among what everything leaving the daemon is masked of", async () => {
    const store = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    await store.set("nougate", "value");
    expect(Object.values(store.knownValues())).toContain(KEY_A);
  });
});

describe("from secrets.json", () => {
  test("read as it is, and written as the previous version reads it, until it is moved", async () => {
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ nougate: "old-value" }), { mode: 0o600 });
    const store = await SecretStore.open(dataDir, {}, { layout });
    expect(store.resolve("nougate")).toBe("old-value");
    await store.set("telegram", "tok", { fields: { set: { domain: "telegram.org" } } });
    expect(JSON.parse(readFileSync(join(dataDir, "secrets.json"), "utf8"))).toEqual({ nougate: "old-value", telegram: "tok" });
    expect(exists(join(dataDir, "secrets.enc"))).toBe(false);
    expect(store.lock().encrypted).toBe(false);
  });

  test("moved: encrypted, read back, then the plain file removed; the fields given meanwhile kept; once only", async () => {
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ nougate: "old-value" }), { mode: 0o600 });
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("telegram", "tok", { fields: { set: { domain: "telegram.org" } } });
    expect(await store.encryptAtRest()).toBe(true);
    expect(exists(join(dataDir, "secrets.json"))).toBe(false);
    expect(store.lock().encrypted).toBe(true);
    const reopened = await SecretStore.open(dataDir, {}, { layout });
    expect(JSON.parse(reopened.plainCopy())).toEqual({ nougate: "old-value", telegram: "tok" });
    expect(reopened.describe("telegram")?.fields).toEqual({ domain: "telegram.org" });
    expect(await reopened.encryptAtRest()).toBe(false);
  });

  test("a secrets.json newer than secrets.enc is the way back's, and wins: what the older version changed comes along", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("nougate", "before-the-way-back");
    // `nouride secret decrypt` for 0.8.18, which then changed it.
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ nougate: "changed-on-0.8.18" }), { mode: 0o600 });
    const later = new Date(Date.now() + 5_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(dataDir, "secrets.json"), later, later);
    const back = await SecretStore.open(dataDir, {}, { layout });
    expect(back.resolve("nougate")).toBe("changed-on-0.8.18");
    expect(await back.encryptAtRest()).toBe(true);
    expect(exists(join(dataDir, "secrets.json"))).toBe(false);
    expect((await SecretStore.open(dataDir, {}, { layout })).resolve("nougate")).toBe("changed-on-0.8.18");
  });

  test("a move cut short (secrets.enc written, secrets.json still there) is finished at the next start; a plain file it does not match is left", async () => {
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ nougate: "old-value" }), { mode: 0o600 });
    const store = await SecretStore.open(dataDir, {}, { layout });
    expect(await store.encryptAtRest()).toBe(true);
    // As if the process had died before the plain file went: it is there again, older than secrets.enc.
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ nougate: "old-value" }), { mode: 0o600 });
    const { utimesSync } = await import("node:fs");
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(join(dataDir, "secrets.json"), earlier, earlier);
    const next = await SecretStore.open(dataDir, {}, { layout });
    expect(await next.encryptAtRest()).toBe(false);
    expect(exists(join(dataDir, "secrets.json"))).toBe(false);
    expect(next.resolve("nougate")).toBe("old-value");
    // One that says something else is not the move's, and stays for a person to look at.
    writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ nougate: "something else" }), { mode: 0o600 });
    utimesSync(join(dataDir, "secrets.json"), earlier, earlier);
    await (await SecretStore.open(dataDir, {}, { layout })).encryptAtRest();
    expect(exists(join(dataDir, "secrets.json"))).toBe(true);
  });

  test("the way back's copy is names and values, as secrets.json always was", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("github", "ghp_value", { fields: { set: { domain: "github.com" } } });
    expect(JSON.parse(store.plainCopy())).toEqual({ github: "ghp_value" });
    expect(JSON.parse(store.sealedCopyText())).toMatchObject({ version: 2, secrets: { github: { value: "ghp_value", fields: { domain: "github.com" } } } });
  });
});

describe("restored", () => {
  test("a file it cannot open is set aside, never written over, and what was restored opens with this install's key", async () => {
    const first = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    await first.set("nougate", "lost-with-its-key");
    const locked = bytes("secrets.enc");
    // A moved install, or a lost key: the file is here, its key is not.
    const result = await SecretStore.restore(dataDir, { nougate: { value: "from-the-sealed-copy", fields: { what: "the model key" } } }, { NOURIDE_ENCRYPTION_KEY: KEY_B }, { layout });
    expect(result.setAside).toMatch(/secrets\.enc\.unopened-\d+$/);
    expect(readFileSync(result.setAside as string).equals(locked)).toBe(true);
    const opened = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_B }, { layout });
    expect(opened.resolve("nougate")).toBe("from-the-sealed-copy");
    expect(opened.describe("nougate")?.fields).toEqual({ what: "the model key" });
  });

  test("a file it can open is written with its own key, and nothing is set aside", async () => {
    const first = await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    await first.set("nougate", "now");
    const result = await SecretStore.restore(dataDir, { nougate: { value: "older", fields: {} } }, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout });
    expect(result).toEqual({});
    expect((await SecretStore.open(dataDir, { NOURIDE_ENCRYPTION_KEY: KEY_A }, { layout })).resolve("nougate")).toBe("older");
  });
});

describe("fields", () => {
  test("free names and texts: added, changed, removed; the value untouched; a replaced value keeps them", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout, now: () => new Date("2026-11-05T00:00:00Z") });
    await store.set("github", "ghp_one", { fields: { set: { domain: "github.com", "Account email": "gading@nouverse.tech" } }, actor: "admin" });
    expect(await store.changeFields("github", { set: { username: "gadingnst" }, remove: ["Account email"] })).toEqual({ domain: "github.com", username: "gadingnst" });
    await store.set("github", "ghp_two");
    expect(store.resolve("github")).toBe("ghp_two");
    expect(store.describe("github")).toEqual({
      name: "github",
      origin: "store",
      fields: { domain: "github.com", username: "gadingnst" },
      addedBy: "admin",
      addedAt: "2026-11-05T00:00:00.000Z",
      changedAt: "2026-11-05T00:00:00.000Z",
    });
    expect(JSON.stringify(store.inventory())).not.toContain("ghp_two");
  });

  test("a text that looks like a key or a password is refused, naming the field: fields are shown to everyone", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("github", "ghp_one");
    await expect(store.changeFields("github", { set: { backup: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" } })).rejects.toThrow(/field "backup" looks like a key or a password/);
    await expect(store.changeFields("github", { set: { note: "password: hunter2hunter2" } })).rejects.toThrow(/field "note" looks like a key/);
    await expect(store.changeFields("github", { set: { from: "$TMP_SECRET_3C60E07835C7" } })).rejects.toThrow(/looks like a key/);
    expect(store.describe("github")?.fields).toEqual({});
  });

  test("names, lengths and counts are bounded; a field on a secret not stored is refused", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("github", "ghp_one");
    await expect(store.changeFields("github", { set: { "1st": "x" } })).rejects.toThrow(/not a field name/);
    await expect(store.changeFields("github", { set: { note: "x".repeat(501) } })).rejects.toThrow(/longer than 500/);
    await expect(store.changeFields("github", { set: { note: "two\nlines" } })).rejects.toThrow(/more than one line/);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, "x"]));
    await expect(store.changeFields("github", { set: many })).rejects.toThrow(/more than 20 fields/);
    await expect(store.changeFields("nothing", { set: { a: "b" } })).rejects.toThrow(/no stored secret "nothing"/);
  });

  test("an address, a host and a sentence are plain fields", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    await store.set("smtp", "app-password-value");
    expect(await store.changeFields("smtp", { set: { email: "bot@nouverse.tech", domain: "smtp.gmail.com", what: "the mail the agents send from" } })).toEqual({
      email: "bot@nouverse.tech",
      domain: "smtp.gmail.com",
      what: "the mail the agents send from",
    });
  });
});

describe("after each write", () => {
  test("what listens is told: the sealed copy is made again then", async () => {
    const store = await SecretStore.open(dataDir, {}, { layout });
    let told = 0;
    store.onChange(() => told++);
    await store.set("a", "1");
    await store.changeFields("a", { set: { what: "x" } });
    await store.delete("a");
    expect(told).toBe(3);
  });
});
