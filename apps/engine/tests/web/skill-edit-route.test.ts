/**
 * Editing a pool skill from the dashboard, and the one skill that may never be edited.
 *
 * `GET /skills/:name/source` has always existed and there was no way to write the file back — the
 * only writers were the reflection loop and `skill_create`, both of which go through a model. A
 * person who spotted a wrong line had to ssh in.
 *
 * The built-in refusal is the part worth testing rather than trusting. Built-ins ship inside the
 * executable's `skills/` directory, so on a packaged install the file is not the operator's and on a
 * source checkout it is version-controlled: an edit here would look permanent and be undone by the
 * next upgrade, which is worse than being told no.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSkillRoutes } from "@/modules/web/control/routes/skills.ts";

const root = mkdtempSync(join(tmpdir(), "nouride-skill-edit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), body);
}

const POOL_SKILL = `---
name: deployment
description: Ship a binary to a server.
requires: ssh
author: nouva
created: 2026-08-01
---

## Procedure
1. build it
`;

const BUILTIN_SKILL = `---
name: document-reading
description: Read a PDF.
---

## Procedure
1. pdftotext
`;

interface Harness {
  put: (name: string, body: unknown) => Promise<Response>;
  reloads: () => number;
  audited: () => { action: string; details?: Record<string, unknown> }[];
  poolFile: (name: string) => string;
}

function harness(role = "operator"): Harness {
  // A directory per harness: two tests editing the same file would pass alone and disagree together.
  const agentsDir = mkdtempSync(join(root, "agents-"));
  const builtinDir = mkdtempSync(join(root, "builtin-"));
  mkdirSync(join(agentsDir, "skills"), { recursive: true });
  writeSkill(join(agentsDir, "skills"), "deployment", POOL_SKILL);
  writeSkill(builtinDir, "document-reading", BUILTIN_SKILL);

  let reloads = 0;
  const audited: { action: string; details?: Record<string, unknown> }[] = [];
  const deps = {
    ctx: { config: { daemon: { agentsDir }, skills: { off: [] } } },
    builtinSkillsDir: builtinDir,
    registry: { all: () => [], reloadAll: async () => void (reloads += 1) },
    audit: { record: (row: { action: string; details?: Record<string, unknown> }) => void audited.push(row) },
    settings: {},
  };

  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role });
    await next();
  });
  registerSkillRoutes(app as never, deps as never);

  return {
    put: async (name, body) =>
      await app.request(`/skills/${name}/source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    reloads: () => reloads,
    audited: () => audited,
    poolFile: (name) => readFileSync(join(agentsDir, "skills", name, "SKILL.md"), "utf8"),
  };
}

describe("POST /skills/:name/source", () => {
  test("rewrites a pool skill and reloads every agent", async () => {
    /**
     * Every agent, not one. A pooled skill is in all of their prompts, so reloading a single pack
     * would leave the rest serving the body that was just replaced — and nothing would say so.
     */
    const h = harness();
    const edited = POOL_SKILL.replace("1. build it", "1. build it\n2. push it");
    const res = await h.put("deployment", { source: edited });

    expect(res.status).toBe(200);
    expect(h.poolFile("deployment")).toContain("2. push it");
    expect(h.reloads()).toBe(1);
    expect(h.audited().map((row) => row.action)).toContain("skill_edited");
  });

  test("a built-in is refused, and the refusal says what to do instead", async () => {
    const h = harness();
    const res = await h.put("document-reading", { source: BUILTIN_SKILL.replace("pdftotext", "something else") });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("cannot be edited");
    // The operation that does exist for them, named in the error rather than left to be guessed.
    expect(payload.error).toContain("Switch it off");
    expect(h.reloads()).toBe(0);
  });

  test("provenance survives an edit, and `updated` is stamped", async () => {
    // `author` and `created` say where a skill came from, and a person fixing a typo in it is not
    // its new author. Losing that on the first edit would make "who worked this out" unanswerable.
    const h = harness();
    await h.put("deployment", { source: POOL_SKILL.replace("1. build it", "1. build") });

    const written = h.poolFile("deployment");
    expect(written).toContain("author: nouva");
    expect(written).toContain("created: 2026-08-01");
    expect(written).toMatch(/updated: \d{4}-\d{2}-\d{2}/);
  });

  test("an empty description is refused", async () => {
    /**
     * `description` is the line the prompt matches a task against, so a skill without one loads and
     * never triggers: present, inert, and impossible to diagnose from the outside. Refused here
     * rather than accepted, because the person is looking at the form right now.
     */
    const h = harness();
    const res = await h.put("deployment", { source: POOL_SKILL.replace("description: Ship a binary to a server.", "") });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("description");
    expect(h.poolFile("deployment")).toContain("1. build it");
  });

  test("an empty body is refused", async () => {
    const h = harness();
    const res = await h.put("deployment", { source: POOL_SKILL.replace("## Procedure\n1. build it\n", "") });

    expect(res.status).toBe(400);
    expect(h.poolFile("deployment")).toContain("1. build it");
  });

  test("a skill that is not there is a 404, not a create", async () => {
    // `PUT` on a missing name must not conjure a skill: the pool is what every agent reads, and
    // creating one by typo is how a skill nobody wrote ends up in six prompts.
    const h = harness();
    expect((await h.put("not-a-skill", { source: POOL_SKILL })).status).toBe(404);
  });

  test("a viewer cannot write", async () => {
    const h = harness("viewer");
    const res = await h.put("deployment", { source: POOL_SKILL.replace("1. build it", "1. nope") });
    expect(res.status).toBe(403);
    expect(h.poolFile("deployment")).toContain("1. build it");
  });
});
