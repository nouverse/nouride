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

  test("a stdio MCP server that lost its sign-in: the cause, the person's fixes, and no looking in other folders", () => {
    expect(guide).toContain("one that kept its sign-in or settings in the daemon's HOME still connects, but answers as if never signed in or set up");
    expect(guide).toContain("sign it in again for each agent, give it its token through `env_secrets` where it reads one, or copy what it saved into the agent's own folder");
    expect(guide).toContain("Do not read another agent's folder or the daemon's HOME to look.");
  });
});
