/**
 * Editing `config.toml` without destroying it.
 *
 * The property that matters is not "the value changed" — it is "everything else did not". This file is
 * mostly comments in a real install, and those comments are the documentation for the daemon.
 */

import { describe, expect, test } from "bun:test";
import { parseToml } from "@nouride/runtime";
import { removeTomlTable, upsertTomlTable } from "@/modules/config/edit.ts";
import { addMissingPeopleKeys, removePerson, upsertPerson } from "@/modules/config/edit-blocks.ts";

const SAMPLE = `# Nouride configuration.

[daemon]
# Where persona packs live.
agents_dir = "./agents"
data_dir = "./data"

[providers.nougate]
kind = "openai"
base_url = "https://nougate.example/v1"
api_key = "nougate"          # a secret NAME, never the key itself

[security.exec]
mode = "full"
`;

describe("upsertTomlTable", () => {
  test("replaces a value and keeps every comment", () => {
    const out = upsertTomlTable(SAMPLE, "providers.nougate", {
      base_url: "https://other.example/v1",
    });

    expect(out).toContain('base_url = "https://other.example/v1"');
    expect(out).toContain("# Nouride configuration.");
    expect(out).toContain("# Where persona packs live.");
    expect(out).toContain("https://other.example/v1");
    expect(out).not.toContain("nougate.example");
    // Everything it was not asked about is still there.
    expect(parseToml<any>(out).security.exec.mode).toBe("full");
    expect(parseToml<any>(out).daemon.agents_dir).toBe("./agents");
  });

  test("adds a key the table did not have, inside that table", () => {
    const out = upsertTomlTable(SAMPLE, "providers.nougate", { timeout_ms: 30000 });
    const parsed = parseToml<any>(out);

    expect(parsed.providers.nougate.timeout_ms).toBe(30000);
    // Appended to the right table, not leaked into the next one.
    expect(parsed.security.exec.timeout_ms).toBeUndefined();
    expect(parsed.providers.nougate.kind).toBe("openai");
  });

  test("appends a table that does not exist yet", () => {
    const out = upsertTomlTable(SAMPLE, "providers.anthropic", {
      kind: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key: "anthropic",
    });
    const parsed = parseToml<any>(out);

    expect(parsed.providers.anthropic.kind).toBe("anthropic");
    expect(parsed.providers.nougate.kind).toBe("openai");
  });

  test("writes into an empty file", () => {
    const out = upsertTomlTable("", "daemon", { default_agent: "nouva" });
    expect(parseToml<any>(out).daemon.default_agent).toBe("nouva");
    expect(out.startsWith("\n")).toBe(false);
  });

  test("escapes a value rather than producing a file that will not parse", () => {
    // A base URL is operator input. A quote or a backslash in it must not be able to end the string
    // and turn the rest of the file into syntax.
    const out = upsertTomlTable(SAMPLE, "providers.nougate", {
      base_url: 'https://x/"; evil = "yes',
    });
    expect(parseToml<any>(out).providers.nougate.base_url).toBe('https://x/"; evil = "yes');
    expect(parseToml<any>(out).providers.nougate.evil).toBeUndefined();
  });

  test("a profile name with a dash is matched literally, not as a pattern", () => {
    const source = '[providers.nougate-openai]\nkind = "openai"\n';
    const out = upsertTomlTable(source, "providers.nougate-openai", { kind: "anthropic" });
    expect(parseToml<any>(out).providers["nougate-openai"].kind).toBe("anthropic");
  });

  test("repeated writes do not grow the file with blank lines", () => {
    let out = SAMPLE;
    for (let i = 0; i < 5; i += 1) {
      out = upsertTomlTable(out, "providers.nougate", { base_url: `https://x${i}/v1` });
    }
    expect(out.split("\n\n\n")).toHaveLength(1);
    expect(parseToml<any>(out).providers.nougate.base_url).toBe("https://x4/v1");
  });

  test("preserves the indentation of a key it rewrites", () => {
    const source = "[daemon]\n  data_dir = \"./data\"\n";
    expect(upsertTomlTable(source, "daemon", { data_dir: "/srv" })).toContain('  data_dir = "/srv"');
  });

  test("an empty value set is a no-op", () => {
    expect(upsertTomlTable(SAMPLE, "daemon", {})).toBe(SAMPLE);
  });
  /**
   * Arrays exist here because `[skills] builtin_disabled` is one, and a setting the dashboard
   * toggles has to be writable by the thing that toggles it.
   */
  describe("arrays", () => {
    test("writes a string array and reads back as one", () => {
      const next = upsertTomlTable(SAMPLE, "skills", { builtin_disabled: ["a", "b"] });
      expect(next).toContain('builtin_disabled = ["a", "b"]');
      expect(parseToml(next)).toMatchObject({ skills: { builtin_disabled: ["a", "b"] } });
    });

    test("an empty array is written, not omitted", () => {
      // An absent key and an empty array parse the same, but the operator who switched everything
      // back on wants to see that where they made the change.
      const next = upsertTomlTable(SAMPLE, "skills", { builtin_disabled: [] });
      expect(next).toContain("builtin_disabled = []");
      expect(parseToml(next)).toMatchObject({ skills: { builtin_disabled: [] } });
    });

    test("replaces an existing array in place rather than appending a second key", () => {
      const once = upsertTomlTable(SAMPLE, "skills", { builtin_disabled: ["a"] });
      const twice = upsertTomlTable(once, "skills", { builtin_disabled: ["b"] });

      expect(twice.match(/builtin_disabled/g)).toHaveLength(1);
      expect(parseToml(twice)).toMatchObject({ skills: { builtin_disabled: ["b"] } });
    });

    test("stays on one line, however long", () => {
      // `keyPattern` finds a setting by matching `^\\s*key\\s*=`, so a value spanning lines would be
      // found on rewrite and truncated at the first one. TOML would permit it; this editor cannot.
      const many = Array.from({ length: 20 }, (_, i) => `skill-with-a-long-name-${i}`);
      const next = upsertTomlTable(SAMPLE, "skills", { builtin_disabled: many });

      const line = next.split("\n").find((entry) => entry.includes("builtin_disabled")) ?? "";
      expect(line).toContain(`"${many.at(-1)}"]`);
      expect(parseToml(next)).toMatchObject({ skills: { builtin_disabled: many } });
      // And the rewrite the one-line rule exists for: found by its first line, replaced whole.
      const rewritten = upsertTomlTable(next, "skills", { builtin_disabled: ["only"] });
      expect(parseToml(rewritten)).toMatchObject({ skills: { builtin_disabled: ["only"] } });
    });

    test("escapes a value that would otherwise break the line", () => {
      const next = upsertTomlTable(SAMPLE, "skills", { builtin_disabled: ['say "hi"'] });
      expect(parseToml(next)).toMatchObject({ skills: { builtin_disabled: ['say "hi"'] } });
    });

    test("leaves the file's comments alone", () => {
      const next = upsertTomlTable(SAMPLE, "skills", { builtin_disabled: ["a"] });
      expect(next).toContain("# Where persona packs live.");
      expect(next).toContain("# a secret NAME, never the key itself");
    });
  });
});

describe("removeTomlTable", () => {
  test("removes the header and its body only", () => {
    const parsed = parseToml<any>(removeTomlTable(SAMPLE, "providers.nougate"));

    expect(parsed.providers?.nougate).toBeUndefined();
    expect(parsed.security.exec.mode).toBe("full");
    expect(parsed.daemon.data_dir).toBe("./data");
  });

  test("removing a table that is not there changes nothing", () => {
    expect(removeTomlTable(SAMPLE, "providers.absent")).toBe(SAMPLE);
  });

  test("removing the last table leaves a file that still parses", () => {
    const out = removeTomlTable(SAMPLE, "security.exec");
    expect(parseToml<any>(out).security?.exec).toBeUndefined();
    expect(parseToml<any>(out).providers.nougate.kind).toBe("openai");
  });
});

/** `[[people]]` as a file holds it. */
type PeopleFile = { people?: Record<string, unknown>[] };

describe("upsertPerson and removePerson", () => {
  test("adds a new [[people]] block: the key first, then the name — and no account until there is one", () => {
    const out = upsertPerson(SAMPLE, { key: "sam", name: "Kak Sam", notes: "Kak Sam, Alex's partner." });
    const parsed = parseToml<PeopleFile>(out);
    expect(parsed.people?.[0]).toEqual({ key: "sam", name: "Kak Sam", notes: "Kak Sam, Alex's partner." });
    expect(out).toContain('[[people]]\nkey = "sam"\nname = "Kak Sam"');
  });

  test("an account given is written as ids — never as id", () => {
    const out = upsertPerson(SAMPLE, { key: "sam", name: "Kak Sam", ids: ["whatsapp:12345@lid"] });
    expect(parseToml<PeopleFile>(out).people?.[0]).toEqual({ key: "sam", name: "Kak Sam", ids: ["whatsapp:12345@lid"] });
    expect(out).not.toMatch(/^id\s*=/m);
  });

  test("removes a [[people]] block by key", () => {
    const withPerson = upsertPerson(SAMPLE, { key: "sam", name: "Kak Sam" });
    const out = removePerson(withPerson, { key: "sam" });
    expect(parseToml<PeopleFile>(out).people).toBeUndefined();
  });
});

/**
 * `[[people]]` blocks written before 0.7.0, edited in a file a person hand-writes.
 *
 * No key, the first account as `id`, the rest in `ids` spread over several lines — the shape this
 * daemon used to generate and the one an operator writes by hand. A single-line-only reader once passed
 * its own unit test, appended a duplicate block against the real file, and left a config the validator
 * refused at boot. Such a block is found by an account it claims, given its key, and has its `id`
 * folded into `ids` — losing no address, least of all the one it used to be found by.
 */
describe("a block written by hand without a key", () => {
  const MULTILINE = `[daemon]
name = "nouride"

[[people]]
# A comment the operator wrote and must keep.
ids   = [
  "discord:214700000000000001",
  "telegram:5550001111",
  "whatsapp:628111000001@s.whatsapp.net",
]
name  = "Alex"
notes = "Founder."

[[people]]
ids  = ["whatsapp:918@lid", "whatsapp:190@lid"]
name = "Kak Sam"
`;
  const people = (text: string) => parseToml<PeopleFile>(text).people ?? [];

  test("is updated in place when found by one of its accounts: key added, the rest kept", () => {
    // Found as a connection saw the sender: the account is the platform's.
    const out = upsertPerson(MULTILINE, { key: "alex", name: "Alex Doe" }, ["telegram:bot:5550001111"]);

    // One block, not two: a second is two people with one account, and the first would always win.
    expect(out.match(/\[\[people\]\]/g)).toHaveLength(2);
    expect(people(out)[0]).toEqual({
      key: "alex",
      name: "Alex Doe",
      ids: ["discord:214700000000000001", "telegram:5550001111", "whatsapp:628111000001@s.whatsapp.net"],
      notes: "Founder.",
    });
    expect(out).toContain('[[people]]\nkey = "alex"\n# A comment the operator wrote and must keep.');
  });

  test("a single-line array works the same way", () => {
    const out = upsertPerson(MULTILINE, { key: "sam", name: "Sam" }, ["whatsapp:190@lid"]);
    expect(out.match(/\[\[people\]\]/g)).toHaveLength(2);
    expect(people(out)[1]).toEqual({ key: "sam", name: "Sam", ids: ["whatsapp:918@lid", "whatsapp:190@lid"] });
  });

  test("one whose id names its connection, a form the loader refuses, is not found by the platform's account", () => {
    // Read as written: matching it would rewrite a refused form into today's, a translation 0.8.0 does not do.
    const file = `[[people]]\nids = ["telegram:nouva:5550001111"]\nname = "Alex"\n`;
    const out = upsertPerson(file, { key: "alex", name: "Alex Doe", ids: ["telegram:5550001111"] }, ["telegram:5550001111"]);
    expect(out.match(/\[\[people\]\]/g)).toHaveLength(2);
    expect(out).toContain('ids = ["telegram:nouva:5550001111"]\nname = "Alex"\n');
  });

  test("a key nobody holds, claiming no account there, is a new person", () => {
    const out = upsertPerson(MULTILINE, { key: "new", name: "Somebody New", ids: ["discord:999"] });
    expect(out.match(/\[\[people\]\]/g)).toHaveLength(3);
    expect(people(out)[2]).toEqual({ key: "new", name: "Somebody New", ids: ["discord:999"] });
  });

  test("removed whole, found by any account it claims", () => {
    const out = removePerson(MULTILINE, { key: "alex", ids: ["telegram:5550001111"] });
    expect(out.match(/\[\[people\]\]/g)).toHaveLength(1);
    expect(out).not.toContain("Alex");
    expect(out).toContain("Kak Sam");
  });

  test("a line it lacks goes under its last value, not under the next table's comment", () => {
    const file = `[[people]]\nids = ["telegram:5550001111"]\nname = "Sam"\nkey = "sam"\n\n# About the next table.\n[security.rate_limit]\nmessages_per_minute = 200\n`;
    const out = upsertPerson(file, { key: "sam", name: "Kak Sam", notes: "Hi." });
    expect(out).toBe(
      `[[people]]\nids = ["telegram:5550001111"]\nname = "Kak Sam"\nkey = "sam"\nnotes = "Hi."\n\n# About the next table.\n[security.rate_limit]\nmessages_per_minute = 200\n`,
    );
  });

  test("the keys a file's blocks lack are written in, by position — a person with no account included", () => {
    const file = `${MULTILINE}\n[[people]]\nkey = "kid"\nname = "Kid"\n\n[[people]]\nname = "Grandma"\n`;
    const out = addMissingPeopleKeys(file, ["alex", "sam", "kid", "grandma"]);
    expect(people(out).map((person) => person.key)).toEqual(["alex", "sam", "kid", "grandma"]);
    // A file that no longer lines up with what was read is left alone.
    expect(addMissingPeopleKeys(file, ["alex", "sam"])).toBe(file);
  });
});

describe("a person's key in the file", () => {
  const people = (text: string) => parseToml<{ people: { name: string; key?: string; ids?: string[] }[] }>(text).people;

  test("found by it, and kept, with the accounts, on a write that changes only the name", () => {
    const added = upsertPerson(SAMPLE, { key: "sam", name: "Sam", ids: ["discord:1"] });
    const kept = upsertPerson(added, { key: "sam", name: "Kak Sam" });
    expect(people(kept)).toEqual([{ key: "sam", name: "Kak Sam", ids: ["discord:1"] }]);
  });

  test("an empty list of accounts leaves a person with none", () => {
    const added = upsertPerson(SAMPLE, { key: "sam", name: "Sam", ids: ["discord:1"] });
    expect(people(upsertPerson(added, { key: "sam", name: "Sam", ids: [] }))).toEqual([{ key: "sam", name: "Sam" }]);
  });
});

describe("a person's facts in the file", () => {
  const people = (text: string) => parseToml<{ people: { name: string; key?: string; facts?: string }[] }>(text).people;

  test("set, kept when absent, removed by an empty string", () => {
    const set = upsertPerson(upsertPerson(SAMPLE, { key: "sam", name: "Sam", ids: ["discord:1"] }), { key: "sam", name: "Sam", facts: "auto" });
    expect(people(set)[0]).toMatchObject({ key: "sam", facts: "auto" });
    const changed = upsertPerson(set, { key: "sam", name: "Sam", facts: "off" });
    expect(people(changed)[0]?.facts).toBe("off");
    expect(people(upsertPerson(changed, { key: "sam", name: "Kak Sam" }))[0]).toMatchObject({ name: "Kak Sam", facts: "off" });
    expect(people(upsertPerson(changed, { key: "sam", name: "Sam", facts: "" }))[0]?.facts).toBeUndefined();
  });
});
