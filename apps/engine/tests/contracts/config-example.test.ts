/**
 * `config.example.toml` is the file every operator copies, and until this test nothing read it.
 *
 * `DEFAULT_CONFIG` doubles as the schema, so a setting that gets renamed in code leaves the example
 * advertising a key that is now silently ignored — the operator sets it, the daemon warns into a log
 * nobody is watching, and the setting simply does not apply. That failure is invisible from both
 * ends, which is why it needs a test rather than a review habit.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { addLogSink } from "@nouride/shared";
import { parseConfig } from "@/modules/config/global/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ANNOTATIONS } from "@/modules/config/schema.docs.ts";
import { ADVANCED_KEYS } from "@/modules/config/advanced.ts";
import { configJsonSchema, describeConfig } from "@/modules/config/schema.ts";
import { parseToml, readTextFile } from "@nouride/runtime";

const EXAMPLE = join(import.meta.dir, "../../../../config.example.toml");
const SITE = (lang: "en" | "id") => join(import.meta.dir, `../../../site/src/content/docs/${lang}/docs/reference/config.md`);

/** The example's lines by the table they sit under — a commented-out header counts, as a copied line would land there. */
async function exampleSections(): Promise<Map<string, string[]>> {
  const sections = new Map<string, string[]>();
  let current = "";
  for (const line of (await readTextFile(EXAMPLE)).split("\n")) {
    const header = /^\s*(?:#\s*)?\[{1,2}([A-Za-z0-9_.-]+)\]{1,2}\s*(?:#.*)?$/.exec(line);
    if (header) current = header[1]!;
    else sections.set(current, [...(sections.get(current) ?? []), line]);
  }
  return sections;
}

/** The keys an operator is shown: every annotated key but the advanced ones (`config/advanced.ts`). */
const EVERYDAY = Object.keys(ANNOTATIONS).filter((key) => !ADVANCED_KEYS.has(key));

async function exampleRaw(): Promise<Record<string, unknown>> {
  return parseToml<Record<string, unknown>>(await readTextFile(EXAMPLE));
}

/**
 * Through the log sink, not by patching a logger object.
 *
 * `createLogger` hands back a fresh object each call, so replacing `.warn` on one taken here would
 * intercept nothing the config module does — the test would pass no matter what the file said. It
 * did, until a deliberately broken example failed to fail. `addLogSink` is the seam that actually
 * sees every entry.
 */
const unknownKeys: string[] = [];
addLogSink((entry) => {
  if (entry.message.includes("unknown config key")) {
    unknownKeys.push(String(entry.data?.key ?? entry.message));
  }
});

describe("config.example.toml", () => {
  test("every uncommented key is one the daemon actually reads", async () => {
    // Reported as a warning, because a running daemon should not die over a stale key — which also
    // means nothing fails on its own, and the operator's setting simply never applies.
    unknownKeys.length = 0;
    parseConfig(await exampleRaw());

    expect(unknownKeys).toEqual([]);
  });

  test("it parses into a usable config", async () => {
    const config = parseConfig(await exampleRaw());

    // A few values read back, so the test fails on a file that parses but describes nothing —
    // an empty example would satisfy the check above perfectly.
    expect(config.daemon.name).toBeTruthy();
    // model is intentionally left blank in the example (filled in after adding a provider),
    // so check something else that is explicitly set: the approval level.
    expect(config.security.approvals).toBe("balanced");
  });

  test("the shipped defaults are what the example shows", async () => {
    const config = parseConfig(await exampleRaw());

    /**
     * Compared against the defaults rather than against literals.
     *
     * The example is documentation, and documentation that disagrees with the code is worse than
     * none: an operator reading `mention_max_hops = 4` and getting 8 has no way to notice. Written
     * with the numbers spelled out here, this test was a *second* copy of the same claim — so
     * changing the default meant editing three files and the test failing was the reminder, which is
     * the reminder working by accident. Read from `DEFAULT_CONFIG` it cannot go stale.
     */
    expect(config.agents.mentionsEnabled).toBe(DEFAULT_CONFIG.agents.mentionsEnabled);
    expect(config.agents.groupContextMessages).toBe(DEFAULT_CONFIG.agents.groupContextMessages);
    expect(config.skills.learning.mode).toBe(DEFAULT_CONFIG.skills.learning.mode);
    // Commented: a copied `max_running = 2` would pin every new box at two, past the agents it has.
    expect(config.missions.maxRunning).toBe(DEFAULT_CONFIG.missions.maxRunning);
    // The whole of `[missions]`: its limits were raised to 100 turns and 100 million tokens in 0.8.0, and the example
    // still set 50 and 50 million, so a box made from it stopped to ask at half a day's steps.
    expect(config.missions).toEqual(DEFAULT_CONFIG.missions);
  });

  test("a fresh install proposes and waits — it does not write skills by itself", () => {
    /**
     * The one default worth naming a literal for, against the rule the test above follows.
     *
     * Everything else here is compared to `DEFAULT_CONFIG` precisely so the example cannot disagree
     * with the code. This is the opposite case: the *value itself* is the promise. A first install
     * writes no `config.toml` at all — the installer only drops `config.example.toml` beside the
     * binary as a reference — so whatever is in `DEFAULT_CONFIG` is what a new box runs, unread and
     * unchosen. Reading it from the same constant would pass just as happily if somebody made
     * `auto` the default, which is the one change that must never happen quietly.
     */
    expect(DEFAULT_CONFIG.skills.learning.mode).toBe("ask");
    expect(parseConfig({}).skills.learning.mode).toBe("ask");
  });
});

/**
 * A setting nobody can see is a setting nobody evaluates.
 *
 * `[security.exec] sensitive_paths` was the case that made this worth a test. It is the only rule
 * standing in front of `.ssh/`, `.env`, `secrets.json`, this daemon's database and the `config.toml`
 * that decides what every agent may do — and it was the one exec knob the example file never
 * mentioned, while its three siblings were written out in full. An operator reading that file learnt
 * that `mode`, `ask` and `ask_fallback` exist and never learnt the fourth did. The default is safe
 * precisely *because* it is absent, which is what makes the omission easy to keep.
 *
 * Mentioned, not necessarily set: commented-out is the right shape for something whose default is
 * already correct. What must not happen is silence.
 */
describe("every documented setting is visible in the file operators copy", () => {
  test("no key is explained by `config explain` and invisible in the example — but the advanced ones", async () => {
    const text = await readTextFile(EXAMPLE);
    const invisible = EVERYDAY.filter(
      (key) => !new RegExp(`\\b${key.split(".").pop()}\\b`).test(text),
    );
    expect(invisible).toEqual([]);
  });

  test("…and each is written where it is read: `<key> =`, set or commented, inside its own section", async () => {
    // The word anywhere in the file passed the check above — in another section's prose, or under the wrong
    // header, where a copied line is silently ignored as an unknown key.
    const sections = await exampleSections();
    const misplaced = EVERYDAY.filter((key) => {
      const parts = key.split(".");
      if (parts.length === 1) return ![...sections.keys()].some((name) => name === key || name.startsWith(`${key}.`));
      const leaf = new RegExp(`^\\s*(?:#\\s*)?${parts.at(-1)}\\s*=`);
      return !(sections.get(parts.slice(0, -1).join(".")) ?? []).some((line) => leaf.test(line));
    });
    expect(misplaced).toEqual([]);
  });
});

/**
 * The keys marked advanced are left out of the file operators copy, and written in one place instead: the
 * docs' appendix, in both languages. Nothing about what they do changes — only where they are shown.
 */
describe("an advanced key", () => {
  test("is a key the daemon reads, every one", () => {
    const known = new Set(describeConfig().map((field) => field.path));
    expect([...ADVANCED_KEYS].filter((key) => !known.has(key))).toEqual([]);
    expect(describeConfig().filter((field) => field.advanced).map((field) => field.path).sort()).toEqual([...ADVANCED_KEYS].sort());
    // And `config schema` says so, for an editor reading the JSON Schema: on the advanced key, not on its neighbour.
    const cron = configJsonSchema("cron").properties as Record<string, Record<string, unknown>>;
    expect([cron.max_jobs?.["x-advanced"], cron.enabled?.["x-advanced"]]).toEqual([true, undefined]);
  });

  test("is not in config.example.toml — neither set nor commented, under its table", async () => {
    const sections = await exampleSections();
    const shown = [...ADVANCED_KEYS].filter((key) => {
      const parts = key.split(".");
      const leaf = new RegExp(`^\\s*(?:#\\s*)?${parts.at(-1)}\\s*=`);
      return (sections.get(parts.slice(0, -1).join(".")) ?? []).some((line) => leaf.test(line));
    });
    expect(shown).toEqual([]);
  });

  test.each(["en", "id"] as const)("is in the %s site's appendix, by table and key", async (lang) => {
    const page = await readTextFile(SITE(lang));
    const heading = lang === "en" ? "## Advanced settings" : "## Setelan lanjutan";
    expect(page).toContain(heading);
    const appendix = page.slice(page.indexOf(heading)).split(/\n## /)[0]!;
    const missing = [...ADVANCED_KEYS].filter((key) => {
      const parts = key.split(".");
      return !appendix.includes(`\`[${parts.slice(0, -1).join(".")}] ${parts.at(-1)}\``);
    });
    expect(missing).toEqual([]);
  });
});
