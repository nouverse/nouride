/**
 * A config's backups (`commons/backups.ts`): the same text as the file, so they carry its permissions (they were
 * written with the umask's: a `config.toml` at 0640 had `config.toml.bak.1` to `.bak.5` at 0644 beside it). Since 0.8.18
 * a burst of saves no longer pushes out what a file said yesterday: `.bak.1` is always the version just
 * before a save, the older slots move along at most once an hour, the same text is no new version, what falls off the
 * last slot goes to `history/`, and a boot that rewrites a file keeps it once as `<file>.before-<version>`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepBefore, rotateBackups } from "@/commons/backups.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const modeOf = (path: string) => statSync(path).mode & 0o777;
const HOUR = 60 * 60_000;

function config(): string {
  const dir = mkdtempSync(join(tmpdir(), "nouride-backups-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, "# now\n");
  chmodSync(path, 0o640);
  return path;
}
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

describe("a config's backups", () => {
  test("carry the config's permissions, the newest and the ones shifted along an hour apart", async () => {
    const path = config();
    const start = Date.now();
    await rotateBackups(path, "# first\n", start);
    await rotateBackups(path, "# second\n", start + HOUR);
    expect(read(`${path}.bak.1`)).toBe("# second\n");
    expect(read(`${path}.bak.2`)).toBe("# first\n");
    expect([modeOf(`${path}.bak.1`), modeOf(`${path}.bak.2`)]).toEqual([0o640, 0o640]);
  });

  test("within the hour a save replaces only the newest: a burst does not push yesterday out", async () => {
    const path = config();
    const start = Date.now();
    await rotateBackups(path, "# yesterday\n", start);
    await rotateBackups(path, "# this morning\n", start + 2 * HOUR);
    let minute = 0;
    for (const step of ["# a", "# b", "# c", "# d", "# e", "# f"]) await rotateBackups(path, `${step}\n`, start + 2 * HOUR + (minute += 5) * 60_000);
    // `.bak.1` is the version just before the last save, as `persona_edit` tells the model.
    expect(read(`${path}.bak.1`)).toBe("# f\n");
    expect(read(`${path}.bak.2`)).toBe("# yesterday\n");
    expect(read(`${path}.bak.3`)).toBeNull();
  });

  test("the same text as the newest is no new version", async () => {
    const path = config();
    const start = Date.now();
    await rotateBackups(path, "# one\n", start);
    const before = statSync(`${path}.bak.1`).mtimeMs;
    await rotateBackups(path, "# one\n", start + 3 * HOUR);
    expect(read(`${path}.bak.2`)).toBeNull();
    expect(statSync(`${path}.bak.1`).mtimeMs).toBe(before);
  });

  test("what falls off the fifth slot goes to history/, twenty versions deep", async () => {
    const path = config();
    const start = Date.now();
    for (let n = 1; n <= 30; n++) await rotateBackups(path, `# version ${n}\n`, start + n * HOUR);
    expect(read(`${path}.bak.1`)).toBe("# version 30\n");
    expect(read(`${path}.bak.5`)).toBe("# version 26\n");
    const history = readdirSync(join(path, "..", "history", "config.toml")).sort();
    expect(history).toHaveLength(20);
    expect(readFileSync(join(path, "..", "history", "config.toml", history.at(-1)!), "utf8")).toBe("# version 25\n");
    expect(readFileSync(join(path, "..", "history", "config.toml", history[0]!), "utf8")).toBe("# version 6\n");
  });
});

describe("the file as a version left it, before a boot rewrites it", () => {
  test("is kept once as <file>.before-<version>, and a second start keeps the first copy", async () => {
    const path = config();
    await keepBefore(path, "0.8.18");
    writeFileSync(path, "# rewritten by the boot\n");
    await keepBefore(path, "0.8.18");
    expect(read(`${path}.before-0.8.18`)).toBe("# now\n");
    expect(modeOf(`${path}.before-0.8.18`)).toBe(0o640);
  });
});
