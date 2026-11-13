/**
 * The two workflows a pull request starts, held to what makes them safe to start (`pr.yml`, `cla.yml`).
 *
 * A pull request is somebody else's code and somebody else's words. `pr.yml` runs the code, so it is given nothing: a
 * token that reads, no secret, and GitHub's own runner, never the machine that builds and signs releases. `cla.yml`
 * holds a token that writes a status, so it runs none of the code and takes nothing of the event but a number. Each
 * test here is one of those lines, and a workflow that drops it is one a stranger's pull request can use.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const DIR = join(ROOT, ".github/workflows");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");
const pr = read("pr.yml");
const cla = read("cla.yml");
const ci = read("ci.yml");

/** A workflow's text less its comments: a rule said in a comment is not a line that runs. */
const code = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
/** The workflow-wide `permissions:` block, as written. */
const topPermissions = (text: string) => /\npermissions:(.*\n(?: {2}.*\n)*)/.exec(text.slice(0, text.indexOf("\njobs:") + 1))?.[1] ?? null;
const runsOn = (text: string) => [...code(text).matchAll(/^\s+runs-on:\s*(.+)$/gm)].map((found) => found[1]!.trim());
/** One job's block, from its name to the next job's. */
const job = (text: string, id: string) => new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`).exec(text.slice(text.indexOf("\njobs:")))?.[1] ?? "";
/** The commands a job runs, in order. */
const commands = (block: string) => [...code(block).matchAll(/^\s+- run:\s*(.+)$/gm)].map((found) => found[1]!.trim());

describe("which workflows a pull request starts", () => {
  test("pr.yml on `pull_request`, cla.yml on `pull_request_target`, and no other workflow on either", () => {
    const started = readdirSync(DIR)
      .filter((name) => name.endsWith(".yml"))
      .flatMap((name) => [...code(read(name)).matchAll(/\n {2}(pull_request(?:_target)?):/g)].map((found) => `${name}: ${found[1]}`));
    expect(started.sort()).toEqual(["cla.yml: pull_request_target", "pr.yml: pull_request"]);
  });
});

describe("pr.yml runs a stranger's code, so it is given nothing", () => {
  test("its token only reads, and no job asks for more", () => {
    expect(topPermissions(pr)).toBe("\n  contents: read\n");
    expect(code(job(pr, "checks"))).not.toMatch(/^\s+permissions:/m);
  });

  test("it names no secret and no variable", () => {
    expect(code(pr)).not.toMatch(/secrets\./);
    expect(code(pr)).not.toMatch(/vars\./);
  });

  test("every job runs on GitHub's hosted runner, named outright: never where `CI_RUNNER` points", () => {
    expect(runsOn(pr)).toEqual(["ubuntu-24.04"]);
  });

  test("the checkout leaves no credential in the working copy, and takes no private submodule", () => {
    const checkout = /- uses: actions\/checkout@[^\n]+\n((?: {8,}.*\n)*)/.exec(pr)?.[1] ?? "";
    expect(checkout).toContain("persist-credentials: false");
    expect(checkout).not.toMatch(/submodules|token:|ssh-key:/);
  });

  test("it runs what the asked-for suite runs, command for command", () => {
    // ci.yml's `verify` is what a release is held to. A pull request held to less is a change nobody tested.
    expect(commands(job(pr, "checks"))).toEqual(commands(job(ci, "verify")).filter((command) => !command.includes("submodule")));
    expect(commands(job(pr, "checks"))).toContain("bun run test");
  });
});

describe("cla.yml holds a token that writes, so it runs nothing of the pull request", () => {
  test("no action and no checkout: nothing of the pull request is ever on the runner", () => {
    expect(code(cla)).not.toMatch(/\buses:/);
    expect(code(cla)).not.toMatch(/git (clone|fetch|checkout)|gh pr (checkout|diff)/);
  });

  test("its token is given nothing workflow-wide, and its one job a status to write and two things to read", () => {
    expect(topPermissions(cla)).toBe(" {}\n");
    const asked = /\n {4}permissions:\n((?: {6}.*\n)*)/.exec(job(cla, "cla"))?.[1] ?? "";
    expect(asked.split("\n").filter(Boolean).map((line) => line.trim()).sort()).toEqual(["issues: read", "pull-requests: read", "statuses: write"]);
  });

  test("every job runs on GitHub's hosted runner, named outright", () => {
    expect(runsOn(cla)).toEqual(["ubuntu-24.04"]);
  });

  test("its script is handed nothing of the event but the pull request's number, in the environment", () => {
    const script = cla.slice(cla.indexOf("        run: |"));
    // An expression inside the script would be pasted into it as text: a title or a branch name written to be a command.
    expect(script).not.toContain("${{");
    const taken = [...code(cla).matchAll(/\$\{\{([^}]*)\}\}/g)].map((found) => found[1]!.trim()).filter((expression) => expression.includes("github.event"));
    for (const expression of taken) {
      expect(expression.replace(/github\.event\.(pull_request\.number|issue\.number|issue\.pull_request)\b|github\.event_name|github\.repository_owner/g, "")).not.toContain("github.");
    }
  });

  test("it asks for the sentence the contributing guide tells an author to comment", () => {
    const sentence = /sentence="([^"]+)"/.exec(cla)?.[1];
    expect(sentence).toBe("I have read the CLA Document and I hereby sign the CLA");
    expect(readFileSync(join(ROOT, "docs/CONTRIBUTING.md"), "utf8")).toContain(`> ${sentence}`);
  });

  test("it says waiting, never failed: a pull request nobody has agreed on yet is not a broken one", () => {
    expect(cla).toContain("state=success; else state=pending;");
    expect(code(cla)).not.toMatch(/state=(failure|error)/);
  });
});

/** The filter cla.yml hands `jq`, taken from the workflow as written. */
const FILTER = /jq -s --arg author "\$author" --arg sentence "\$sentence" '([\s\S]*?)'\n/.exec(cla)?.[1] ?? "";
const SENTENCE = "I have read the CLA Document and I hereby sign the CLA";
const hasJq = spawnSync("jq", ["--version"]).status === 0;

/** Whether `author` agreed, by the workflow's own filter over one page of comments as GitHub's API returns them. */
function agreed(comments: { user: string; body: string }[], author = "txtsamu"): boolean {
  const page = JSON.stringify(comments.map((comment) => ({ user: { login: comment.user }, body: comment.body })));
  const ran = spawnSync("jq", ["-s", "--arg", "author", author, "--arg", "sentence", SENTENCE, FILTER], { input: page, encoding: "utf8" });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return ran.stdout.trim() === "true";
}

describe("who has agreed, by the filter cla.yml runs", () => {
  test("the filter is in the workflow to be read", () => {
    expect(FILTER).toContain("select(.user.login == $author)");
  });

  test.skipIf(!hasJq)("the author's comment that is the sentence: alone, as GitHub sends its lines, in a code span, with a full stop, in any case", () => {
    for (const body of [SENTENCE, `${SENTENCE}\r\n`, `\`${SENTENCE}\``, `${SENTENCE}.`, SENTENCE.toLowerCase(), `  **${SENTENCE}**  `]) {
      expect({ body, agreed: agreed([{ user: "txtsamu", body }]) }).toEqual({ body, agreed: true });
    }
  });

  test.skipIf(!hasJq)("the sentence as a line of its own in a longer comment, and among other people's comments", () => {
    expect(agreed([{ user: "txtsamu", body: `Sure, here it is:\r\n\r\n${SENTENCE}\r\n\r\nThanks for the review.` }])).toBe(true);
    expect(agreed([{ user: "gadingnst", body: "Please agree to the CLA." }, { user: "txtsamu", body: "On it." }, { user: "txtsamu", body: SENTENCE }])).toBe(true);
  });

  test.skipIf(!hasJq)("not somebody else's comment, and not the maintainer's own request quoted back", () => {
    expect(agreed([{ user: "gadingnst", body: SENTENCE }])).toBe(false);
    expect(agreed([{ user: "txtsamu", body: `> ${SENTENCE}\r\n\r\nWhat does this cover?` }])).toBe(false);
  });

  test.skipIf(!hasJq)("not the sentence inside another one, part of it, or no comment at all", () => {
    expect(agreed([{ user: "txtsamu", body: `I will not say "${SENTENCE}" until my employer answers.` }])).toBe(false);
    expect(agreed([{ user: "txtsamu", body: "I hereby sign the CLA" }])).toBe(false);
    expect(agreed([])).toBe(false);
  });
});
