/**
 * The daemon's look at its skill folders (0.8.13): a skill copied in, edited or removed is read again for every agent
 * without a restart; folders as they were ask nothing; a refresh that failed is tried again at the next look.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsWatch } from "@/boot/skills-watch.ts";

let dir: string;
const write = (name: string, description: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-skills-watch-"));
  write("slides", "Make a deck.");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a new skill on disk is read again for the agents; nothing new asks nothing; a failed read is tried again", async () => {
  let refreshes = 0;
  let failing = false;
  const watch = new SkillsWatch({
    dirs: () => [dir, join(dir, "no-such-pool")],
    refresh: async () => {
      refreshes += 1;
      if (failing) throw new Error("a pack would not read");
      return ["nova"];
    },
  });
  expect(await watch.check()).toBeNull();
  expect(refreshes).toBe(0);

  write("diagrams", "Draw boxes and arrows.");
  failing = true;
  await expect(watch.check()).rejects.toThrow("a pack would not read");
  failing = false;
  // Still unread: the next look reads it.
  expect(await watch.check()).toEqual(["nova"]);
  expect(await watch.check()).toBeNull();
  expect(refreshes).toBe(2);
});
