/**
 * The line around the CLI (`scripts/cli-rules.ts`, held by `check-arch.ts`): a command that asks the daemon imports
 * nothing of the engine, what both sides speak imports nothing of it either, and the engine takes the CLI in at the
 * binary's entry alone. Each way across is planted here, and the real tree is read for none.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CLI_ENTRY, cliFindings } from "../../../../scripts/cli-rules.ts";

const ROOT = join(import.meta.dir, "../../../..");
const rules = (rel: string, text: string) => cliFindings(rel, text).map((finding) => finding.rule);

function sources(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true }) as string[]).filter((file) => file.endsWith(".ts")).map((file) => join(dir, file));
}

describe("a client command", () => {
  const COMMAND = "apps/cli/src/commands/planted.ts";

  test("may not import an engine module by its alias", () => {
    expect(rules(COMMAND, 'import { openDatabase } from "@/db/index.ts";')).toEqual(["cli-imports-engine"]);
  });

  test("may not reach into the engine by a path, typed or awaited", () => {
    expect(rules(COMMAND, 'import type { Mission } from "../../../engine/src/modules/missions/types.ts";')).toEqual(["cli-imports-engine"]);
    expect(rules(COMMAND, 'const { loadConfig } = await import("../../../engine/src/cli/load-config.ts");')).toEqual(["cli-imports-engine"]);
  });

  test("may not import the engine's package", () => {
    expect(rules(COMMAND, 'import { runDaemon } from "@nouride/engine";')).toEqual(["cli-imports-engine"]);
  });

  test("imports its own files and the packages freely", () => {
    expect(rules(COMMAND, 'import { say } from "@nouride/cli-kit";\nimport { saidSaved } from "../saved.ts";\nimport type { MissionView } from "@nouride/wire";')).toEqual([]);
  });
});

describe("what both sides speak", () => {
  test("may not import the engine either", () => {
    expect(rules("packages/cli-kit/src/planted.ts", 'import { loadGlobalConfig } from "@/modules/config/global/index.ts";')).toEqual(["cli-imports-engine"]);
    expect(rules("packages/cli-kit/src/planted.ts", 'import { VERSION } from "../../../apps/engine/src/commons/version.ts";')).toEqual(["cli-imports-engine"]);
  });
});

describe("the engine", () => {
  test("takes the CLI in at the binary's entry, and nowhere else", () => {
    expect(rules(CLI_ENTRY, 'import { runCli } from "@nouride/cli";')).toEqual([]);
    expect(rules("apps/engine/src/boot/planted.ts", 'import { runCli } from "@nouride/cli";')).toEqual(["engine-imports-cli"]);
    expect(rules("apps/engine/src/cli/commands/doctor.ts", 'import { scanClis } from "../../../../cli/src/commands/external-clis.ts";')).toEqual(["engine-imports-cli"]);
  });

  test("keeps importing what both sides speak, and its own cli folder", () => {
    expect(rules("apps/engine/src/cli/commands/doctor.ts", 'import { say } from "@nouride/cli-kit";\nimport { connect } from "@/cli/connect.ts";\nimport { loadConfig } from "../load-config.ts";')).toEqual([]);
  });
});

describe("the real tree", () => {
  test("crosses the line nowhere, and enough of it was read to mean it", () => {
    const files = [...sources("apps/cli/src"), ...sources("packages/cli-kit/src"), ...sources("apps/engine/src")];
    expect(files.filter((file) => file.startsWith("apps/cli/src/")).length).toBeGreaterThan(40);
    expect(files.filter((file) => file.startsWith("packages/cli-kit/src/")).length).toBeGreaterThan(8);
    const crossed = files.flatMap((file) => cliFindings(file, readFileSync(join(ROOT, file), "utf8")).map((finding) => `${relative(ROOT, join(ROOT, file))}:${finding.line} ${finding.rule}`));
    expect(crossed).toEqual([]);
  });

  test("the entry is where the two meet", () => {
    expect(readFileSync(join(ROOT, CLI_ENTRY), "utf8")).toContain('import { runCli } from "@nouride/cli";');
  });
});
