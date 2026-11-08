/**
 * `nouride config explain` says when a change to the key takes effect: at once when a save through
 * the daemon applies it, after a restart when the daemon reads it at boot — and, for both, that a hand edit waits.
 * Spawned against an install with no daemon, as the command is meant to run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli-harness.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-explain-live-"));
const config = join(dir, "config.toml");
writeFileSync(config, `[daemon]\ndata_dir = "${join(dir, "data")}"\n\n[dashboard]\nport = 9\n`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const explain = (path: string, json = false) => runCli(["config", "explain", path, ...(json ? ["--json"] : [])], { cwd: dir, config });

describe("config explain: when a change applies", () => {
  test("a key its setter applies at once says so, and that a hand edit still waits", async () => {
    const { code, out } = await explain("security.access.mode");
    expect(code).toBe(0);
    expect(out).toContain("applies at once when saved from the dashboard or a nouride command, but a hand edit to config.toml waits for a restart");
  }, 30_000);

  test("a key read at boot says the change waits for a restart", async () => {
    for (const path of ["security.web.search_kind", "daemon.data_dir", "gateways"]) {
      const { code, out } = await explain(path);
      expect({ path, code }).toEqual({ path, code: 0 });
      expect(out).toContain("applies after a restart: the daemon reads it at boot");
    }
  }, 30_000);

  test("--json carries it as `live`", async () => {
    const [live, boot] = await Promise.all([explain("llm.limits.max_daily_cost_usd", true), explain("queue.max_concurrent_turns", true)]);
    expect(JSON.parse(live.out).data).toMatchObject({ path: "llm.limits.max_daily_cost_usd", live: true });
    expect(JSON.parse(boot.out).data).toMatchObject({ path: "queue.max_concurrent_turns", live: false });
  }, 30_000);
});
