/**
 * The one delete a coding CLI may run without a person (0.8.7): every target inside its mission's own folder, read
 * from literal words, real paths and all. Every case here that is not inside is one the person is asked about. Run on
 * a real folder with real symlinks, so the real-path half is the filesystem's, not a fake's.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insideDelete, literalWords, type DeleteScope } from "@/modules/external-agents/inside-delete.ts";
import { tempDir } from "../helpers.ts";

let base = "";
let own = "";
let worktree = "";
let outside = "";
let scope: DeleteScope;

beforeAll(() => {
  // Its real path: macOS's temp folder is under /var, a link to /private/var, and a target is said by its real path.
  base = realpathSync(tempDir("inside-delete"));
  own = join(base, "missions", "msn_1");
  worktree = join(own, "worktree");
  outside = join(base, "outside");
  mkdirSync(join(worktree, "build"), { recursive: true });
  mkdirSync(join(own, "helper-1"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(worktree, "build", "out.js"), "x");
  writeFileSync(join(outside, "precious"), "x");
  symlinkSync(outside, join(worktree, "escape"));
  symlinkSync(join(outside, "precious"), join(worktree, "precious-link"));
  symlinkSync(join(worktree, "build"), join(worktree, "build-link"));
  symlinkSync(worktree, join(outside, "into-worktree"));
  scope = { roots: [own], keep: [own, worktree] };
});

const bash = (command: string) => ({ kind: "execute", rawInput: { command } });
const verdict = (command: string) => insideDelete(bash(command), scope);

describe("allowed without a person: every target inside the mission's folder", () => {
  test("rm -rf of a folder in its worktree, by absolute path — reported as the real path it deletes", () => {
    // Real, not as written: a temp folder behind a symlink (macOS's /var is /private/var) is where the two differ.
    expect(verdict(`rm -rf ${worktree}/build`)).toEqual({ inside: true, command: "rm", targets: [realpathSync(join(worktree, "build"))] });
  });

  test("several targets, flags spelled apart, a quoted path, a target that does not exist yet", () => {
    const result = verdict(`rm -r -f -- '${worktree}/build/out.js' "${own}/helper-1" ${worktree}/not-made-yet`);
    expect(result.inside).toBe(true);
  });

  test("a symlink that stays inside, rmdir, unlink, and git worktree remove of a helper's worktree", () => {
    expect(verdict(`rm ${worktree}/build-link`).inside).toBe(true);
    expect(verdict(`rmdir ${own}/helper-1`).inside).toBe(true);
    expect(verdict(`unlink ${worktree}/build/out.js`).inside).toBe(true);
    expect(verdict(`git worktree remove --force ${own}/helper-1`).inside).toBe(true);
  });

  test("an argv, and sh -c with its line; a relative path only beside the request's own absolute cwd", () => {
    expect(insideDelete({ rawInput: { command: ["rm", "-rf", `${worktree}/build`] } }, scope).inside).toBe(true);
    expect(insideDelete({ rawInput: { command: ["bash", "-lc", `rm -rf ${worktree}/build`] } }, scope).inside).toBe(true);
    expect(insideDelete({ rawInput: { command: "rm -rf build", cwd: worktree } }, scope).inside).toBe(true);
  });

  test("a CLI's own file delete, which names a path", () => {
    expect(insideDelete({ kind: "delete", rawInput: { path: `${worktree}/build/out.js` } }, scope).inside).toBe(true);
  });
});

describe("asked: anything that leaves the folder, or that this rule cannot read for certain", () => {
  const asked = (command: string) => {
    const result = verdict(command);
    expect(result.inside).toBe(false);
    return result.inside ? "" : result.why;
  };

  test("path traversal with ..", () => {
    expect(asked(`rm -rf ${worktree}/../../../outside`)).toContain("outside the mission's folder");
    expect(asked(`rm -rf ${worktree}/build/../../..`)).toContain("outside the mission's folder");
  });

  test("written outside, even where a symlink there leads back in: both the written path and the real one must be inside", () => {
    expect(asked(`rm -rf ${outside}/into-worktree/build`)).toBe(`${outside}/into-worktree/build is outside the mission's folder`);
  });

  test("a symlink that points outside — the link, and a path through it", () => {
    expect(asked(`rm ${worktree}/precious-link`)).toContain("resolves outside");
    expect(asked(`rm -rf ${worktree}/escape/precious`)).toContain("resolves outside");
    expect(asked(`rm -rf ${worktree}/escape/`)).toContain("resolves outside");
  });

  test("`..` after a symlink: the kernel follows the link first, so `escape/..` is the outside folder's parent, not the worktree", () => {
    // As text `worktree/escape/../x` is `worktree/x`; rm opens `outside/..`, which is `base`, and removes `base/x`.
    mkdirSync(join(base, "victim"), { recursive: true });
    expect(asked(`rm -rf ${worktree}/escape/../victim`)).toContain("resolves outside");
    expect(asked(`rm -rf ${worktree}/escape/../not-made-yet`)).toContain("resolves outside");
    // Through a link that stays inside, `..` lands inside too, and is allowed.
    expect(verdict(`rm -rf ${worktree}/build-link/../build/out.js`).inside).toBe(true);
  });

  test("a variable, ~, a glob, a brace — the shell's to expand, not this rule's", () => {
    for (const command of [`rm -rf $HOME/x`, `rm -rf "\${WORK}/build"`, "rm -rf ~/x", `rm -rf ${worktree}/build/*`, `rm -rf ${worktree}/b?ild`, `rm -rf ${worktree}/{build,src}`, `rm -rf ${worktree}/[b]uild`]) {
      expect(asked(command)).toContain("not literal words");
    }
  });

  test("chains, pipes, background, redirects and subshells", () => {
    for (const command of [
      `rm -rf ${worktree}/build; rm -rf ${outside}`,
      `rm -rf ${worktree}/build && curl x`,
      `rm -rf ${worktree}/build || true`,
      `echo ${worktree}/build | xargs rm -rf`,
      `rm -rf ${worktree}/build &`,
      `rm -rf ${worktree}/build > /dev/null`,
      `(rm -rf ${worktree}/build)`,
      `rm -rf $(echo ${outside})`,
      `rm -rf \`echo ${outside}\``,
      `rm -rf ${worktree}/build\nrm -rf ${outside}`,
    ]) {
      expect(asked(command)).toContain("not literal words");
    }
  });

  test("a relative path with no cwd of its own: the shell's folder is not known", () => {
    expect(asked("rm -rf build")).toContain("relative path");
  });

  test("the folder itself and the worktree itself", () => {
    expect(asked(`rm -rf ${own}`)).toContain("outside the mission's folder");
    expect(asked(`rm -rf ${worktree}`)).toContain("own folder or worktree");
    expect(asked(`rm -rf ${worktree}/`)).toContain("own folder or worktree");
    expect(asked(`git worktree remove --force ${worktree}`)).toContain("own folder or worktree");
  });

  test("anything outside, one target among several is enough", () => {
    expect(asked(`rm -rf ${worktree}/build ${outside}/precious`)).toContain("outside the mission's folder");
  });

  test("options this rule does not know, and commands that are not deletes", () => {
    expect(asked(`rm --no-preserve-root -rf ${worktree}/build`)).toContain("option");
    expect(asked(`rm -rfx ${worktree}/build`)).toContain("option");
    expect(asked(`rmdir -p ${own}/helper-1`)).toContain("option");
    expect(asked(`sudo rm -rf ${worktree}/build`)).toBe("not a delete");
    expect(asked(`FOO=1 rm -rf ${worktree}/build`)).toBe("not a delete");
    expect(asked(`find ${worktree} -delete`)).toBe("not a delete");
    expect(asked(`git -C ${worktree} worktree remove ${own}/helper-1`)).toBe("not a delete");
    expect(asked(`rm -rf`)).toBe("a delete with no target");
  });

  test("a target whose folder does not exist, and a mission folder that does not", () => {
    expect(asked(`rm -rf ${worktree}/nope/deeper`)).toContain("do not exist");
    expect(insideDelete(bash(`rm -rf ${base}/gone/x`), { roots: [join(base, "gone")], keep: [] })).toEqual({ inside: false, why: "the mission's folder does not exist" });
  });

  test("no command at all, or one that is not a string or argv", () => {
    expect(insideDelete({ rawInput: { title: "rm" } }, scope).inside).toBe(false);
    expect(insideDelete({ rawInput: null }, scope).inside).toBe(false);
    expect(insideDelete({ rawInput: { command: ["rm", 1] } }, scope).inside).toBe(false);
  });
});

describe("literal words", () => {
  test("quotes make one word; an unclosed quote or an escape is not read", () => {
    expect(literalWords(`rm -rf 'a b' "c d"`)).toEqual(["rm", "-rf", "a b", "c d"]);
    expect(literalWords(`rm 'a`)).toBeNull();
    expect(literalWords(`rm a\\ b`)).toBeNull();
    expect(literalWords(`rm "a\\"b"`)).toBeNull();
  });
});
