/**
 * The harness says what asks at the level this turn is at (0.8.0), in every block that says it — never a line that
 * contradicts another. The TOOLS block's level line names `balanced`'s few; the files block's: a delete outside the
 * workspace and a credential read are `careful`'s alone, a credential leaving asks at `balanced` too, nothing at `trusted`.
 */

import { describe, expect, test } from "bun:test";
import { BALANCED_ASKS, HARDLINE_SUMMARY } from "@nouride/policy";
import type { ApprovalLevel } from "@nouride/shared";
import { renderExecPolicy } from "@/modules/llm/prompt/exec-policy.ts";
import { renderFiles } from "@/modules/llm/prompt/harness-files.ts";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";

function view(approvals: ApprovalLevel): HarnessView {
  const harness = {
    approvalAvailable: true,
    approvalRequired: [],
    approvals,
    workspace: { dir: "/w/shared", privateDir: "/w/private/nouva", roots: ["/w/shared", "/w/private/nouva"] },
    credentialsDir: "/srv/nouride/.nouride/credentials",
    execSecrets: [{ name: "pypi_token", commands: ["twine upload"] }],
  };
  return { ctx: { harness, tools: [{ name: "exec" }] }, toolNames: ["exec"], gated: [], free: ["exec"] } as unknown as HarnessView;
}

const files = (approvals: ApprovalLevel) => renderFiles(view(approvals)).join("\n");
const tools = (approvals: ApprovalLevel) => renderTools(view(approvals)).join("\n");
const exec = (approvals: ApprovalLevel) => renderExecPolicy({ grantsHeld: 0 }, false, approvals).join("\n");

describe("the TOOLS block's level line", () => {
  test("balanced names what still stops — the same few as the exec lines, never 0.7.x's list", () => {
    const text = tools("balanced");
    expect(text).toContain(
      "What still stops for a human, every time: changing a config.toml, giving someone access, stopping this daemon, replacing or deleting a stored secret, a credential leaving this machine, changing this machine's system packages, installing a program for every agent, changing your own persona, and changing who People says a person is.",
    );
    expect(text).not.toContain("recursive deletes");
  });

  test("trusted says only what every level asks still asks — config changes and stopping this daemon do not", () => {
    const text = tools("trusted");
    expect(text).toContain(
      "**Almost nothing will ask**: only installing a program for every agent, changing your own persona, and changing who People says a person is.",
    );
    expect(text).toContain("including deletes, config changes and stopping this daemon");
  });
});

/**
 * Each class on the fixed list as the model reads it. A class put on the list and in no line here fails these: 0.8.15
 * put `system-packages` on `balanced`'s, and the prompt went on naming the five it had named since 0.8.0 — as it had
 * for the classes 0.8.1 to 0.8.9 added.
 */
const SAID: Record<string, string> = {
  config: "changing a config.toml",
  access: "giving someone access",
  stop: "stopping this daemon",
  secret: "replacing or deleting a stored secret",
  "credential-out": "a credential leaving this machine",
  "system-packages": "changing this machine's system packages",
  "shared-tools": "installing a program for every agent",
  persona: "changing your own persona",
  people: "changing who People says a person is",
  replace: "replacing this daemon",
  database: "reading this daemon's database",
  delete: "deleting outside your workspace",
  teardown: "tearing infrastructure down",
  unattended: "scheduling a job that runs unasked",
  interactive: "starting an interactive session",
  "force-push": "force-pushing",
};
/** Never named: the daemon's own state is a path no agent has business in, and work nobody watches is told where it sends. */
const UNSAID = new Set(["own-state", "unwatched"]);
/** What `trusted` asks too. */
const EVERY_LEVEL = new Set(["shared-tools", "persona", "people"]);
const named = HARDLINE_SUMMARY.map((row) => row.class).filter((cls) => !UNSAID.has(cls));

describe("each class on the fixed list is named where its level asks it", () => {
  test("careful's line names the whole list", () => {
    for (const cls of named) {
      expect(Object.keys(SAID)).toContain(cls);
      expect(exec("careful")).toContain(SAID[cls]!);
    }
  });

  test("balanced's two lines name what balanced asks, and nothing careful asks alone", () => {
    for (const cls of named) {
      for (const text of [exec("balanced"), tools("balanced")]) {
        if (BALANCED_ASKS.has(cls)) expect(text).toContain(SAID[cls]!);
        else expect(text).not.toContain(SAID[cls]!);
      }
    }
  });

  test("trusted's two lines name what every level asks; its exec line nothing else", () => {
    for (const cls of named) {
      if (EVERY_LEVEL.has(cls)) {
        expect(exec("trusted")).toContain(SAID[cls]!);
        expect(tools("trusted")).toContain(SAID[cls]!);
      } else {
        expect(exec("trusted")).not.toContain(SAID[cls]!);
      }
    }
  });
});

describe("what the files block says asks", () => {
  test("careful: a delete outside the workspace, a credential read, a credential leaving", () => {
    const text = files("careful");
    expect(text).toContain("A delete outside your workspace asks every time and can never be pre-approved.");
    expect(text).toContain("a command that reads a credential path asks a human first");
    expect(text).toContain("such a command asks a human before it runs");
    expect(text).toContain("a command that sends one off this machine asks first");
  });

  test("balanced: only a credential leaving", () => {
    const text = files("balanced");
    expect(text).not.toContain("A delete outside your workspace asks");
    expect(text).not.toContain("reads a credential path asks");
    expect(text).toContain("such a command asks a human before it runs");
    expect(text).toContain("a command that sends one off this machine asks first");
  });

  test("trusted: none of it", () => {
    const text = files("trusted");
    for (const line of ["A delete outside your workspace asks", "reads a credential path asks", "asks a human before it runs", "sends one off this machine asks"]) {
      expect(text).not.toContain(line);
    }
  });
});
