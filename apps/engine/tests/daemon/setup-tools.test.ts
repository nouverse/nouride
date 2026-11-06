/**
 * What the first agent is given, and why it is not a list somebody has to remember.
 *
 * It *was* a list. `skill_improve` shipped, `[rsi] mode` defaults to proposing, and the first agent on
 * every fresh install turned out to be the one agent that could not raise a skill draft — while
 * `skill_create`, which writes a skill straight into the shared pool with no approval at all, was
 * granted. The safer of the two was the one withheld and nothing anywhere said so, because nothing
 * was comparing the list to the registry.
 *
 * This is that comparison. The daemon path now reads the live tool map, so a tool registered next
 * month is offered with nothing to update; `FALLBACK_TOOLS` covers `nouride setup`, which runs
 * before a registry exists, and the test below is what stops the two drifting apart in silence.
 */

import { TransientSecrets } from "@nouride/secrets";
import { describe, expect, test } from "bun:test";
import { FALLBACK_TOOLS } from "@/modules/setup/service.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

/**
 * The registry with every optional dependency present.
 *
 * Every one of them gates a tool's *inclusion* — `web_search` needs a backend, `skill_improve` needs
 * the reflection loop, `person_record` needs the people writer — so this is the widest set the daemon
 * can ever offer. Stubs, because nothing here is called: only the names are read.
 */
function everyBuiltin(): string[] {
  const stub = (() => undefined) as never;
  return [
    ...createBuiltinTools({
      security: DEFAULT_CONFIG.security,
      web: { search: { backend: "brave", apiKey: "x" } } as never,
      sessionStatus: stub,
      runSubagent: stub,
      askAgent: { run: stub } as never,
      harness: {
        registry: stub,
        providers: () => [],
        agentsDir: "/tmp/agents",
      } as never,
      reflection: {} as never,
      skillHub: {} as never,
      mcpCatalog: { catalog: {} as never, linkFor: () => null },
      sendFile: { send: stub } as never,
      sendMessage: { targets: stub, post: stub },
      attachmentRead: { find: stub, list: stub, open: stub, describe: stub } as never,
      memory: {} as never,
      nourideCli: { installDir: "/srv/nouride", command: "nouride" },
      update: {} as never,
      people: {} as never,
      heldSecrets: new TransientSecrets(),
      secretKeeping: { has: stub, keep: stub, bind: stub, changeFields: stub },
      notes: {} as never,
    }).keys(),
  ];
}

describe("the tools the first agent is created with", () => {
  test("the fallback list covers every tool the registry can produce", () => {
    /**
     * The assertion that would have caught `skill_improve`.
     *
     * `ask_agent` is the one exception and it is deliberate: it follows the daemon rather than the
     * pack. `resolveToolset` adds it per turn when there is a peer to ask and withdraws it when
     * there is not, whatever `[tools] enabled` says — so writing it into a config file would be a
     * line with no effect, in a file people hand-edit.
     *
     * `attachment_read` is resolved the same way but stays *in* this list: the assertion below is
     * what would notice it disappearing from the registry, and `NOT_WRITTEN` is what keeps it out of
     * the file.
     */
    const missing = everyBuiltin().filter(
      (name) => name !== "ask_agent" && !FALLBACK_TOOLS.includes(name),
    );

    expect(missing).toEqual([]);
  });

  test("the fallback names nothing the registry cannot build", () => {
    // The other direction, which matters because a name that resolves to nothing is logged as
    // "agent enables tools that do not exist" on every boot — noise that teaches operators to
    // ignore the warning that would otherwise be worth reading.
    const real = new Set(everyBuiltin());
    expect(FALLBACK_TOOLS.filter((name) => !real.has(name))).toEqual([]);
  });

  test("it includes the pair that stops names landing in the wrong file", () => {
    // An agent with `memory_write` and no `person_record` writes people into MEMORY.md, which was
    // observed before `person_record` was added to this set.
    expect(FALLBACK_TOOLS).toContain("memory_write");
    expect(FALLBACK_TOOLS).toContain("person_record");
  });

  test("it includes the safer half of skill authoring, not only the outright one", () => {
    // `skill_create` writes into the shared pool. `skill_improve` proposes a draft that waits for a
    // human. Granting the first without the second is backwards, and was the state for weeks.
    expect(FALLBACK_TOOLS).toContain("skill_create");
    expect(FALLBACK_TOOLS).toContain("skill_improve");
  });
});
