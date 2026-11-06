/**
 * A skill's own directory, from the operator's side.
 *
 * Until this existed, the dashboard showed `SKILL.md` and nothing else, and the only way to remove a
 * stale support file was the `skill_improve` tool's `remove_files` — an agent's verb. Measured on
 * the live pool on 2026-09-08: 14 of 23 skills ship support files, and **1.2MB of a 1.7MB pool was
 * unreferenced PNG screenshots** left behind by an agent's runs. Nobody could see them and nobody
 * could delete them.
 *
 * The fixture is that pool in miniature, including the two shapes the schema does not describe:
 * a `tools/` directory (which is `scripts/` under another name, written by an agent's plain `write`
 * tool) and a binary.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteSupportFile,
  listSupportFiles,
  readSupportFile,
  writeSupportFile,
} from "@nouride/persona";

const root = mkdtempSync(join(tmpdir(), "nouride-skill-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SKILL = `---
name: poster
description: Post a thing.
---

## Procedure
1. run tools/post.js
2. see references/hosts.md
`;

function fixture(): string {
  const agentsDir = mkdtempSync(join(root, "agents-"));
  const dir = join(agentsDir, "skills", "poster");
  mkdirSync(join(dir, "references"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tools", "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL);
  writeFileSync(join(dir, "references", "hosts.md"), "# Hosts\n\nthe notes");
  writeFileSync(join(dir, "scripts", "wake.py"), "#!/usr/bin/env python3\nprint('hi')\n");
  writeFileSync(join(dir, "tools", "post.js"), "// posts a thing\n");
  // The junk this whole module exists to make visible: real bytes, nothing points at it.
  writeFileSync(join(dir, "tools", "reply_error.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  // Inside a support directory, so a lister that recursed would report a dependency tree as the
  // skill's own content.
  writeFileSync(join(dir, "tools", "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  return agentsDir;
}

describe("listSupportFiles", () => {
  test("it lists every one-level file, classified, and says what nothing points at", async () => {
    const files = await listSupportFiles(fixture(), "poster");
    expect(files.map((f) => f.path)).toEqual([
      "references/hosts.md",
      "scripts/wake.py",
      "tools/post.js",
      "tools/reply_error.png",
    ]);

    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["references/hosts.md"]).toMatchObject({ kind: "markdown", editable: true, referenced: true });
    // `tools/` is `scripts/` renamed, and the classification says so rather than going by extension.
    expect(by["tools/post.js"]).toMatchObject({ kind: "script", editable: false, referenced: true });
    expect(by["scripts/wake.py"]).toMatchObject({ kind: "script", editable: false });
    // The finding that motivated the whole thing.
    expect(by["tools/reply_error.png"]).toMatchObject({ kind: "binary", editable: false, referenced: false });
    expect(by["tools/reply_error.png"]?.bytes).toBe(6);
  });

  test("a directory inside a support directory is not walked", async () => {
    // `x-twitter-poster/tools/` holds a `node_modules`. A lister that recursed would bury the four
    // scripts the skill actually runs under its dependencies.
    const files = await listSupportFiles(fixture(), "poster");
    expect(files.some((f) => f.path.includes("node_modules"))).toBe(false);
  });

  test("a name that is not a skill is empty, not a throw", async () => {
    expect(await listSupportFiles(fixture(), "../../etc")).toEqual([]);
    expect(await listSupportFiles(fixture(), "not-there")).toEqual([]);
  });
});

describe("readSupportFile", () => {
  test("text comes back; a binary is refused with what can be done instead", async () => {
    const agentsDir = fixture();
    const md = await readSupportFile(agentsDir, "poster", "references/hosts.md");
    expect(md.ok && md.text).toContain("the notes");
    // A script is readable — you must be able to see what your agents run.
    const js = await readSupportFile(agentsDir, "poster", "tools/post.js");
    expect(js.ok && js.kind).toBe("script");

    const png = await readSupportFile(agentsDir, "poster", "tools/reply_error.png");
    expect(png.ok).toBe(false);
    if (!png.ok) expect(png.error).toContain("listed and deleted");
  });

  test("a traversal cannot reach a file that really is there", async () => {
    /**
     * The path comes from a browser, so it is bounded rather than trusted. Written with a real file
     * planted above the skill, because the version of this test that pointed at
     * `../../../config.toml` passed with the guard deleted — nothing exists there from a temp dir,
     * so it missed for the wrong reason.
     */
    const agentsDir = fixture();
    writeFileSync(join(agentsDir, "not-yours.txt"), "SENTINEL-c0ffee");
    for (const path of ["../../not-yours.txt", "references/../../../not-yours.txt", "SKILL.md", "hosts.md"]) {
      const result = await readSupportFile(agentsDir, "poster", path);
      expect(result.ok).toBe(false);
    }
  });
});

describe("writeSupportFile", () => {
  test("markdown is replaced", async () => {
    const agentsDir = fixture();
    expect((await writeSupportFile(agentsDir, "poster", "references/hosts.md", "# Hosts\n\ncorrected")).ok).toBe(true);
    const back = await readSupportFile(agentsDir, "poster", "references/hosts.md");
    expect(back.ok && back.text).toContain("corrected");
  });

  test("a script is refused, and the refusal explains provenance rather than danger", async () => {
    /**
     * The boundary, and the reasoning behind it. Safety cannot be the argument: a `SKILL.md` reading
     * `curl … | sh` is exactly as dangerous as a script, because the agent holds `exec` either way.
     * The real rule is that the loop may only ship a script that *actually ran and worked*, so one
     * edited in a browser has by construction never run — editing it turns a verified tool into
     * somebody's guess, silently.
     */
    const agentsDir = fixture();
    const result = await writeSupportFile(agentsDir, "poster", "scripts/wake.py", "print('changed')\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ran and worked");
      expect(result.error).toContain("Delete it");
    }
    const unchanged = await readSupportFile(agentsDir, "poster", "scripts/wake.py");
    expect(unchanged.ok && unchanged.text).toContain("print('hi')");
  });

  test("writing stays on the allow-list even where reading does not", async () => {
    // `tools/` is listed and read because it exists in the real pool; it is not written to, because
    // blessing it would ratify drift that happened by accident through the plain `write` tool.
    const result = await writeSupportFile(fixture(), "poster", "tools/notes.md", "# notes\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("references/<name>");
  });

  test("a file that is not there is refused rather than created", async () => {
    // A new support file arrives with a draft, where the body's pointer to it is reviewed at the
    // same time. Created here, it would be exactly the dead weight this module exists to remove.
    const result = await writeSupportFile(fixture(), "poster", "references/new.md", "# new\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("arrive with a skill draft");
  });
});

describe("deleteSupportFile", () => {
  test("it removes any kind, and reports whether the body pointed at it", async () => {
    const agentsDir = fixture();
    const junk = await deleteSupportFile(agentsDir, "poster", "tools/reply_error.png");
    expect(junk).toMatchObject({ ok: true, wasReferenced: false });
    expect(existsSync(join(agentsDir, "skills", "poster", "tools", "reply_error.png"))).toBe(false);

    /**
     * Reported, not refused. A pointer to a file that is gone is worse than a file nothing points at
     * — `x-twitter-poster` already names a `tools/.env` that does not exist — so the operator has to
     * be told and then has to be able to proceed: the fix is to remove the file and the line.
     */
    const wanted = await deleteSupportFile(agentsDir, "poster", "tools/post.js");
    expect(wanted).toMatchObject({ ok: true, wasReferenced: true });
  });

  test("a traversal deletes nothing", async () => {
    const agentsDir = fixture();
    writeFileSync(join(agentsDir, "not-yours.txt"), "keep me");
    expect((await deleteSupportFile(agentsDir, "poster", "../../not-yours.txt")).ok).toBe(false);
    expect(existsSync(join(agentsDir, "not-yours.txt"))).toBe(true);
  });
});
