/**
 * The control token is 0640 on disk, and the daemon puts it back there at every start.
 *
 * Group-readable on purpose: the members of the service group run the CLI without sudo, which reads this file. The
 * Docker page once listed it among the 0600 files, and an operator tightening it to match would lose the group's CLI
 * — until the next start, which sets it back. `nouride doctor` accepts nothing more open.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlToken } from "@/modules/web/control/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-token-"));
  dirs.push(dir);
  return dir;
};
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("the control token", () => {
  test("is made 0640, and is the value the CLI reads", async () => {
    const dir = dataDir();
    const token = await ensureControlToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(join(dir, ".control-token"))).toBe(0o640);
    expect(readFileSync(join(dir, ".control-token"), "utf8").trim()).toBe(token);
  });

  test("tightened to 0600, or opened wider, is set back to 0640 at the next start, its value kept", async () => {
    for (const changed of [0o600, 0o644]) {
      const dir = dataDir();
      writeFileSync(join(dir, ".control-token"), "a".repeat(64) + "\n", { mode: changed });
      expect(mode(join(dir, ".control-token"))).toBe(changed);
      expect(await ensureControlToken(dir)).toBe("a".repeat(64));
      expect(mode(join(dir, ".control-token"))).toBe(0o640);
    }
  });
});
