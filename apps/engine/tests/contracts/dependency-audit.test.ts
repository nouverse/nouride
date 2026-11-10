/**
 * The packages Nouride is built from are checked against published advisories once a day and before a release, never
 * on a push: an advisory against somebody else's package, published that day, would turn `ci` red for a change that
 * did nothing wrong, and keep it red for every push until the package moved. Critical only, and from the lockfile
 * alone, so the check installs nothing and runs no package's scripts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const audit = readFileSync(join(ROOT, ".github/workflows/audit.yml"), "utf8");
const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
/** The workflow's triggers: what stands under `on:` until the next top-level key. */
const triggers = /\non:\n((?: {2}.*\n)*)/.exec(audit)?.[1] ?? "";

describe("the dependency audit", () => {
  test("asks for critical advisories, by one script", () => {
    expect(scripts.audit).toBe("bun audit --audit-level=critical");
    expect(audit).toMatch(/^\s+- run: bun run audit$/m);
  });

  test("runs once a day and by hand, never on a push or a pull request", () => {
    expect(triggers).toMatch(/^ {2}schedule:\n {4}- cron: "\d+ \d+ \* \* \*"$/m);
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toMatch(/^ {2}(push|pull_request)\b/m);
  });

  test("is not part of `ci`, `verify` or the pre-commit checks, which a push must be able to pass", () => {
    expect(scripts.verify).not.toContain("audit");
    expect(scripts["lint:check"]).not.toContain("audit");
    expect(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")).not.toMatch(/bun (run )?audit/);
  });

  test("installs nothing: it reads the lockfile, so no package's own scripts run", () => {
    expect(audit).not.toMatch(/bun install|bun i\b/);
    expect(audit).toContain("persist-credentials: false");
    expect(/\npermissions:\n((?: {2}.*\n)*)/.exec(audit)?.[1]).toBe("  contents: read\n");
  });
});
