/**
 * What `exec` keeps of a command's output while it runs — see `exec-output.ts`.
 *
 * The properties that matter: small output is untouched, big output is on disk in full while memory
 * holds only its two ends, the tail is the real tail, and nothing unmasked ever reaches the file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { runAgentCommandsThrough } from "@nouride/runtime";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputCapture } from "@/modules/tools/builtins/exec-output.ts";

let dir: string;
let spoolPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-capture-"));
  spoolPath = join(dir, "call.txt");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "ghp_live_token_value_123";
const small = { env: { API_TOKEN: TOKEN }, diskCapChars: 10_000_000, memoryChars: 1_000, excerptChars: 200 };

/** Push `n` numbered lines to stdout, `per` lines per chunk. */
function feed(capture: OutputCapture, n: number, per = 7): void {
  let chunk = "";
  for (let i = 0; i < n; i += 1) {
    chunk += `line ${i}\n`;
    if ((i + 1) % per === 0) {
      capture.push("stdout", chunk);
      chunk = "";
    }
  }
  if (chunk) capture.push("stdout", chunk);
}

describe("small output", () => {
  test("is held whole, streams kept apart, and writes no file", () => {
    const capture = new OutputCapture({ ...small, spoolPath });
    capture.push("stdout", "hello\n");
    capture.push("stderr", "warning\n");

    const out = capture.finish();
    expect(out).toEqual({ spooled: false, stdout: "hello\n", stderr: "warning\n" });
    expect(() => statSync(spoolPath)).toThrow();
  });

  test("is masked", () => {
    const capture = new OutputCapture({ ...small, spoolPath });
    capture.push("stdout", `token=${TOKEN.slice(0, 5)}`);
    capture.push("stdout", `${TOKEN.slice(5)}\n`);

    const out = capture.finish();
    expect(out.spooled).toBe(false);
    if (!out.spooled) expect(out.stdout).toBe("token=[REDACTED:API_TOKEN]\n");
  });
});

describe("output that outgrows memory", () => {
  test("is on disk in full, in the order it arrived", () => {
    const capture = new OutputCapture({ ...small, spoolPath });
    capture.push("stdout", "before\n");
    capture.push("stderr", "err in the middle\n");
    feed(capture, 2_000);

    const out = capture.finish();
    const file = readFileSync(spoolPath, "utf8");
    expect(out.spooled).toBe(true);
    expect(file.startsWith("before\nerr in the middle\nline 0\n")).toBe(true);
    expect(file.endsWith("line 1999\n")).toBe(true);
    expect(file.split("\n")).toHaveLength(2_000 + 3);
  });

  test("keeps only the two ends in memory, and the tail is the real one", () => {
    const capture = new OutputCapture({ ...small, spoolPath });
    feed(capture, 50_000);

    const out = capture.finish();
    if (!out.spooled) throw new Error("expected a spool");
    expect(out.excerpt.length).toBeLessThan(2 * 200 + 200);
    expect(out.excerpt).toStartWith("line 0\n");
    expect(out.excerpt).toEndWith("line 49999\n");
    expect(out.excerpt).toContain("characters in the middle were not kept here");
  });

  test("measures the whole output, not the ends", () => {
    const capture = new OutputCapture({ ...small, spoolPath });
    feed(capture, 3_000);

    const out = capture.finish();
    if (!out.spooled) throw new Error("expected a spool");
    const file = readFileSync(spoolPath, "utf8");
    // `feed` ends every line with a newline, so 3000 lines is 3000 — not the 3001 a split would count.
    expect(out.output).toEqual({ path: spoolPath, chars: file.length, lines: 3_000 });
  });

  test("a last line with no newline still counts", () => {
    const capture = new OutputCapture({ ...small, spoolPath });
    feed(capture, 3_000);
    capture.push("stdout", "no newline at the end");

    const out = capture.finish();
    if (!out.spooled) throw new Error("expected a spool");
    expect(out.output.lines).toBe(3_001);
  });

  test("never puts an unmasked value on disk, even split across chunks", () => {
    // The file is readable by the agent. A value in it would be one `grep` away.
    const capture = new OutputCapture({ ...small, spoolPath });
    feed(capture, 500);
    for (let cut = 1; cut < TOKEN.length; cut += 3) {
      capture.push("stdout", `secret ${TOKEN.slice(0, cut)}`);
      capture.push("stdout", `${TOKEN.slice(cut)} end\n`);
    }
    feed(capture, 500);

    capture.finish();
    const file = readFileSync(spoolPath, "utf8");
    expect(file).not.toContain(TOKEN);
    expect(file).toContain("secret [REDACTED:API_TOKEN] end");
  });

  test("the file is not world-readable from the moment it exists", () => {
    const capture = new OutputCapture({ ...small, spoolPath });
    feed(capture, 2_000);
    capture.finish();

    expect(statSync(spoolPath).mode & 0o777).toBe(0o600);
  });

  test("where each agent is its own user, its group reads it — the agent is told the path, and greps it with a command", () => {
    runAgentCommandsThrough({ prefix: () => [], put: () => [] });
    try {
      const capture = new OutputCapture({ ...small, spoolPath });
      feed(capture, 2_000);
      capture.finish();
      expect(statSync(spoolPath).mode & 0o777).toBe(0o640);
    } finally {
      runAgentCommandsThrough(null);
    }
  });

  test("past the disk cap the file stops, says so, and the tail keeps moving", () => {
    const capture = new OutputCapture({ ...small, spoolPath, diskCapChars: 5_000 });
    feed(capture, 20_000);

    const out = capture.finish();
    if (!out.spooled) throw new Error("expected a spool");
    const file = readFileSync(spoolPath, "utf8");
    expect(out.cappedOnDisk).toBe(true);
    expect(file.length).toBeLessThan(5_000 + 300);
    expect(file).toContain("recording stopped here");
    // The model still sees how it ended, which is the part that says whether it worked.
    expect(out.excerpt).toEndWith("line 19999\n");
  });

  test("with nowhere to write, only the ends are kept and no file is claimed", () => {
    const capture = new OutputCapture({ ...small, spoolPath: join(dir, "missing", "call.txt") });
    feed(capture, 2_000);

    const out = capture.finish();
    if (!out.spooled) throw new Error("expected a spool");
    expect(out.output.path).toBeNull();
    expect(out.excerpt).toEndWith("line 1999\n");
  });

  test("when the whole output fits in the two ends, the ends are the output", () => {
    // Head and tail must not overlap, or a line near the join would be shown twice.
    const capture = new OutputCapture({ ...small, spoolPath, memoryChars: 50, excerptChars: 1_000 });
    feed(capture, 20);

    const out = capture.finish();
    if (!out.spooled) throw new Error("expected a spool");
    expect(out.excerpt).toBe(readFileSync(spoolPath, "utf8"));
  });
});
