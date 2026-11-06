/**
 * `content/agents/example/` is the pack every operator copies, and until this test nothing read it.
 *
 * It used to be read by accident: `agents_dir` defaulted to `./agents`, so a daemon started from a
 * checkout loaded the example on every boot and a broken template showed up immediately. The
 * `.nouride/` cutover moved the default to `.nouride/agents`, which means nothing parses this file any
 * more — the same shape as `config.example.toml` before `config-example.test.ts` existed, and the
 * same failure: the template rots in place and the person who copies it inherits the rot.
 *
 * Loaded through the real loader rather than parsed here, because "does this file still describe a
 * valid pack" is a question only the loader can answer.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgent } from "@nouride/persona";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../../content/agents");

function load() {
  return loadAgent("example", {
    agentsDir: AGENTS_DIR,
    llmDefaults: DEFAULT_CONFIG.llm.defaults,
    // The example agent names `anthropic` — provide it so the loader accepts the pack.
    // A real daemon would have whatever the operator created in config.toml.
    knownProviders: ["anthropic", "openai"],
    knownGateways: [],
  });
}

const said: LogEntry[] = [];
addLogSink((entry) => void said.push(entry));

describe("content/agents/example", () => {
  test("every key it writes is one a pack reads — a copy of it warns about nothing", async () => {
    said.length = 0;
    await load();
    expect(said.filter((entry) => entry.message === "unknown pack config key ignored").map((entry) => entry.data?.key)).toEqual([]);
  });

  test("teaches the scoped form of exec_secrets — the list form is refused since 0.8.0", async () => {
    await load();
    const text = readFileSync(join(AGENTS_DIR, "example", "config.toml"), "utf8");
    expect(text).toContain("[security.exec_secrets]");
    expect(text).not.toMatch(/^exec_secrets\s*=/m);
  });

  /**
   * The template is where an operator learns which persona files are worth filling.
   *
   * It shipped with `IDENTITY.md`, `SOUL.md` and a config — so a reasonable reading was that those are
   * the only slots. The loader reads six, and an operator who had been running an agent for weeks
   * asked for `AGENTS.md` support to be "added to the code" when it had always been there. A slot with
   * no file is indistinguishable from one that does not exist, and the template is the one place that
   * can say otherwise.
   */
  test("shows every persona slot worth filling", async () => {
    const { persona } = await load();
    // Listed by key rather than by string, so renaming a slot breaks this test at compile time instead
    // of quietly checking a field that no longer exists.
    const slots = [
      persona.identity,
      persona.soul,
      persona.agents,
      persona.memory,
      // These four are the whole set. A `HEARTBEAT.md` slot used to exist and was removed: nothing in
      // this runtime starts a turn nobody asked for, so it could only be read while already answering
      // someone. Scheduled work is cron. `USER.md` went in 0.7.0: who somebody is lives in People.
    ];

    for (const slot of slots) expect(slot?.trim()).toBeTruthy();
  });

  test("its AGENTS.md explains why it is never trimmed", async () => {
    // The rule that keeps this file from growing into the 16KB one it was ported from: it is essential
    // in the prompt and paid for on every turn, so anything narrower belongs in a skill.
    const agent = await load();
    expect(agent.persona.agents?.toLowerCase()).toContain("never trimmed");
  });

  test("ships disabled", async () => {
    // A template that loads *active* joins the first install it is copied into — and it names a model
    // and a provider chosen for illustration, so it would answer with somebody else's configuration.
    const agent = await load();
    expect(agent.config.enabled).toBe(false);
  });

  test("every tool it names still exists", async () => {
    // The rot that matters, and the one nothing else catches: the loader accepts any string here, so
    // a renamed tool leaves the template enabling something that is gone. The copy loads clean and the
    // agent simply cannot do the thing the file said it could.
    const agent = await load();
    // Every optional dependency supplied, so the set is "tools that can exist" rather than "tools this
    // configuration happens to offer". `web_search`, `session_status` and `delegate` are registered
    // conditionally — the first version of this test read their absence as a dead name and failed on a
    // template that was perfectly correct.
    const real = new Set(
      createBuiltinTools({
        security: DEFAULT_CONFIG.security,
        web: { searchKind: "brave", searchApiKey: "test-key-not-used" },
        sessionStatus: () => ({}) as never,
        runSubagent: (async () => ({ text: "", toolCalls: 0 })) as never,
        // Registered only when a gateway exists to send through. It belongs in "can exist": leaving
        // it out reports a correct template as naming a dead tool, which is the false positive this
        // comment already warns about.
        sendFile: { send: (async () => []) as never, maxBytes: 1 },
        // Same reason as `sendFile`: `person_record` is registered only where there is a config file
        // to write people into, so leaving it out would report the template as naming a dead tool.
        people: { config: DEFAULT_CONFIG, configPath: "/tmp/nouride-test-config.toml" },
      }).keys(),
    );

    for (const name of [...agent.config.tools.enabled, ...agent.config.tools.approvalRequired]) {
      expect({ tool: name, exists: real.has(name) }).toEqual({ tool: name, exists: true });
    }
  });
});
