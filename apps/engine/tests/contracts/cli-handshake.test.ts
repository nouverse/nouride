/**
 * The weekly check of the newest coding CLIs (0.8.24, v0.8.24 item 4): `scripts/cli-handshake.ts` against a stand-in
 * adapter — the engine's fake CLI process under the built-in Claude Code row — green with steering and the presets'
 * modes, red without steering, red with a preset's mode gone, red when it does not start; and the workflow that runs it
 * each week over the rows' own packages, installed at their newest.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_CLIS } from "@nouride/acp";

const ROOT = join(import.meta.dir, "../../../..");
const SCRIPT = join(ROOT, "scripts/cli-handshake.ts");
const FAKE = join(ROOT, "apps/engine/tests/external-agents/fixtures/fake-cli.ts");
const CLAUDE_MODES = "bypassPermissions,acceptEdits,default";

function check(args: string[], env: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

const standIn = (env: Record<string, string>) => check(["--only", "claude-code", "--", process.execPath, FAKE], env);

describe("the newest CLIs' handshake, with no sign-in", () => {
  test("a stand-in with steering and the presets' modes: green", () => {
    expect(standIn({ FAKE_MODE: "steer", FAKE_MODES: CLAUDE_MODES })).toEqual({ code: 0, out: "✓ claude-code 9.9.9: has what Nouride uses", err: "" });
  });

  test("a stand-in without steering: red, saying so", () => {
    expect(standIn({ FAKE_MODE: "", FAKE_MODES: CLAUDE_MODES })).toMatchObject({ code: 1, out: "✗ claude-code 9.9.9: it no longer offers steering, which a message sent while it works goes through" });
  });

  test("a stand-in whose sessions lost a preset's mode: red, naming it", () => {
    expect(standIn({ FAKE_MODE: "steer", FAKE_MODES: "default,plan" })).toMatchObject({ code: 1, out: "✗ claude-code 9.9.9: its sessions no longer offer the modes Nouride's presets set (bypassPermissions, acceptEdits)" });
  });

  test("one that does not start is red too", () => {
    const run = check(["--only", "codex", "--", process.execPath, "-e", "process.exit(3)"]);
    expect(run.code).toBe(1);
    expect(run.out).toStartWith("✗ codex: it did not answer the handshake");
  });

  test("misuse exits 2", () => {
    expect(check(["--only"]).code).toBe(2);
    expect(check(["--only", "nope"]).code).toBe(2);
    expect(check(["--", "x"]).code).toBe(2);
  });
});

describe("the workflow that runs it each week", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/cli-handshake.yml"), "utf8");

  test("installs the rows' own packages at their newest, then runs the check", () => {
    expect(check(["--packages"]).out).toBe(BUILT_IN_CLIS.flatMap((row) => (row.package ? [`${row.package}@latest`] : [])).join(" "));
    expect(workflow).toContain('npm install -g --prefix "$RUNNER_TEMP/clis" $(bun run scripts/cli-handshake.ts --packages)');
    expect(workflow).toContain("run: bun run scripts/cli-handshake.ts\n");
  });

  test("weekly, and on a push that changes the check or what it reads", () => {
    expect(workflow).toMatch(/schedule:\n\s+# .*\n\s+- cron: "17 3 \* \* 1"/);
    for (const path of ["scripts/cli-handshake.ts", "packages/acp/src/**", ".github/workflows/cli-handshake.yml"]) expect(workflow).toContain(`- "${path}"`);
  });
});
