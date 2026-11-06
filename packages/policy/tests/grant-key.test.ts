/**
 * Grant identity.
 *
 * A key that is too loose turns one human "yes" into standing permission for commands the human
 * never saw, and that failure is silent — it looks like the gate working. So these tests are
 * mostly about what must produce *different* keys.
 */

import { describe, expect, test } from "bun:test";
import { execGrantKey, executedFileArgIndex, GRANT_KEY_VERSION } from "../src/grant-key.ts";

const base = { agentId: "nouva", cwd: "/ws", argv: ["npm", "run", "build"] };

describe("execGrantKey", () => {
  test("is stable for the same input", () => {
    expect(execGrantKey(base)).toBe(execGrantKey({ ...base }));
  });

  test("carries its version, so a digest change is visible rather than silent", () => {
    // Openclaw's source warns that changing the digest input silently orphans every persisted
    // grant. The prefix turns that into something `nouride grants list` can explain.
    expect(execGrantKey(base).startsWith(`${GRANT_KEY_VERSION}:`)).toBe(true);
  });

  test.each([
    ["agent", { agentId: "other" }],
    ["cwd", { cwd: "/elsewhere" }],
    ["argv", { argv: ["npm", "run", "deploy"] }],
    ["argv length", { argv: ["npm", "run"] }],
    ["file digest", { fileSha256: "abc123" }],
  ])("a different %s produces a different key", (_label, patch) => {
    expect(execGrantKey({ ...base, ...patch })).not.toBe(execGrantKey(base));
  });

  test("argv boundaries cannot be smuggled across", () => {
    // A separator join would make these identical, and the whole grant would then cover a
    // command the operator never approved.
    expect(execGrantKey({ ...base, argv: ["npm", "run build"] })).not.toBe(
      execGrantKey({ ...base, argv: ["npm", "run", "build"] }),
    );
    expect(execGrantKey({ ...base, argv: ["a", "bc"] })).not.toBe(
      execGrantKey({ ...base, argv: ["ab", "c"] }),
    );
  });

  test("an absent file digest is not the same as an empty one", () => {
    expect(execGrantKey({ ...base, fileSha256: undefined })).toBe(execGrantKey(base));
  });
});

describe("executedFileArgIndex", () => {
  test.each([
    [["bash", "deploy.sh"], 1],
    [["sh", "-x", "deploy.sh"], 2],
    [["python3", "-u", "train.py"], 2],
    [["node", "server.js"], 1],
    [["bun", "run", "x.ts"], 1],
    [["/usr/bin/python3", "script.py"], 1],
  ])("%j → index %i", (argv, expected) => {
    expect(executedFileArgIndex(argv)).toBe(expected);
  });

  test("a non-interpreter has no executed file operand", () => {
    // `cat deploy.sh` reads it; nothing about the grant should depend on its contents.
    expect(executedFileArgIndex(["cat", "deploy.sh"])).toBeNull();
    expect(executedFileArgIndex(["git", "status"])).toBeNull();
  });

  test("inline code has no file operand", () => {
    // Nothing on disk whose change should revoke the grant — the code is in the argv, which is
    // already fully bound into the key.
    expect(executedFileArgIndex(["python3", "-c", "print(1)"])).toBeNull();
    expect(executedFileArgIndex(["node", "-e", "console.log(1)"])).toBeNull();
    expect(executedFileArgIndex(["bash", "-c", "ls"])).toBeNull();
  });

  test("an interpreter with no arguments has no file operand", () => {
    expect(executedFileArgIndex(["bash"])).toBeNull();
    expect(executedFileArgIndex(["python3", "-u"])).toBeNull();
  });
});
