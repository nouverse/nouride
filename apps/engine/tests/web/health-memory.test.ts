/**
 * The daemon's own memory, where an operator reads it: `/health` and `nouride doctor` (§8.5 of the review, the x64 half
 * of `roadmap-measurements-owed`). Nothing reported RSS before, so the footprint the docs publish could only be checked
 * with a shell on the box.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonContext } from "@/commons/context.ts";
import { memoryCheck } from "@/cli/commands/doctor-checks.ts";
import { buildHealth, installFingerprint, startingHealth } from "@/modules/web/health.ts";
import { runCli } from "../cli-harness.ts";

const running = {
  gateways: new Map(),
  db: { walSizeBytes: () => 0 },
  config: { daemon: { dataDir: "/tmp/nr-health" } },
  providerErrors: new Map(),
  status: "running",
  startedAt: Date.now(),
  agentCount: 1,
} as unknown as DaemonContext;

describe("/health", () => {
  test("says what this process holds now — resident, and the heap in use — while running and while starting", () => {
    for (const { memory } of [buildHealth(running).payload, startingHealth("/tmp/nr-health", Date.now(), "loading agents").payload]) {
      expect(Number.isInteger(memory.rssBytes)).toBe(true);
      expect(Number.isInteger(memory.heapUsedBytes)).toBe(true);
      expect(memory.heapUsedBytes).toBeGreaterThan(0);
      // Read from this process, not made up: within a few megabytes of what it says of itself.
      expect(Math.abs(memory.rssBytes - process.memoryUsage().rss)).toBeLessThan(64 * 1024 * 1024);
    }
  });

  test("is read per request, not once — while running and while starting", () => {
    // A reader that says how often it was asked. The process's own figures cannot show this in a test process: an
    // allocator that kept freed pages resident satisfies a new allocation without the resident figure moving at all.
    let asked = 0;
    const read = () => ({ rssBytes: ++asked * 1_000_000, heapUsedBytes: asked });
    expect(buildHealth(running, read).payload.memory).toEqual({ rssBytes: 1_000_000, heapUsedBytes: 1 });
    expect(buildHealth(running, read).payload.memory).toEqual({ rssBytes: 2_000_000, heapUsedBytes: 2 });
    expect(startingHealth("/tmp/nr-health", Date.now(), "loading agents", read).payload.memory.heapUsedBytes).toBe(3);
    expect(buildHealth({ ...running, status: "starting" } as DaemonContext, read).payload.memory.heapUsedBytes).toBe(4);
  });
});

describe("nouride doctor", () => {
  test("says the daemon's memory, and nothing for a daemon too old to report it", () => {
    expect(memoryCheck({ rssBytes: 118_916_096, heapUsedBytes: 45_000_000 })).toEqual({
      level: "ok",
      message: "daemon memory: 113.4MB resident, 42.9MB of it JavaScript heap in use",
    });
    expect(memoryCheck(undefined)).toBeNull();
    expect(memoryCheck({ rssBytes: "118916096" })).toBeNull();
  });

  const dir = mkdtempSync(join(tmpdir(), "nouride-doctor-memory-"));
  let server: Server;

  beforeAll(async () => {
    const data = join(dir, "data");
    // A stand-in for the daemon: what doctor reads of a healthy one, and `/health` with its memory.
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return void res.end(JSON.stringify({ status: "ok", version: "0.7.11", uptime: 5, install: installFingerprint(data), memory: { rssBytes: 118_916_096, heapUsedBytes: 45_000_000 } }));
      if (req.url === "/api/control/status") return void res.end(JSON.stringify({ uptime: 5, providers: [], failures: [], agents: [], gateways: [], pendingApprovals: 0, queue: { waiting: 0 } }));
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

  test("reads it from the running daemon's /health", async () => {
    const run = await runCli(["doctor", "--json"], { cwd: dir, config: join(dir, "config.toml") });
    const results = JSON.parse(run.out).data.results as { level: string; message: string }[];
    expect(results).toContainEqual({ level: "ok", message: "daemon memory: 113.4MB resident, 42.9MB of it JavaScript heap in use" });
  });
});
