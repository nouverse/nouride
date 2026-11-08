/**
 * What an exec grant is bound to: every file the command runs, read the same way with a secret or without —
 * a script run by its path, an interpreter's script, each segment of a `bash -lc` line, after any `cd` in it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGrantKey, looseSegments } from "@nouride/policy";
import { grantBinding } from "@/modules/tools/exec-binding.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "nouride-exec-binding-")));
mkdirSync(join(cwd, "sub"));
writeFileSync(join(cwd, "deploy.sh"), "echo deploy\n");
writeFileSync(join(cwd, "sub", "build.sh"), "echo build\n");
writeFileSync(join(cwd, "sub", "build.py"), "print('build')\n");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bound = (argv: string[], secrets: string[] = []) => grantBinding(argv, cwd, [cwd], "nouva", secrets);

describe("the files a command runs", () => {
  test("a script run by its path, alone or with arguments, is bound to its contents", () => {
    for (const argv of [["./deploy.sh"], ["./deploy.sh", "--prod"], [join(cwd, "deploy.sh")]]) {
      expect(bound(argv)).toMatchObject({ digest: { fileSha256: sha("echo deploy\n") }, pinned: true });
    }
  });

  test("one file's digest is its own sha256, so the key is the one a grant made before 0.7.7 holds", () => {
    const binding = bound(["bash", "deploy.sh"]);
    expect(binding.key).toBe(execGrantKey({ agentId: "nouva", cwd, argv: ["bash", "deploy.sh"], fileSha256: sha("echo deploy\n") }));
  });

  test("several files: the digest of their list", () => {
    const binding = bound(["bash", "-lc", "python3 sub/build.py && /bin/echo done && python3 sub/build.py"]);
    expect(binding).toMatchObject({ digest: { fileSha256: sha(`${sha("print('build')\n")}\n${sha("print('build')\n")}`) }, pinned: true });
  });

  test("a cd moves where the segments after it look", () => {
    expect(bound(["bash", "-lc", "cd sub && python3 build.py"])).toMatchObject({ digest: { fileSha256: sha("print('build')\n") }, pinned: true });
    // An absolute cd is taken as written — the relative case alone passed with absolute paths joined
    // onto the working directory.
    expect(bound(["bash", "-lc", `cd ${join(cwd, "sub")} && python3 build.py`])).toMatchObject({ digest: { fileSha256: sha("print('build')\n") }, pinned: true });
    // Somewhere it cannot know: nothing relative after it is bound, and the command is not pinned.
    expect(bound(["bash", "-lc", "cd ~ && python3 build.py"])).toMatchObject({ digest: {}, pinned: false });
    // Nor is a relative program after it an installed one.
    expect(bound(["bash", "-lc", "cd ~ && sub/build.sh"])).toMatchObject({ digest: {}, pinned: false });
    expect(bound(["bash", "-lc", "cd sub && /bin/echo built"])).toMatchObject({ digest: {}, pinned: true });
  });

  test("a line the strict reader gives up on is read loosely for its files, and never counts as pinned", () => {
    // `./deploy.sh` is no literal program name to the reader that decides what may run.
    expect(bound(["bash", "-lc", "./deploy.sh && echo done"])).toMatchObject({ digest: { fileSha256: sha("echo deploy\n") }, pinned: false });
    // An interpreter is a program that runs another, which the strict reader does not follow either.
    expect(bound(["bash", "-lc", "bash deploy.sh && bash sub/build.sh"])).toMatchObject({
      digest: { fileSha256: sha(`${sha("echo deploy\n")}\n${sha("echo build\n")}`) },
      pinned: false,
    });
    expect(bound(["bash", "-lc", "cd sub && ./build.sh > out.txt"])).toMatchObject({ digest: { fileSha256: sha("echo build\n") }, pinned: false });
  });

  test("a program by a path outside the roots is an installed one: named by the argv, not read", () => {
    expect(bound(["/bin/ls", "-la"])).toMatchObject({ digest: {}, pinned: true });
  });

  test("the secrets a command is handed are in its key, and only when there are any", () => {
    expect(bound(["./deploy.sh"], ["pypi_token"]).key).not.toBe(bound(["./deploy.sh"]).key);
    expect(bound(["./deploy.sh"], []).key).toBe(execGrantKey({ agentId: "nouva", cwd, argv: ["./deploy.sh"], fileSha256: sha("echo deploy\n") }));
  });
});

describe("looseSegments", () => {
  test("splits on the operators, drops quotes and leading assignments, and leaves an argv alone", () => {
    expect(looseSegments(["bash", "-lc", `FOO=1 "./x.sh" --a && (cd y; ./z) | tee log`])).toEqual([["./x.sh", "--a"], ["cd", "y"], ["./z"], ["tee", "log"]]);
    expect(looseSegments(["./x.sh", "&&", "y"])).toEqual([["./x.sh", "&&", "y"]]);
  });
});
