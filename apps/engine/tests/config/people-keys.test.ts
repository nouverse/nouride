/**
 * People written without a key get one — made from their name when the file is read (`readPeople`),
 * written into the file at boot (`keyEveryone`).
 *
 * Found upgrading a 0.5.14 box: its `[[people]]` entry had no key, so the nightly pass filed every
 * conversation and learned nothing about the one person it knew, with nothing on screen saying why.
 * Since 0.7.0 the key is the person, so nobody may be without one — an entry an operator writes by
 * hand with only a name included.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseToml } from "@nouride/runtime";
import type { GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { keyEveryone } from "@/modules/config/settings/people.ts";
import { readPeople } from "@/modules/people/entry.ts";

let dir: string;
let configPath: string;
let config: GlobalConfig;

/** A config written by hand: a person with no key; and one who already has one. */
const V0514 = `[daemon]
orchestrator = "ren"

[[people]]
ids = ["web:terminal"]
name = "Gading"
notes = "Uses a MacBook Air M1."

[[people]]
ids = ["telegram:777"]
name = "Kak Sam"
key = "sam"
`;

beforeEach(() => {
  dir = join(tmpdir(), `nouride-people-keys-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, V0514);
  config = structuredClone(DEFAULT_CONFIG);
  config.people = readPeople(parseToml<{ people: unknown[] }>(V0514).people);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("keyEveryone", () => {
  test("a person read without a key has one from their name, and it is written into the file; the rest stay as written", async () => {
    expect(config.people.map((person) => person.key)).toEqual(["gading", "sam"]);
    expect(await keyEveryone({ config, configPath })).toBe(1);
    const file = readFileSync(configPath, "utf8");
    expect(file).toContain('[[people]]\nkey = "gading"\nids = ["web:terminal"]');
    expect(file).toContain('notes = "Uses a MacBook Air M1."');
    expect(file).toContain('key = "sam"');
    // Read again, the file gives the same people.
    expect(readPeople(parseToml<{ people: unknown[] }>(file).people)).toEqual(config.people);
  });

  test("somebody written with only a name — no account — is keyed too", async () => {
    writeFileSync(configPath, `${V0514}\n[[people]]\nname = "Grandma"\n`);
    config.people = readPeople(parseToml<{ people: unknown[] }>(readFileSync(configPath, "utf8")).people);
    expect(await keyEveryone({ config, configPath })).toBe(2);
    expect(parseToml<{ people: { key: string; name: string }[] }>(readFileSync(configPath, "utf8")).people.map((p) => p.key)).toEqual(["gading", "sam", "grandma"]);
  });

  test("a key made from a name never takes one a later entry holds", () => {
    const people = readPeople(parseToml<{ people: unknown[] }>(`[[people]]\nname = "Sam"\n\n[[people]]\nkey = "sam"\nname = "Samuel"\n`).people);
    expect(people.map((person) => person.key)).toEqual(["sam-2", "sam"]);
  });

  test("once is enough: the next boot has nothing to do", async () => {
    await keyEveryone({ config, configPath });
    const before = readFileSync(configPath, "utf8");
    expect(await keyEveryone({ config, configPath })).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("a config that cannot be written leaves the daemon booting, not refusing", async () => {
    // A file where the directory should be: the atomic write cannot create its temp file.
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "");
    expect(await keyEveryone({ config, configPath: join(blocked, "config.toml") })).toBe(0);
  });
});
