/**
 * `/approvals` takes only the presets' names since 0.7.23 — `careful`, `balanced`. In 0.8.0 an old one (`risky`) is
 * answered like any other word: what to type, and nothing set. No file reads them any more either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AutoApprove } from "@/modules/tools/auto-approve.store.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | null = null;
afterEach(() => {
  bench?.dispose();
  bench = null;
});

async function chat() {
  let auto!: AutoApprove;
  bench = await pipelineBench({
    turns: [{ text: "unused" }],
    deps: ({ db }) => {
      auto = new AutoApprove({ db });
      return { autoApprove: auto };
    },
  });
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  const b = bench;
  let sent = 0;
  const say = async (text: string) => {
    b.gateway.receive(envelope({ id: `m${++sent}`, timestamp: Date.now(), chatType: "dm", text, senderId: "user-1" }));
    await b.pipeline.idle();
    return b.gateway.lastText();
  };
  return { say, level: () => auto.levelFor("telegram:main", "user-1") };
}

describe("/approvals and the names from before 0.7.23", () => {
  test("an old name is answered like any other word, and nothing is set", async () => {
    const { say, level } = await chat();
    for (const old of ["risky", "normal", "none"]) {
      expect(await say(`/approvals ${old}`)).toBe("Use `/approvals careful` or `/approvals balanced`. `/approvals` on its own shows what is set.");
    }
    expect(level()).toBeUndefined();
  });

  test("the new name is taken", async () => {
    const { say, level } = await chat();
    expect(await say("/approvals balanced")).toContain("Approvals: **balanced** for you.");
    expect(level()).toBe("balanced");
    expect(await say("/approvals careful")).toContain("Approvals: **careful** for you.");
    expect(level()).toBeUndefined();
  });

  test("moving to balanced says what still asks — 0.8.0's few, and `trusted` refused with what it switches off", async () => {
    const { say } = await chat();
    const reply = await say("/approvals balanced");
    // Two lists, a line to each thing: one sentence broken by hand at five places read ragged on a phone.
    expect(reply).toContain(
      [
        "**Still asks, every time:**",
        "• changing a config.toml",
        "• giving someone access",
        "• stopping this daemon",
        "• replacing or deleting a stored secret",
        "• a credential leaving this machine",
        "• changing its system packages",
        "",
        "**Like every level, it also asks about:**",
        "• a program installed for every agent",
        "• a change to an agent's own persona, or to who People says a person is",
        "• work nobody watches sending somewhere its job did not name",
      ].join("\n"),
    );
    // No sentence is broken in its middle.
    const midSentence = (text: string | undefined) => (text ?? "").split("\n").filter((line) => /^[a-z]/.test(line));
    expect(midSentence(reply)).toEqual([]);
    expect(reply).not.toContain("recursive deletes");
    const trusted = await say("/approvals trusted");
    expect(trusted).toContain("switches off every gate, config changes and stopping this daemon included");
    expect(midSentence(trusted)).toEqual([]);
  });
});
