/**
 * The image's `nouride` wrapper (`scripts/docker-nouride.sh`): the CLI inside a container reaches the daemon on the
 * port the container runs it on. Found by the public image smoke test (0.7.20): a container run with `PORT=18301`
 * answered `/health` there, and `docker exec … nouride status` asked 18254.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "../../../../scripts/docker-nouride.sh");
let bin: string;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "docker-cli-"));
  // A `bun` that says which daemon the CLI would ask, instead of running it.
  writeFileSync(join(bin, "bun"), '#!/bin/sh\necho "url=${NOURIDE_URL:-}"\n');
  chmodSync(join(bin, "bun"), 0o755);
});
afterEach(() => rmSync(bin, { recursive: true, force: true }));

const run = (env: Record<string, string>) =>
  spawnSync("sh", [WRAPPER, "status"], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: "utf8" }).stdout.trim();

describe("the CLI in the image", () => {
  test("asks the daemon on the container's PORT", () => {
    expect(run({ PORT: "18301" })).toBe("url=http://127.0.0.1:18301");
  });
  test("an address given outright wins, and no PORT leaves the CLI's own default", () => {
    expect(run({ PORT: "18301", NOURIDE_URL: "http://elsewhere:9" })).toBe("url=http://elsewhere:9");
    expect(run({})).toBe("url=");
  });
});
