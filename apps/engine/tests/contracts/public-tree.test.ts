/**
 * What `lint:public` keeps out of the published tree: an install's identifiers.
 *
 * Two shapes went through it. A Discord snowflake is 17 to 20 digits and the scan read 16, so the homelab's bot ids
 * sat in a comment, a type's doc and a dozen tests. A 192.168 address named its LAN. The ids below are fakes with a
 * deny-list of their own: the real hashes are in `internals/pro`, and the real values in no file at all.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findingsIn,
  type Hashed,
  PRIVATE_VALUES,
  privatePointers,
  privateTree,
  type PrivateTree,
  readDenylist,
} from "../../../../scripts/check-public.ts";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const BOT = "1000000000000000401";
const OPERATOR = "100000000000000302";
const DENYLIST: Hashed = { [sha(BOT)]: "a homelab bot's Discord id", [sha(OPERATOR)]: "the operator's Discord id" };
const REAL = join(import.meta.dir, "../../../../internals/pro/publish-denylist.json");

describe("the published tree", () => {
  test("refuses the homelab's Discord ids, however many digits they run to", () => {
    expect(findingsIn("a.md", `mention it as <@${BOT}>`, DENYLIST).map((f) => f.what)).toEqual(["a homelab bot's Discord id"]);
    expect(findingsIn("a.ts", `const owner = "${OPERATOR}";`, DENYLIST).map((f) => f.what)).toEqual(["the operator's Discord id"]);
    expect(findingsIn("a.ts", `<@1111111111111111111>`, DENYLIST)).toEqual([]);
  });

  // CI's public job has no Pro checkout, and the exported tree has none at all.
  test.skipIf(!existsSync(REAL))("compares against Pro's deny-list, all of it, where Pro is checked out", () => {
    // Read through the check's own path: a wrong one would load nothing and pass everything.
    expect(PRIVATE_VALUES).toEqual(JSON.parse(readFileSync(REAL, "utf8")));
  });

  test("a deny-list that is there but is not one is an error, not an empty list that passes everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-denylist-"));
    const at = (text: string): string => {
      const path = join(dir, "publish-denylist.json");
      writeFileSync(path, text);
      return path;
    };
    try {
      expect(readDenylist(join(dir, "absent.json"))).toBeNull();
      expect(readDenylist(at(JSON.stringify(DENYLIST)))).toEqual(DENYLIST);
      for (const wrong of ["{}", "[]", JSON.stringify({ list: DENYLIST }), JSON.stringify({ [sha(BOT)]: "" }), '{"abc": "a kind"}']) {
        expect(() => readDenylist(at(wrong))).toThrow("is not a deny-list");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a source map, and a reference to one — a map carries the private source", () => {
    const ref = ["//# sourceMappingURL", "nouride.js.map"].join("=");
    expect(findingsIn("dist/nouride-pro-linux-x64.map", `{"version":3}`).map((f) => f.what)).toEqual([
      "a source map — private source, kept on the internal release only",
    ]);
    expect(findingsIn("apps/x.js", `run()\n${ref}\n`)).toEqual([{ file: "apps/x.js", line: 2, what: "a source map reference" }]);
    // Saying the word is not shipping a map: docs and this very check talk about `sourceMappingURL`.
    expect(findingsIn("docs/RELEASING.md", "no `sourceMappingURL=` is left in a tarball")).toEqual([]);
  });

  test("refuses a LAN address outside the example subnet, 192.168.0.x", () => {
    const lan = ["192.168", "1.54"].join(".");
    expect(findingsIn("a.md", `ssh ${lan}`).map((f) => f.what)).toEqual(["a LAN address (examples use 192.168.0.x)"]);
    expect(findingsIn("a.md", "ssh 192.168.0.54")).toEqual([]);
  });
});

/**
 * A published file points at nothing the export leaves out.
 *
 * Fifty pointers led there in 2026-10 — the memory modules citing their private design, the docs index linking the
 * backlog — each a dead end once exported. The private names are put together at run time here too: written out,
 * each would be a finding in this file.
 */
describe("a pointer from the published tree", () => {
  const path = (...parts: string[]) => parts.join("/");
  // The review, archived when 0.7.x closed: as private as it was.
  const backlog = path("archive", ["IMPROVEMENT", "PROPOSALS.md"].join("_"));
  const design = path("internals", "pro", "docs", "SOME_DESIGN.md");
  const skill = path(".agents", "skills", "nouride-deploy");
  const tree: PrivateTree = {
    published: (rel) => !rel.startsWith("internals/") && !rel.startsWith(".agents/") && rel !== path("docs", backlog),
    paths: new Set([".agents", ".agents/skills", skill, path(skill, "SKILL.md")]),
    privateOnly: (doc) => doc === backlog || doc === "SOME_DESIGN.md",
  };
  const what = (file: string, text: string) => privatePointers(file, text, tree).map((f) => f.what);

  test("refuses a private design document, by its path or by its name", () => {
    expect(what("apps/x.ts", `// The reasoning: \`${design}\` §4.`)).toEqual([`\`${design}\` — a private document`]);
    expect(what("apps/x.ts", "// See SOME_DESIGN.md.")).toEqual(["`SOME_DESIGN.md` — a document only the private tree has"]);
    // A name a published file carries as well is not one of them; neither is private code the build checks out.
    expect(what("apps/x.ts", `// README.md, and ${path("internals", "pro", "appliance", "src", "box.ts")}`)).toEqual([]);
  });

  test("refuses a link into a path the export drops, and not one quoted as an example", () => {
    expect(what("docs/README.md", `the [backlog](./${backlog}).`)).toEqual([`a link to \`docs/${backlog}\`, which the export leaves out`]);
    expect(what("docs/README.md", "[SPEC](./SPEC.md) and `[x](../internals/y)` quoted")).toEqual([]);
  });

  test("refuses this repository's own skill, and not the skills directory an agent keeps at runtime", () => {
    expect(what("README.md", `see \`${skill}\``)).toEqual([`\`${skill}\` — this repository's own skill, which is private`]);
    expect(what("README.md", "a project's `.agents/skills/` and `.agents/skills/some-tool/SKILL.md`")).toEqual([]);
  });

  test("leaves a lockfile alone: it names paths in the repositories it locks", () => {
    expect(what("skills-lock.json", `"skillPath": "${path("skills", "x", "SOME_DESIGN.md")}"`)).toEqual([]);
  });

  // Not in a public export, which has no private half to read.
  test.skipIf(!existsSync(join(import.meta.dir, "../../../../.agents/skills")))("is judged against the real private tree, which it reads whole", async () => {
    // A tree read wrong finds nothing private and passes everything.
    const real = await privateTree();
    // The review, archived into Pro when 0.7.x closed: a document only the private tree has.
    const review = path("archive", ["v0.7.x", "IMPROVEMENT", "PROPOSALS.md"].join("_"));
    expect(real.published("docs/SPEC.md")).toBe(true);
    // The skills live in the private submodule since 2026-11-06; `.agents/skills` is only a link to them.
    expect(real.published(path("internals", "pro", ".agents", "skills", "nouride-contributing", "SKILL.md"))).toBe(false);
    expect(real.paths.has(path("internals", "pro", ".agents", "skills", "nouride-contributing"))).toBe(true);
    // A document only this repository's private half has — there in every job, the public one included.
    expect(real.privateOnly(path("nouride-deploy", "SKILL.md"))).toBe(true);
    // CI's public job has no Pro checkout, and the review is only there (0.7.17's CI found it).
    if (existsSync(join(import.meta.dir, "../../../../internals/pro/docs"))) expect(real.privateOnly(review)).toBe(true);
    expect(real.privateOnly("README.md")).toBe(false);
  });
});
