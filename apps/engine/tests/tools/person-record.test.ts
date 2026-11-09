/**
 * `person_record` — the tool that exists because the prose did not work.
 *
 * The identity line had told agents to record a name for months. On 2026-09-02 somebody introduced
 * themselves to `ren` on Telegram and the audit log shows one call for the whole turn: `memory_write`
 * with `## User\n\n- **Name:** Sam`. So the assertions here are about the two things that made the
 * difference — that the write is a *typed tool call*, and that it lands under the id the `[[people]]`
 * matcher will actually look for. A tool that records a name under the wrong id is the same bug with
 * a longer path to noticing it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "@nouride/persona";
import type { GlobalConfig, Person } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { createPersonRecordTool } from "@/modules/tools/builtins/people.ts";
import { findPerson } from "@/modules/people/match.ts";

let dir: string;
let configPath: string;
let people: Person[];

function tool(memory = false) {
  return createPersonRecordTool({
    deps: { config: { people, memory: DEFAULT_CONFIG.memory } as unknown as GlobalConfig, configPath },
    memory,
  });
}

/** A Telegram DM, shaped as `ren`'s was: a gateway instance and a numeric sender. */
function ctx(over: Record<string, unknown> = {}) {
  return {
    agentId: "ren",
    gatewayId: "telegram:ren",
    senderId: "5550001111",
    signal: new AbortController().signal,
    ...over,
  } as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-person-"));
  configPath = join(dir, "config.toml");
  people = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recording somebody who has just introduced themselves", () => {
  test("writes an id the matcher then recognises", async () => {
    const result = await tool().execute({ name: "Gading" }, ctx());
    expect(result.isError).toBe(false);

    /**
     * The property that matters, asserted through `findPerson` rather than by comparing strings.
     * A hand-written expectation of `"telegram:5550001111"` would still pass if the tool and the
     * matcher drifted apart in the same direction; this fails the moment they disagree.
     */
    expect(findPerson(people, { gatewayId: "telegram:ren", senderId: "5550001111" })).toEqual({
      name: "Gading",
    });
  });

  test("is recognised through any of this install's bots on that platform", async () => {
    await tool().execute({ name: "Gading" }, ctx());

    // The same person messaging a different bot of ours. The platform-qualified form is what makes
    // this work; recording the gateway-qualified `telegram:ren:…` would leave them a stranger here.
    expect(findPerson(people, { gatewayId: "telegram:nouva", senderId: "5550001111" })).toEqual({
      name: "Gading",
    });
  });

  test("keeps the note, flattened to one line", async () => {
    await tool().execute({ name: "Gading", note: "Runs the homelab.\nPrefers Indonesian." }, ctx());
    expect(people[0]?.notes).toBe("Runs the homelab. Prefers Indonesian.");
  });

  test("a note never replaces the notes somebody already has", async () => {
    // It did: `note` was saved as `notes`, which means "set it", so an agent recording a name with a
    // one-line note erased a page the operator had written — what USER.md was, for that person.
    const page = "Call him Ding one-on-one.\n\n## Work\n- Founder.";
    people.push({ key: "gading", ids: ["telegram:5550001111"], name: "Gading", notes: page });
    writeFileSync(configPath, `[[people]]\nkey = "gading"\nname = "Gading"\nids = ["telegram:5550001111"]\nnotes = ${JSON.stringify(page)}\n`);

    const result = await tool(true).execute({ name: "Gading", note: "Runs the homelab." }, ctx());

    expect(result.isError).toBe(false);
    expect(people[0]?.notes).toBe(page);
    expect(readFileSync(configPath, "utf8")).not.toContain("Runs the homelab");
    // Told, and told where the fact goes instead — a silent no-op would be retried, or written to MEMORY.md.
    expect(result.content).toContain("person_notes");
    expect(result.content).toContain("about=person");
  });

  test("where memory has no profiles, the refusal does not point at them", async () => {
    people.push({ key: "gading", ids: ["telegram:5550001111"], name: "Gading", notes: "Founder." });
    writeFileSync(configPath, `[[people]]\nkey = "gading"\nname = "Gading"\nids = ["telegram:5550001111"]\nnotes = "Founder."\n`);
    const result = await tool(false).execute({ name: "Gading", note: "Runs the homelab." }, ctx());
    expect(people[0]?.notes).toBe("Founder.");
    expect(result.content).not.toContain("about=person");
  });

  test("recorded from one of their accounts: the same person, every account kept", async () => {
    // Observed on a scratch install, when the first account was the person: a name recorded from the
    // dashboard's chat made the account id the primary and dropped the Telegram one, so the person was
    // a stranger on Telegram from then on. Found by account and saved by key, there is nothing to drop.
    people.push({ key: "gading", ids: ["telegram:5550001111", "web:usr_1"], name: "Gading", notes: "Founder." });
    writeFileSync(configPath, `[[people]]\nkey = "gading"\nname = "Gading"\nids = ["telegram:5550001111", "web:usr_1"]\nnotes = "Founder."\n`);

    await tool().execute({ name: "Gading Nasution" }, ctx({ gatewayId: "web:dashboard", senderId: "usr_1" }));

    expect(people).toEqual([{ key: "gading", ids: ["telegram:5550001111", "web:usr_1"], name: "Gading Nasution", notes: "Founder." }]);
    expect(findPerson(people, { gatewayId: "telegram:ren", senderId: "5550001111" })).toMatchObject({ name: "Gading Nasution" });
    expect(readFileSync(configPath, "utf8")).toContain('ids = ["telegram:5550001111", "web:usr_1"]');
  });

  test("somebody new is keyed by name, never by a key another person holds", async () => {
    people.push({ key: "sam", name: "Sam" });
    writeFileSync(configPath, `[[people]]\nkey = "sam"\nname = "Sam"\n`);
    await tool().execute({ name: "Kak Sam" }, ctx());
    expect(people.map((person) => person.key)).toEqual(["sam", "sam-2"]);
    expect(people[1]).toMatchObject({ name: "Kak Sam", ids: ["telegram:5550001111"] });
  });

  test("lands in config.toml, not only in memory", async () => {
    await tool().execute({ name: "Gading" }, ctx());
    // The in-memory copy is what this turn reads; the file is what survives the restart. A write
    // that did only the first would work all afternoon and lose the household overnight.
    expect(readFileSync(configPath, "utf8")).toContain("Gading");
  });

  test("is learned about from now on: a key made from the name, in the file too, kept on a rename", async () => {
    await tool().execute({ name: "Kak Sam" }, ctx());
    expect(people[0]?.key).toBe("sam");
    expect(readFileSync(configPath, "utf8")).toMatch(/key\s*=\s*"sam"/);
    await tool().execute({ name: "Sam Wijaya" }, ctx());
    expect(people[0]).toMatchObject({ name: "Sam Wijaya", key: "sam" });
  });

  test("a second introduction corrects the name rather than adding a stranger", async () => {
    await tool().execute({ name: "Gading" }, ctx());
    await tool().execute({ name: "Gading Nasution" }, ctx());

    expect(people).toHaveLength(1);
    expect(people[0]?.name).toBe("Gading Nasution");
  });

  test("says plainly that memory is not also needed", async () => {
    // The tool result is the last thing the model reads before deciding what to do next, and what it
    // did next — before this existed — was write the same name into MEMORY.md.
    const result = await tool().execute({ name: "Gading" }, ctx());
    expect(result.content).toContain("memory");
  });
});

describe("what it refuses", () => {
  test("a blank name", async () => {
    const result = await tool().execute({ name: "   " }, ctx());
    expect(result.isError).toBe(true);
    expect(people).toHaveLength(0);
  });

  /**
   * An id the model typed, which is the one thing this tool must not take.
   *
   * There used to be an `id` argument for recording a third party, described as "only with an id
   * you were actually given". Live: somebody tagged an agent in a channel, so the message text held
   * that agent's own mention token, and a second agent called this with that token as the id and
   * the *person's* name. One of this daemon's own bots ended up in `[[people]]` as a human, and it
   * took the operator two conversations to work out what the extra entry was.
   *
   * The doc comment on `senderId` had already written the reason down — a model reconstructing an
   * id from context will eventually reconstruct it wrong, and a wrong id writes a name onto nobody
   * — and the argument was a door straight back to it.
   */
  test("an id the model typed is refused, not silently written", async () => {
    const result = await tool().execute({ name: "Nadia", id: "telegram:99" }, ctx());

    expect(result.isError).toBe(true);
    // Nothing written at all: half-recording under the sender's id would put the wrong name on the
    // person actually speaking, which is worse than refusing.
    expect(people).toHaveLength(0);
    // The way forward, because a refusal that names no alternative is read as "cannot be done".
    expect(result.content).toContain("people set");
  });

  test("but spelling out the speaker's own id is fine, because it is not a guess", async () => {
    // A model that helpfully writes the id it was told to use is doing nothing wrong, and refusing
    // it would make the tool feel arbitrary. Both forms the matcher accepts.
    await tool().execute({ name: "Gading", id: "telegram:5550001111" }, ctx());
    expect(people[0]?.ids).toEqual(["telegram:5550001111"]);

    // From nobody again, in the file the running list is read from as well as in the list.
    people.length = 0;
    writeFileSync(configPath, "");
    await tool().execute({ name: "Gading", id: "telegram:ren:5550001111" }, ctx());
    expect(people[0]?.ids).toEqual(["telegram:5550001111"]);
  });

  test("the argument is not advertised, so the common case never reaches for it", () => {
    // The refusal above is the net. This is the reason it should rarely fire: a parameter in the
    // schema is an invitation, and this one invited the failure it now refuses.
    const schema = tool().definition.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["name", "note"]);
  });
});

/**
 * A fresh install must arrive with this, not acquire it later.
 *
 * There are four ways an agent comes into existence here and they read from three different lists,
 * which is how `exec` once left the defaults without the prompt that depended on it noticing. Two of
 * those lists already have a test that compares them against the whole registry — `setup.test.ts` for
 * the wizard, `agent-example.test.ts` for the template. This covers the third, and states the rule
 * the three share.
 */
describe("a first install", () => {
  test("gives a pack that says nothing about tools the ability to record a person", async () => {
    const root = mkdtempSync(join(tmpdir(), "nouride-pack-"));
    const dir = join(root, "quiet");
    mkdirSync(dir);
    writeFileSync(join(dir, "IDENTITY.md"), "# IDENTITY\n- Name: Quiet\n");
    writeFileSync(join(dir, "SOUL.md"), "Be terse.\n");
    // No `[tools]` block at all — the shape `agent_create` writes when the caller names no tools.
    writeFileSync(join(dir, "config.toml"), "[agent]\nenabled = true\n");

    try {
      const agent = await loadAgent("quiet", {
        agentsDir: root,
        llmDefaults: DEFAULT_CONFIG.llm.defaults,
        knownProviders: [DEFAULT_CONFIG.llm.defaults.provider],
        knownGateways: [],
      });

      // Asserted as a pair rather than on its own. The failure this prevents is not "person_record is
      // missing", it is "an agent can write memory and has nowhere else to put a name", and only the
      // pair says that.
      expect(agent.config.tools.enabled).toContain("memory_write");
      expect(agent.config.tools.enabled).toContain("person_record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
