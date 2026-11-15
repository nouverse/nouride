/**
 * The built-in nouride skill's guide to working out why something is down (`references/diagnosing.md`): what is sent to
 * a model is behaviour, so these are the words that carry 0.8.1's two new cases — an external agent whose CLI cannot
 * answer, and a stdio MCP server that lost the sign-in it kept in the daemon's HOME.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// As one line: where Markdown wraps a sentence is not part of what it says.
const guide = readFileSync(join(import.meta.dir, "../../../../content/skills/nouride/references/diagnosing.md"), "utf8").replace(/\s+/g, " ");

describe("diagnosing, 0.8.1's cases", () => {
  test("an external agent whose CLI cannot answer: where the reason is, and whose each fix is", () => {
    expect(guide).toContain("its own model answers that message instead, and the reply opens by saying so");
    expect(guide).toContain("`nouride agents` gives its status, and an unavailable one says why");
    expect(guide).toContain("`nouride agents scan` says which CLIs this machine has");
    expect(guide).toContain("never run a CLI's login yourself");
  });

  test("which coding CLI this is and how it is updated: from the scan, on a person's word, never from another copy", () => {
    // Asked to update Claude Code, an agent named the version of another copy on its PATH and proposed that copy's updater.
    expect(guide).toContain("`nouride agents scan` says what each CLI runs on: the CLI's own version (Claude Code, Codex), the connector that carries it, the Node that runs that, and what is out of each");
    expect(guide).toContain("never from a copy of the CLI found on the PATH or from a package registry");
    expect(guide).toContain("`nouride agents update <cli>` installs the newest version out, whether or not this Nouride was tested with it");
    expect(guide).toContain("every agent on that CLI stops answering while it installs, it waits for their turns to end first");
    expect(guide).toContain("Run it on a person's word, since it touches every agent on that CLI.");
    expect(guide).toContain("An agent a coding CLI runs cannot update its own CLI: it asks the orchestrator.");
  });

  test("a stdio MCP server that lost its sign-in: the cause, the person's fixes, and no looking in other folders", () => {
    expect(guide).toContain("one that kept its sign-in or settings in the daemon's HOME still connects, but answers as if never signed in or set up");
    expect(guide).toContain("sign it in again for each agent, give it its token through `env_secrets` where it reads one, or copy what it saved into the agent's own folder");
    expect(guide).toContain("Do not read another agent's folder or the daemon's HOME to look.");
  });
});
