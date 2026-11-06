/**
 * What `nouride config explain` and the dashboard say about the settings 0.8.1 changed under them — read by a person
 * deciding, and by an agent through the `nouride` tool. Each said less than the code does: `trusted` was "asks
 * nothing" while two classes ask at every level, the orchestrator could be named external, fallbacks did not say a
 * dropped stream counts as down, and an `[[external_clis]]` row listed half the keys it reads.
 */

import { describe, expect, test } from "bun:test";
import { findField } from "@/modules/config/schema.ts";

/** A field's words as one line: where the source wraps them is not part of what they say. */
function said(path: string): string {
  const field = findField(path);
  if (!field) throw new Error(`no field ${path}`);
  return `${field.description} ${field.caveat ?? ""}`.replace(/\s+/g, " ");
}

describe("what the config's own docs say since 0.8.1", () => {
  test("`trusted` names the classes every level still asks — four since 0.8.9 — and `balanced` asks them too", () => {
    const approvals = said("security.approvals");
    expect(approvals).toContain("and the four classes every level asks; `trusted` asks nothing but those four");
    expect(approvals).toContain("a program installed for every agent (`nouride tools run`)");
    expect(approvals).toContain("a change to an agent's own persona");
    expect(approvals).toContain("a change to who People says a person is (`people set|remove`, `access approve --as|--me|--new`)");
    expect(approvals).not.toContain("`trusted` asks nothing.");
    // 0.8.15: back on `balanced`'s list.
    expect(approvals).toContain("this machine's system packages changed (`nouride pkg install|remove|upgrade`)");
  });

  test("the orchestrator is never an external agent, and a start that finds one runs without one", () => {
    const orchestrator = said("daemon.orchestrator");
    expect(orchestrator).toContain("Never an external agent (0.8.1)");
    expect(orchestrator).toContain("a start that finds one anyway runs with no orchestrator and says so");
  });

  test("fallbacks say what counts as down, and that a reply already begun is not handed on", () => {
    const fallbacks = said("llm.defaults.fallbacks");
    expect(fallbacks).toContain("a refused connection, a timeout, a stream dropped before its reply began");
    expect(fallbacks).toContain("A stream that fails after its reply began is not fallen back on.");
    expect(fallbacks).toContain("its closing call uses the list too");
  });

  test("an [[external_clis]] row names every key it reads, and whose user it runs as", () => {
    const row = said("external_clis");
    for (const key of ["id", "name", "command", "args", "install", "version_args", "profile_env", "modes", "instruction_file", "login", "login_note", "status", "signed_out"]) {
      expect({ key, named: row.includes(`\`${key}\``) }).toEqual({ key, named: true });
    }
    expect(row).toContain("one a built-in row has (`claude-code`, `codex`) is refused");
    expect(row).toContain("as the agent's own user where the helper `install.sh` sets up is installed, as the daemon's user elsewhere");
  });
});
