/**
 * Where a busy box learns its nightly pass falls behind, in a terminal: `nouride memory` and `nouride doctor`,
 * spawned against a stand-in daemon whose `/memory/status` says so — and the count each names to set.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFingerprint } from "@/modules/web/health.ts";
import { runCli } from "../cli-harness.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-cli-backlog-"));
let server: Server;
/** What the stand-in's `/memory/status` says of the backlog: behind, or keeping up. */
let behind = true;

const SETTINGS = { pass: true, passAt: "01:00", passPerNight: 5, passMaxTokens: 400_000, passProvider: "", passModel: "", maxAttempts: 3, facts: "auto", proposeShared: false, promptRecent: 5, transcriptDays: 180, archive: true, semantic: { enabled: false, provider: "", model: "" } };
const backlog = () => ({
  waiting: 32,
  oldest: "2026-09-22",
  perNight: 5,
  days: 3,
  agents: [{ agent: "nix", waiting: 2, perDay: 0.7 }, { agent: "nouva", waiting: 30, perDay: 10 }],
  behind: behind ? ["nouva"] : [],
  enough: behind ? 15 : null,
});

beforeAll(async () => {
  const data = join(dir, "data");
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return void res.end(JSON.stringify({ status: "ok", version: "0.7.12", uptime: 5, install: installFingerprint(data) }));
    if (req.url === "/api/control/status") return void res.end(JSON.stringify({ uptime: 5, providers: [], failures: [], agents: [], gateways: [], pendingApprovals: 0, queue: { waiting: 0 } }));
    if (req.url === "/api/control/memory/settings") return void res.end(JSON.stringify(SETTINGS));
    if (req.url === "/api/control/memory/status") return void res.end(JSON.stringify({ pass: { enabled: true }, waiting: 32, backlog: backlog(), failed: 0 }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not here" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, ".control-token"), "token\n", { mode: 0o640 });
  writeFileSync(join(dir, "config.toml"), `[daemon]\ndata_dir = "${data}"\n\n[dashboard]\nport = ${port}\n`);
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const cli = (...args: string[]) => runCli(args, { cwd: dir, config: join(dir, "config.toml") });

describe("a pass that falls behind", () => {
  test("nouride memory says what waits, each agent's pace, and the count that catches up — beside the night's budget", async () => {
    behind = true;
    const { code, out } = await cli("memory");
    expect(code).toBe(0);
    expect(out).toContain("5 per agent per night, at most 400,000 tokens a night");
    expect(out).toContain("waiting          32 conversation(s), the oldest from 2026-09-22");
    expect(out).toContain("! falling behind: nix 0.7 a day, nouva 10 a day over the 3 day(s) since the first conversation, and the pass files 5 per agent a night");
    expect(out).toContain("nouride memory set pass_per_night 15 files what waits within a week at this pace");
  }, 30_000);

  test("nouride memory says no more than what waits while the pass keeps up", async () => {
    behind = false;
    const { out } = await cli("memory");
    expect(out).toContain("waiting          32 conversation(s), the oldest from 2026-09-22");
    expect(out).not.toContain("pass_per_night 15");
  }, 30_000);

  test("nouride doctor warns, with the count to set", async () => {
    behind = true;
    const { out } = await cli("doctor", "--json");
    const results = JSON.parse(out).data.results as { level: string; message: string; hint?: string }[];
    expect(results).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringContaining("memory pass: falling behind, 32 conversation(s) waiting"), hint: expect.stringContaining("nouride memory set pass_per_night 15") }));
  }, 30_000);
});
