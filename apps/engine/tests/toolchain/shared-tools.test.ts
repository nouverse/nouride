/**
 * Who installs the programs every agent runs, and what is shared (`modules/toolchain/shared-tools.ts`).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesSharedTools, hasAgentsGroup, shareCommands, sharedToolDirs, shareTools } from "@/modules/toolchain/shared-tools.ts";
import { fakeAgent } from "../helpers.ts";

const agent = (id: string, sharedTools?: boolean) => fakeAgent({ config: { ...fakeAgent().config, id, ...(sharedTools === undefined ? {} : { sharedTools }) } });

test("the orchestrator's, on until its pack says no; never another agent's, whatever its pack says", () => {
  const config = { daemon: { orchestrator: "nouva" } } as never;
  expect(changesSharedTools(config, agent("nouva"))).toBe(true);
  expect(changesSharedTools(config, agent("nouva", false))).toBe(false);
  expect(changesSharedTools(config, agent("nox", true))).toBe(false);
  expect(changesSharedTools({ daemon: { orchestrator: "" } } as never, agent("nouva"))).toBe(false);
  expect(changesSharedTools(config, undefined)).toBe(false);
});

test("what is shared: the install's program folders, and the tools the daemon's HOME holds", () => {
  expect(sharedToolDirs("/n", "/n/home")).toEqual(["/n/bin", "/n/lib", "/n/opt", "/n/home/.local", "/n/home/.cargo", "/n/home/.rustup"]);
});

test("sharing touches only what lacks the group or its bits — never a setgid folder that has them, which the daemon may not chmod", () => {
  const [chgrp, chmod] = shareCommands(["/n/bin", "/n/home/.local"]);
  expect(chgrp).toEqual(["find", "/n/bin", "/n/home/.local", "!", "-group", "nr-agents", "-exec", "chgrp", "-h", "nr-agents", "{}", "+"]);
  expect(chmod!.join(" ")).toBe("find /n/bin /n/home/.local ( ( -type d ! -perm -g=rx ) -o ( -type f ! -perm -g=r ) ) -exec chmod g+rX {} +");
});

test("where no agent has a user of its own, there is nothing to share, and an install is not reported as failed (0.8.1)", async () => {
  // On Docker and macOS `nouride tools run -- npm i -g …` installed the CLI, then failed on `find -group nr-agents`,
  // a group only the installer's own users bring: "installed, but not every agent can run it yet", exit 1.
  const dir = mkdtempSync(join(tmpdir(), "shared-tools-"));
  const without = join(dir, "group-without");
  const withIt = join(dir, "group-with");
  writeFileSync(without, "root:x:0:\nstaff:x:20:\n");
  writeFileSync(withIt, "root:x:0:\nnr-agents:x:998:nouride,nr-nova\n");
  expect([hasAgentsGroup(without), hasAgentsGroup(withIt), hasAgentsGroup(join(dir, "missing"))]).toEqual([false, true, false]);
  expect(await shareTools([dir], without)).toEqual({ ok: true });
});
