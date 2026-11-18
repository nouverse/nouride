/**
 * `[queue] steer_reply` and `steer_ack` as the dashboard saves them: into `[queue]` of the file, live at once, and only
 * the key that changed is written.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { setSteering } from "@/modules/config/settings/steering.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function deps(): SettingsDeps {
  dir = mkdtempSync(join(tmpdir(), "steering-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, "[queue]\nsteer = true\n");
  return { config: structuredClone(DEFAULT_CONFIG), configPath } as unknown as SettingsDeps;
}

describe("what a person is told while the agent works", () => {
  test("steer_ack off is written beside the queue's other keys, and the running config follows", async () => {
    const d = deps();
    expect(await setSteering(d, { ack: false })).toMatchObject({ ok: true, restartRequired: false });
    const file = readFileSync(d.configPath, "utf8");
    expect(file).toContain("steer_ack = false");
    expect(file).not.toContain("steer_reply");
    expect([d.config.queue.steerAck, d.config.queue.steerReply]).toEqual([false, true]);
  });

  test("steer_reply alone, then both back on", async () => {
    const d = deps();
    await setSteering(d, { reply: false });
    expect(readFileSync(d.configPath, "utf8")).toContain("steer_reply = false");
    expect(d.config.queue.steerReply).toBe(false);
    await setSteering(d, { reply: true, ack: true });
    expect([d.config.queue.steerAck, d.config.queue.steerReply]).toEqual([true, true]);
  });

  test("nothing changed, nothing written", async () => {
    const d = deps();
    expect((await setSteering(d, { reply: true, ack: true })).ok).toBe(true);
    expect(readFileSync(d.configPath, "utf8")).toBe("[queue]\nsteer = true\n");
  });
});
