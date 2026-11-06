/**
 * What happens to a command's output once there is more of it than the daemon will keep.
 *
 * Two bugs lived here. Past the cap the reader was cancelled, which closes the pipe — and a child that
 * writes to a closed pipe is killed by SIGPIPE, so a build whose log outgrew the cap died partway and
 * reported a failure it never had. And the cut was on a byte, so a cap landing inside a multi-byte
 * character turned it into U+FFFD.
 */

import { describe, expect, test } from "bun:test";
import { runCommand } from "../src/process.ts";

const sandbox = { cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 1000, env: { PATH: process.env.PATH ?? "" } };

/** Prints far past the cap on stdout, then proves it survived by writing to stderr. */
const LOUD_THEN_DONE = ["sh", "-c", 'i=0; while [ $i -lt 3000 ]; do echo "line $i"; i=$((i+1)); done; echo finished >&2'];

describe("past the cap", () => {
  test("the command keeps running to the end instead of dying on a closed pipe", async () => {
    const result = await runCommand(LOUD_THEN_DONE, sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("finished");
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(1000);
    expect(result.stdout).toStartWith("line 0\n");
  });

  test("a cap inside a multi-byte character drops it rather than corrupting it", async () => {
    // "é" is two bytes, so a 3-byte cap lands in the middle of the second one.
    const result = await runCommand(["printf", "ééé"], { ...sandbox, maxOutputBytes: 3 });

    expect(result.stdout).toBe("é");
    expect(result.stdout).not.toContain("�");
    expect(result.truncated).toBe(true);
  });

  test("output under the cap is whole and not marked truncated", async () => {
    const result = await runCommand(["printf", "ééé"], sandbox);

    expect(result.stdout).toBe("ééé");
    expect(result.truncated).toBe(false);
  });
});

describe("onOutput", () => {
  test("every chunk arrives, in order, and nothing is held in the result", async () => {
    const seen: string[] = [];
    const result = await runCommand(LOUD_THEN_DONE, {
      ...sandbox,
      onOutput: (stream, text) => seen.push(stream === "stdout" ? text : `<err:${text}>`),
    });

    const stdout = seen.filter((chunk) => !chunk.startsWith("<err:")).join("");
    expect(stdout.split("\n").filter(Boolean)).toHaveLength(3000);
    expect(seen.join("")).toContain("<err:finished\n>");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
