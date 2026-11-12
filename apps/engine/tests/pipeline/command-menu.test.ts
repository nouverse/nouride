/**
 * The command list a platform's menu is published from (`Pipeline.commands`), held to the shortest menu there is:
 * Discord takes a description of a hundred characters and refuses the whole list over one that is longer. `/mention`'s
 * grew to 103, and no Discord bot's menu was published at all: each went on showing the commands published before.
 */

import { afterEach, expect, test } from "bun:test";
import { pipelineBench } from "../pipeline-bench.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup) dispose();
  cleanup = [];
});

test("every command's description fits the shortest menu a platform has, so none is cut there", async () => {
  const bench = await pipelineBench({});
  cleanup.push(bench.dispose);

  const commands = bench.pipeline.commands();
  expect(commands.length).toBeGreaterThan(10);
  expect(commands.filter((command) => command.description.length > 100).map((command) => `${command.command} (${command.description.length})`)).toEqual([]);
});
