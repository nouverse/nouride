/**
 * Re-running `install.sh` on an install that already has a `.env`.
 *
 * `--host 0.0.0.0` on an existing install left HOST alone and then printed a network URL for a daemon still on
 * loopback; a re-run without the first run's `--port` probed the default port; `curl -f` read the 503 `/health` gives
 * while starting or degraded as no daemon, and the data directory's modes were applied only after a quick answer. (What a
 * macOS run downloads is `install-mac.test.ts`'s.) The functions are taken from the script as written and run by `sh`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, serveHttp } from "@nouride/runtime";

const SCRIPT = join(import.meta.dir, "../../../../scripts/install.sh");
const INSTALL = readFileSync(SCRIPT, "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const ENV_FILE = between("# >>> env file\n", "# <<< env file");
const PROBE = between("# >>> health probe\n", "# <<< health probe");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(env: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nouride-rerun-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
  return dir;
}

const sh = (dir: string, body: string) =>
  spawnSync("sh", ["-c", `say() { echo "$*"; }\nINSTALL_DIR='${dir}'\n${ENV_FILE}\n${body}`], { encoding: "utf8" });

describe(".env on a re-run", () => {
  test("a flag given now replaces the value there, and keeps every other line and the file's 0600", () => {
    const dir = install("PROVIDER_KEY=sk-not-a-real-one\nHOST=127.0.0.1\n");
    sh(dir, "set_env HOST 0.0.0.0");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("PROVIDER_KEY=sk-not-a-real-one\nHOST=0.0.0.0\n");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  test("a key not there yet is added", () => {
    const dir = install("HOST=0.0.0.0\n");
    sh(dir, "set_env PORT 18300");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("HOST=0.0.0.0\nPORT=18300\n");
  });

  test("what the daemon will use is read from .env — the last line, unquoted — or the default", () => {
    const dir = install('PORT=18300\nHOST="0.0.0.0"\nPORT=18301\n');
    expect(sh(dir, 'printf "%s %s %s" "$(env_value PORT 18254)" "$(env_value HOST "")" "$(env_value MISSING x)"').stdout).toBe("18301 0.0.0.0 x");
  });

  test("and the probe and the closing URL use those, not this run's flags", () => {
    const flow = INSTALL.slice(INSTALL.indexOf("# <<< env file"));
    expect(flow.indexOf('PORT=$(env_value PORT 18254)')).toBeGreaterThan(-1);
    expect(flow.indexOf('PORT=$(env_value PORT 18254)')).toBeLessThan(flow.indexOf('health_answers "http://${HEALTH_HOST}:${PORT}/health"'));
    expect(flow).toContain('BIND_HOST=$(env_value HOST "")');
    // A value .env has and no flag on this run names is the operator's: only given flags are written.
    expect(flow).toContain('if [ "$HOST_GIVEN" = "1" ]; then set_env HOST "$BIND_HOST"; fi');
    expect(flow).toContain('if [ "$PORT_GIVEN" = "1" ]; then set_env PORT "$PORT"; fi');
  });
});

describe("the health probe", () => {
  // Run without blocking: the server answering it lives in this process.
  const probe = (port: number) =>
    runCommand(["sh", "-c", `${PROBE}\nhealth_answers "http://127.0.0.1:${port}/health"`], { cwd: "/", timeoutMs: 10_000, maxOutputBytes: 4_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const answering = (status: number, body: string) =>
    serveHttp({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { status, headers: { "content-type": "application/json" } }) });

  test("a 503 that names a status is a daemon answering — starting, or degraded", async () => {
    const server = answering(503, '{"status":"starting"}');
    try {
      expect((await probe(server.port)).exitCode).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("something else on the port is not", async () => {
    const server = answering(404, "<html>not here</html>");
    try {
      expect((await probe(server.port)).exitCode).not.toBe(0);
    } finally {
      server.stop();
    }
  });

  test("the data directory's modes do not wait on a quick answer", () => {
    const wait = INSTALL.slice(INSTALL.indexOf('step "Waiting for it to answer"'));
    expect(wait.indexOf('chmod 750 "$INSTALL_DIR/.nouride" "$INSTALL_DIR/.nouride/data"')).toBeLessThan(wait.indexOf('if [ "$ready" = "1" ]; then'));
  });
});
