/**
 * How long a test may take. Bun's default of five seconds was the only limit, and most of CI's reds were timing: a test
 * that took three seconds on an idle runner went past five on a busy one. The suite runs with thirty (0.8.17), and the
 * tests the review of 2026-11-03 measured at three seconds or more on CI have a timeout of their own, so they keep it
 * when their file is run by hand.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SCRIPTS = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const WORKFLOWS = join(ROOT, ".github/workflows");

describe("the suite", () => {
  test("gives each test thirty seconds", () => {
    expect(SCRIPTS.test).toStartWith("bun test --timeout=30000 ");
  });

  test("is run as `bun run test` wherever it runs, never spelled out: verify, every other script, every workflow", () => {
    expect(SCRIPTS.verify).toContain("bun run test");
    const scripts = Object.entries(SCRIPTS).filter(([name, script]) => name !== "test" && /\bbun test\b/.test(script)).map(([name]) => name);
    const steps = readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith(".yml"))
      .flatMap((name) =>
        readFileSync(join(WORKFLOWS, name), "utf8")
          .split("\n")
          .flatMap((line, i) => (/\bbun test\b/.test(line) && !line.trim().startsWith("#") ? [`${name}:${i + 1}`] : [])),
      );
    expect({ scripts, steps }).toEqual({ scripts: [], steps: [] });
  });
});

/** The tests measured at three seconds or more on CI, by file: the slowest took four and a half. */
const SLOW: Record<string, string[]> = {
  "apps/engine/tests/external-agents/cli-secrets.test.ts": [
    "a turn that finds them changed while another works in the CLI waits for that one, and its shell has them",
  ],
  "apps/engine/tests/cli/cli-chat-piped.test.ts": [
    "every line is sent, in order, each after the last was answered",
    "a last line with no newline is sent, and the chat still ends",
    "/quit ends it: nothing after it is sent",
    "the transcript reads as the conversation went: each line, what its turn did, its answer",
    "progress is this conversation's stream — its chat on the dashboard's connection, from now, with the thinking frames",
  ],
  "apps/engine/tests/external-agents/mid-prompt.test.ts": [
    "a CLI that does not offer it is never sent one: the next prompt, once the running one ends",
    "past the hold, sent while the command still runs",
  ],
  "packages/gateways/tests/whatsapp-decisions.test.ts": ["asks the bridge to log out, gives it its grace period, then stops"],
};

describe("a test measured at three seconds or more on CI has a timeout of its own, the suite's", () => {
  for (const [file, names] of Object.entries(SLOW)) {
    for (const name of names) {
      test(name, () => {
        const source = readFileSync(join(ROOT, file), "utf8");
        const start = source.indexOf(`  test(${JSON.stringify(name)}, `);
        expect(start).toBeGreaterThan(-1);
        // Its closing line, at the indentation it opened at: `}, <ms>);` when it has one.
        const own = /^ {2}\}(?:, ([\d_]+))?\);$/m.exec(source.slice(start))?.[1];
        expect({ file, timeout: Number(own?.replaceAll("_", "") ?? 0) }).toEqual({ file, timeout: 30_000 });
      });
    }
  }
});
