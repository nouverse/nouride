/**
 * An atomic write given a mode creates the file with it.
 *
 * The secret store was written with the umask's mode and chmodded after the rename: readable by any local user for
 * that moment, and for good when a crash fell between the two. `Bun.write` takes no mode, which is why this exists.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextFileAtomic } from "../src/fs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-atomic-"));
  dirs.push(dir);
  return dir;
};
const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("writeTextFileAtomic with a mode", () => {
  test("is created 0600 with nothing chmodding it after", async () => {
    const path = join(fresh(), "secrets.json");
    await writeTextFileAtomic(path, "{}\n", { mode: 0o600 });
    expect(modeOf(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });

  test("a temp file a crashed run left is never opened again: it keeps its mode, and the write its own", async () => {
    const dir = fresh();
    const path = join(dir, "secrets.json");
    // Where every write of this pid used to go, and where a crash used to leave one, mode and all.
    const stale = `${path}.${process.pid}.tmp`;
    writeFileSync(stale, "stale", { mode: 0o644 });
    await writeTextFileAtomic(path, "{}\n", { mode: 0o600 });
    expect(modeOf(path)).toBe(0o600);
    expect(readFileSync(stale, "utf8")).toBe("stale");
  });

  test("without one, a file is written as before", async () => {
    const path = join(fresh(), "MEMORY.md");
    await writeTextFileAtomic(path, "# memory\n");
    expect(readFileSync(path, "utf8")).toBe("# memory\n");
  });

  test("without one, a file it replaces keeps its permissions — a 0640 config stays 0640", async () => {
    // The temp file was the umask's, so the rename left every saved config.toml readable by every local user.
    const path = join(fresh(), "config.toml");
    writeFileSync(path, "[daemon]\n");
    chmodSync(path, 0o640);
    await writeTextFileAtomic(path, "[daemon]\nlog_level = \"info\"\n");
    expect(modeOf(path)).toBe(0o640);
    // Exactly the bits it had, whatever the umask narrows a create to.
    chmodSync(path, 0o664);
    await writeTextFileAtomic(path, "[daemon]\n");
    expect(modeOf(path)).toBe(0o664);
  });
});

describe("two writes of one path in flight", () => {
  test("both land, the file holds one of them whole, and no temp file is left behind", async () => {
    // They shared `<path>.<pid>.tmp`: the first rename took it and the second failed on a file that was gone.
    const dir = fresh();
    const path = join(dir, "config.toml");
    const texts = Array.from({ length: 20 }, (_, i) => `# ${i}\n${"x".repeat(50_000)}\n`);
    await Promise.all(texts.map((text) => writeTextFileAtomic(path, text)));
    expect(texts).toContain(readFileSync(path, "utf8"));
    expect(readdirSync(dir)).toEqual(["config.toml"]);
  });
});
