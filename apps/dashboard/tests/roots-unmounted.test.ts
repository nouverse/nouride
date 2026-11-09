/**
 * A test file that draws a React root unmounts it. A root left mounted keeps its components' queries alive, and their
 * timers (a 30 s staleness among them) fired after the file's window was gone: "window is not defined" failed whichever
 * engine test happened to run then, a different one each time, and read as a flaky test of its own.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;

test("every file that calls createRoot also unmounts", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".ts") && name !== "roots-unmounted.test.ts");
  const leaky = files.filter((name) => {
    const text = readFileSync(join(DIR, name), "utf8");
    return /\bcreateRoot\(/.test(text) && !/\.unmount\(\)/.test(text);
  });
  expect(files.length).toBeGreaterThan(100);
  expect(leaky).toEqual([]);
});
