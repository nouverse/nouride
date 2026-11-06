/**
 * Where credentials may not live.
 *
 * The whole credentials design rests on one property: the directory is outside every root the file
 * tools accept. There is no check at read time — `read` simply refuses paths outside its roots — so
 * putting the directory *inside* one silently converts a private key into something the agent can
 * pull into a conversation.
 *
 * Silently is the operative word. The daemon boots, the scripts work, and nothing looks different.
 * That is why this is a refusal at boot rather than a warning.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertCredentialsUnreadable } from "@nouride/persona";
import { fakeAgent } from "../helpers.ts";

const INSTALL = "/srv/nouride/.nouride";
const SKILLS = join(INSTALL, "agents", "skills");
const WORKSPACE = join(INSTALL, "workspace");

function guard(credentialsDir: string, agentOverrides: { roots?: string[]; skillRoots?: string[]; dir?: string } = {}) {
  const agent = fakeAgent();
  agent.dir = agentOverrides.dir ?? join(INSTALL, "agents", "nouva");
  agent.config.workspaceRoots = agentOverrides.roots ?? [];
  agent.config.skillRoots = agentOverrides.skillRoots ?? [];
  return () =>
    assertCredentialsUnreadable({
      credentialsDir,
      agents: [agent],
      skillsDir: SKILLS,
      workspaceDirs: [WORKSPACE],
    });
}

describe("a directory whose name starts with two dots", () => {
  test("inside a readable root is refused like any other — `..creds` was read as outside it", () => {
    expect(guard(join(WORKSPACE, "..creds"))).toThrow();
  });
});

describe("safe placements", () => {
  test("the default, beside the database", () => {
    expect(guard(join(INSTALL, "data", "credentials"))).not.toThrow();
  });

  test("`agents/shared/.credentials`, which is the layout config.example.toml documents", () => {
    // Safe because the readable root is `agents/skills`, and `agents/shared` is not a root at all —
    // it holds credentials and nothing the file tools reach.
    expect(guard(join(INSTALL, "agents", "shared", ".credentials"))).not.toThrow();
  });

  test("somewhere else entirely", () => {
    expect(guard("/mnt/nas/nouride-credentials")).not.toThrow();
  });
});

describe("placements that would let the model read a key", () => {
  test("inside an agent's own pack", () => {
    // The pack is a workspace root so the agent can read IDENTITY.md and write MEMORY.md. Anything
    // else in there is readable for the same reason.
    expect(guard(join(INSTALL, "agents", "nouva", ".credentials"))).toThrow(/inside the pack/);
  });

  test("inside the skills directory", () => {
    // `agents/skills/.credentials` — the pool is a read root for every agent, so a credential
    // parked in it is one any of them can pull into a conversation.
    expect(guard(join(SKILLS, ".credentials"))).toThrow(/skills/);
  });

  test("inside a declared workspace root", () => {
    expect(
      guard("/home/me/project/.credentials", { roots: ["/home/me/project"] }),
    ).toThrow(/\[workspace\] roots/);
  });

  test("inside a skill root's skills directory", () => {
    // Skill roots are readable so the agent can read the skills it was offered.
    expect(
      guard("/home/me/project/.agents/skills/.credentials", { skillRoots: ["/home/me/project"] }),
    ).toThrow(/skill_roots|roots/);
  });

  test("the workspace itself", () => {
    expect(guard(join(WORKSPACE, "credentials"))).toThrow(/workspace/);
  });

  test("exactly equal to a root, not merely inside one", () => {
    expect(guard(join(INSTALL, "agents", "nouva"))).toThrow();
  });

  test("the message names the setting that reaches it, not just that something does", () => {
    // An operator with five roots cannot act on "it is inside a root".
    let message = "";
    try {
      guard("/home/me/project/.credentials", { roots: ["/home/me/project"] })();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("/home/me/project");
    expect(message).toContain("credentials_dir");
  });
});

describe("path traversal is not a way around it", () => {
  test("a root reached by a relative walk still counts", () => {
    expect(
      guard(join(INSTALL, "agents", "nouva", "..", "nouva", ".credentials")),
    ).toThrow();
  });
});
