/**
 * The verbs of this daemon's own CLI that answer for a person or change who may talk to the agents are copied into
 * `@nouride/policy` (`own-cli.ts`), which puts each in front of a person when an agent runs it. The copy was checked
 * only with literal verbs of its own: a verb added to the CLI and not to the copy would have reached the daemon from an
 * agent with no one asked. These hold the copy to the CLI's own lists.
 */

import { describe, expect, test } from "bun:test";
import { classifyHardline } from "@nouride/policy";
import { dispatchedArgv } from "@/cli/args.ts";
import { ACCESS_CHANGES } from "@/cli/commands/access.ts";
import { APPROVAL_ACTIONS } from "@/cli/commands/approvals.ts";

const gated = (args: string[]) => classifyHardline(["nouride", ...args]) !== null;

describe("the CLI's own verbs, run by an agent", () => {
  test("every answer `nouride approvals` takes reaches a person — with an id and without", () => {
    for (const action of APPROVAL_ACTIONS) {
      expect({ action, withId: gated(["approvals", action, "apr_1"]), bare: gated(["approvals", action]) }).toEqual({ action, withId: true, bare: true });
    }
  });

  test("every `nouride access` verb that changes somebody's standing does too, and so does setting the mode", () => {
    for (const action of ACCESS_CHANGES) expect({ action, gated: gated(["access", action, "telegram:bot:1"]) }).toEqual({ action, gated: true });
    expect(gated(["access", "mode", "open"])).toBe(true);
  });

  test("putting an agent to sleep or waking it reaches a person, under either name — an agent does not silence another (0.8.0)", () => {
    for (const action of ["sleep", "wake", "pause", "resume"]) expect({ action, gated: gated(["agent", action, "nox"]) }).toEqual({ action, gated: true });
    expect(gated(["agent", "reload", "nox"])).toBe(false);
  });

  test("a system package installed, removed or upgraded through nouride-pkg is on the list; checking one is not (0.8.15)", () => {
    for (const action of ["install", "remove", "upgrade"]) expect({ action, cls: classifyHardline(["nouride", "pkg", action, "jq"])?.class }).toEqual({ action, cls: "system-packages" });
    for (const args of [["pkg"], ["pkg", "status"], ["pkg", "check", "install", "jq"], ["pkg", "refresh"]]) expect({ args, gated: gated(args) }).toEqual({ args, gated: false });
  });

  test("a skill root added or removed through the CLI is asked as the agent's own request is: a persona change (0.8.24)", () => {
    for (const action of ["add", "rm"]) expect({ action, cls: classifyHardline(["nouride", "agent", "skill-root", action, "nix", "/srv/projects/app"])?.class }).toEqual({ action, cls: "persona" });
    expect(classifyHardline(["nouride", "--json", "agent", "skill-root", "add", "nix", "."])?.class).toBe("persona");
  });

  test("installing for every agent asks under trusted too, and turning an agent external or back changes its config (0.8.1)", () => {
    expect(classifyHardline(["nouride", "tools", "run", "--", "npm", "i", "-g", "x"])?.class).toBe("shared-tools");
    for (const args of [["agent", "external", "nix", "claude-code"], ["agent", "internal", "nix"]]) expect(classifyHardline(["nouride", ...args])?.class).toBe("config");
  });

  test("the policy reads an argv as the CLI dispatches it — `dispatchedArgv`, which its copy follows", () => {
    // Read at fixed positions, `--json` before the verb or the action put every one of these on no list, while the CLI
    // took the flag off and ran it. Each is classified as the words the CLI runs are, and is on the list.
    for (const raw of [
      ["--json", "tools", "run", "--", "npm", "i", "-g", "x"],
      ["tools", "--json", "run", "--", "npm", "i", "-g", "x"],
      ["--json", "cron", "add", "--command", "id"],
      ["cron", "--json", "add", "--command", "id"],
      ["--json", "approvals", "allow-always"],
      ["approvals", "allow-always", "--json"],
      ["--json", "agent", "external", "kuro", "claude-code"],
      ["--json=access", "allow", "telegram:main:9"],
      ["cron", "add", "--command=nouride access allow telegram:main:9"],
      ["--json", "db", "--", "restore", "x.db"],
    ]) {
      const dispatched = dispatchedArgv(raw).argv;
      const verdict = classifyHardline(["nouride", ...raw]);
      expect({ raw, verdict }).toEqual({ raw, verdict: classifyHardline(["nouride", ...dispatched]) });
      expect({ raw, listed: verdict !== null }).toEqual({ raw, listed: true });
    }
  });

  test("and the verbs that only read stay ordinary — a gate on reading is one an operator switches off", () => {
    for (const args of [["approvals"], ["approvals", "list"], ["access"], ["access", "pending"], ["access", "mode"], ["access", "list"]]) {
      expect({ args, gated: gated(args) }).toEqual({ args, gated: false });
    }
  });
});
