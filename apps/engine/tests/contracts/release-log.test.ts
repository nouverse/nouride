/**
 * A green release log carries no error line.
 *
 * The runner prints a step's script at the head of the step's log, so a `::error::` written into a script is in the
 * log of every run that reaches the step, whether or not it fails. v0.7.10's release passed all twelve jobs, and its
 * first job's log held six — the token and version checks' own messages, echoed — so grepping a release for errors
 * turned up revoked tokens and a wrong version that had not happened, and a real error was easy to miss among them.
 * A step that can fail defines `error`, which builds the command only when it is said.
 *
 * Every workflow, not only the release's: CI and the image check echoed four more into every green run until 0.7.11.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "../../../../.github/workflows");
const RELEASE = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
const HELPER = `error() { printf '::%s::%s\\n' error "$*"; }`;

/** Every step's script as the runner prints it: what follows `run:`, and for a block, the lines indented under it. */
function scripts(yaml: string): { line: number; text: string }[] {
  const lines = yaml.split("\n");
  const out: { line: number; text: string }[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(- )?run:\s*(.*)$/.exec(line);
    if (!m) return;
    if (m[3] !== "|" && m[3] !== ">") return void out.push({ line: i + 1, text: m[3]! });
    const key = m[1]!.length + (m[2] ? 2 : 0);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && (lines[j]!.trim() === "" || lines[j]!.search(/\S/) > key); j++) body.push(lines[j]!);
    out.push({ line: i + 1, text: body.join("\n") });
  });
  return out;
}

/** Every workflow, by file name, with its steps' scripts. */
const ALL = readdirSync(WORKFLOWS)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, steps: scripts(readFileSync(join(WORKFLOWS, name), "utf8")) }));

describe("the release workflow's log", () => {
  const steps = scripts(RELEASE);

  test("is read whole — every step's script, not only the first", () => {
    // An extractor that stopped matching would find no `::error::` anywhere and pass.
    expect(steps.length).toBeGreaterThan(30);
    expect(steps.some((s) => s.text.includes('sh scripts/release/sign-checksums.sh "$@"'))).toBe(true);
  });

  test("names no error in a script the runner echoes — a step says one through `error`", () => {
    expect(steps.filter((s) => s.text.includes("::error::")).map((s) => `release.yml:${s.line}`)).toEqual([]);
  });

  test("a step that says `error` defines it, the one way", () => {
    const calls = steps.filter((s) => /(?:^|[\s;{(|&])error "/m.test(s.text));
    expect(calls.length).toBeGreaterThan(8);
    expect(calls.filter((s) => !s.text.includes(HELPER)).map((s) => `release.yml:${s.line}`)).toEqual([]);
  });

  test("every workflow is read, and none names an error in a script the runner echoes", () => {
    expect(ALL.map((w) => w.name)).toEqual(expect.arrayContaining(["ci.yml", "ci-image.yml", "release.yml"]));
    for (const w of ALL) expect(w.steps.length).toBeGreaterThan(0);
    const said = ALL.flatMap((w) => w.steps.filter((s) => s.text.includes("::error::")).map((s) => `${w.name}:${s.line}`));
    expect(said).toEqual([]);
  });

  test("and in every workflow a step that says `error` defines it, the one way", () => {
    const calls = ALL.flatMap((w) => w.steps.filter((s) => /(?:^|[\s;{(|&])error "/m.test(s.text)).map((s) => ({ ...s, name: w.name })));
    expect(calls.some((s) => s.name === "ci.yml")).toBe(true);
    expect(calls.some((s) => s.name === "ci-image.yml")).toBe(true);
    expect(calls.filter((s) => !s.text.includes(HELPER)).map((s) => `${s.name}:${s.line}`)).toEqual([]);
  });

  test("and `error` prints the workflow command the runner acts on, the message as it was given", () => {
    const run = spawnSync("sh", ["-c", `${HELPER}\nerror "a 50% cut of \\$HOME, \\\`x\\\`"`], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("::error::a 50% cut of $HOME, `x`\n");
  });
});
