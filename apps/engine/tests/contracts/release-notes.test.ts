/**
 * What the two release pages say.
 *
 * Both used to be the commit subjects since the previous tag, and v0.7.8's named a private host — so the PUBLIC page
 * carried it until its body was replaced by hand, as every release's had been, to put the written notes there instead.
 * `docs/releases/<tag>.md` is that text, and the pages are written from it; without it the subjects are the floor, and
 * the public page leaves out any `check-public.ts` would refuse.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { licensingIn, privateValuesHeld, releaseBodies } from "../../../../scripts/release/release-notes.ts";

const ROOT = join(import.meta.dir, "../../../..");
const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

const base = { tag: "v0.7.9", previous: "v0.7.8", repo: "nouverse/nouride-legacy", publicRepo: "nouverse/nouride" };

/**
 * Written so this file names nothing private itself: `check-public.ts` scans it, and a literal host here would be the
 * leak this guards against. Joined at run time, the way such a subject reaches `git log`.
 */
const privateHost = ["agent", "nouverse"].join(".");

describe("a release with written notes", () => {
  test("both pages are the notes, and the compare link they already end with is not added twice", () => {
    // 0.7.10's notes carry what 0.7.8 and 0.7.9 shipped — those two are withdrawn from the public mirror — so they end
    // with their own link from v0.7.7. The tag before it in this repository is still v0.7.9: the notes' link wins.
    const notes = readFileSync(join(ROOT, "docs/releases/v0.7.10.md"), "utf8");
    const bodies = releaseBodies({ ...base, tag: "v0.7.10", previous: "v0.7.9", notes, subjects: ["fix: something only git knows"] });
    expect(bodies.public).toBe(`${notes.trimEnd()}\n`);
    expect(bodies.internal).toBe(bodies.public);
    expect(bodies.public.match(/\*\*Full Changelog\*\*/g)?.length).toBe(1);
    expect(bodies.public).toContain("/compare/v0.7.7...v0.7.10");
    // The subjects are not read when there are notes.
    expect(bodies.public).not.toContain("something only git knows");
  });

  test("notes without a compare link get one per page, each to its own repository", () => {
    const bodies = releaseBodies({ ...base, notes: "## What changed\n\n- a thing\n", subjects: [] });
    expect(bodies.internal).toBe(
      "## What changed\n\n- a thing\n\n**Full Changelog**: https://github.com/nouverse/nouride-legacy/compare/v0.7.8...v0.7.9\n",
    );
    expect(bodies.public).toBe(
      "## What changed\n\n- a thing\n\n**Full Changelog**: https://github.com/nouverse/nouride/compare/v0.7.8...v0.7.9\n",
    );
  });

  test("notes that name something private stop the release rather than reach the public page", () => {
    expect(() => releaseBodies({ ...base, notes: `Deployed on ${privateHost} first.\n`, subjects: [] })).toThrow(/names something private/);
  });
});

describe("a release without them", () => {
  const subjects = [
    "chore(release): v0.7.9",
    `docs(proposals): what exercising 0.7.8 on ${privateHost} showed`,
    "fix(update): an off-box Pro install is told where its release is",
  ];

  test("lists the commits on both pages, but the public one leaves out a subject that names something private", () => {
    const bodies = releaseBodies({ ...base, notes: null, subjects });
    expect(bodies.internal).toContain(`- docs(proposals): what exercising 0.7.8 on ${privateHost} showed`);
    expect(bodies.public).not.toContain(privateHost);
    expect(bodies.public).toContain("- fix(update): an off-box Pro install is told where its release is");
    expect(bodies.withheld).toBe(1);
  });

  test("the version bump is not a change worth listing", () => {
    const bodies = releaseBodies({ ...base, notes: null, subjects });
    expect(bodies.internal).not.toContain("chore(release)");
  });

  test("each page links its own repository's compare view", () => {
    const bodies = releaseBodies({ ...base, notes: null, subjects });
    expect(bodies.internal.trimEnd().endsWith("https://github.com/nouverse/nouride-legacy/compare/v0.7.8...v0.7.9")).toBe(true);
    expect(bodies.public.trimEnd().endsWith("https://github.com/nouverse/nouride/compare/v0.7.8...v0.7.9")).toBe(true);
  });

  test("the first release says so", () => {
    expect(releaseBodies({ ...base, previous: null, notes: null, subjects: [] }).public).toBe("First release.\n");
  });
});

describe("the release workflow", () => {
  test("writes both pages with that script, from the tagged tree", () => {
    expect(workflow).toContain("bun run scripts/release/release-notes.ts --tag \"${GITHUB_REF_NAME}\" --previous \"${prev}\"");
    expect(workflow).toContain("--internal /tmp/release-notes-internal.md --public /tmp/release-notes-public.md");
    // The bodies are not built in the shell any more: that is the path that published a private host.
    expect(workflow).not.toContain("git log --no-merges --format='- %s'");
  });

  /**
   * HARDENING §3: the job checked out no submodule, so the public page was held to the plain patterns alone — the
   * hashed private values `lint:public` holds the tree to are in `internals/pro`. Proved here by the job's shape; the
   * job itself runs only on a tag.
   */
  test("holds the public page to the private values: internals/pro checked out after the last job's are removed, and required", () => {
    // The job, from its key to the next one at the same indent.
    const start = workflow.indexOf("\n  guard-visibility:\n");
    const next = /\n {2}[a-z][a-z0-9-]*:\n/g;
    next.lastIndex = start + 1;
    const job = workflow.slice(start, next.exec(workflow)?.index ?? workflow.length);
    const at = (needle: string) => job.indexOf(needle);
    const cleanup = at("- name: Start without the last job's submodules");
    const pro = at("- name: Check out internals/pro, for the private values the public notes are held to");
    const notes = at("bun run scripts/release/release-notes.ts");
    expect({ cleanup: cleanup > 0, pro: pro > cleanup, notes: notes > pro }).toEqual({ cleanup: true, pro: true, notes: true });
    const step = job.slice(pro, job.indexOf("\n      - ", pro + 1));
    expect(step).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    // The token through `-c`, as the other jobs pass it: a global config outlives the job on the self-hosted runner.
    expect(step).toContain('git -c "url.https://x-access-token:${TOKEN}@github.com/.insteadOf=https://github.com/" submodule update --init --depth 1 internals/pro');
    expect(step).not.toMatch(/^\s*git config/m);
    expect(job.slice(notes, job.indexOf("\n\n", notes))).toContain("--require-private-values");
    // And nothing between the two takes it away again (Nox's review, N8).
    expect(job.slice(pro + 1, notes)).not.toMatch(/submodule deinit|rm -rf[^\n]*internals|git clean/);
  });
});

describe("which private values the public page is held to", () => {
  test("said either way, and refused without the hashed list when it is required", () => {
    expect(privateValuesHeld({ ["0".repeat(64)]: "a host" }, true)).toEqual({ ok: true, line: "private values: the public page is held to the plain patterns and internals/pro's 1 hashed value(s)" });
    expect(privateValuesHeld(null, false)).toMatchObject({ ok: true, line: expect.stringContaining("filtered by the plain patterns alone") });
    expect(privateValuesHeld(null, true)).toMatchObject({ ok: false, line: expect.stringContaining("--require-private-values refuses that") });
  });
});

/**
 * Release notes are a product's changelog, read on the public mirror — not an open-source project's log. 0.8.2's and
 * 0.8.3's told how Pro is licensed: the licence link's template, its identity file, the admin and the update gate.
 */
describe("notes that tell how Pro is licensed", () => {
  const template = ["curl -fsSL https://service.nouverse.tech/", "licenses", "/nouride/<code>/install.sh | sudo sh"].join("");

  test("are refused before either page is written", () => {
    const notes = `### Pro on a server\n\n\`\`\`bash\n${template}\n\`\`\`\n`;
    expect(() => releaseBodies({ ...base, tag: "v0.8.2", previous: "v0.8.1", notes, subjects: [] })).toThrow(/tells how Pro is licensed — .*line 4, a licence's install link/);
    expect(licensingIn("By hand: `install.sh --variant pro --tarball <file> --identity device.json`")).toEqual(["line 1, a licence's identity file"]);
    expect(licensingIn("carries its floor to Nouverse's update gate")).toEqual(["line 1, the update gate"]);
  });

  test("and every release's notes in the tree tell none of it", () => {
    for (const file of readdirSync(join(ROOT, "docs/releases")).filter((name) => name.endsWith(".md"))) {
      expect({ file, told: licensingIn(readFileSync(join(ROOT, "docs/releases", file), "utf8")) }).toEqual({ file, told: [] });
    }
  });
});
