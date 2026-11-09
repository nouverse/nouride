/**
 * `install.sh --variant router`: Router is part of Nouride now, and older docs and the Nouride Home app still run the
 * installer with it. It installs Nouride with the LLM gateway switched on — `[nougate] in_process = true` in the config
 * the daemon reads, written into a new one or added to one that says nothing of it, and never over an operator's own
 * answer. The block is taken from the script as written and run by `sh`, and what it writes is read back by the
 * daemon's own config loader.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigText } from "@/modules/config/global/index.ts";

const ROOT = join(import.meta.dir, "../../../..");
const INSTALL = readFileSync(join(ROOT, "scripts/install.sh"), "utf8");
const between = (from: string, to: string) => INSTALL.slice(INSTALL.indexOf(from) + from.length, INSTALL.indexOf(to));
const BLOCK = between("# >>> gateway on\n", "# <<< gateway on");
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";
// Both from `id`: `install -o` refuses a name `userInfo()` makes up for a process started without $USER.
const OWNER = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
const GROUP = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An install directory, its `.nouride/` made as the installer's home step makes it, and a config if one is given. */
function install(config?: string, at = ".nouride/config.toml"): string {
  const dir = mkdtempSync(join(tmpdir(), "nr-install-gateway-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".nouride"));
  if (config !== undefined) writeFileSync(join(dir, at), config, { mode: 0o600 });
  return dir;
}

function run(body: string, variant = "router"): { out: string; status: number } {
  const script = `set -eu\nsay() { echo "SAY: $*"; }\nwarn() { echo "WARN: $*"; }\nVARIANT='${variant}'\n${BLOCK}\n${body}`;
  const result = spawnSync(SH, ["-c", script], { encoding: "utf8" });
  return { out: result.stdout + result.stderr, status: result.status ?? -1 };
}

const on = (dir: string) => run(`gateway_on "$(gateway_config '${dir}')" '${OWNER}' '${GROUP}'`);
const loaded = (path: string) => readConfigText(readFileSync(path, "utf8"), path);

describe("install.sh --variant router", () => {
  test("is the one variant that switches the gateway on", () => {
    expect(run('echo "GATEWAY_ON=$GATEWAY_ON"', "router").out.trim()).toBe("GATEWAY_ON=1");
    for (const variant of ["", "pro"]) expect(run('echo "GATEWAY_ON=$GATEWAY_ON"', variant).out.trim()).toBe("GATEWAY_ON=0");
    // And the line a person reads names what happened, plainly.
    expect(INSTALL).toContain('router) say "Router is part of Nouride now: this installs Nouride, with its LLM gateway switched on" ;;');
  });

  test("a fresh install gets a config with the gateway on, and `careful` as the setup wizard would have started it", () => {
    const dir = install();
    expect(on(dir)).toEqual({ status: 0, out: `SAY: on: ${dir}/.nouride/config.toml says [nougate] in_process = true\n` });
    const path = join(dir, ".nouride/config.toml");
    expect(loaded(path).nougate.inProcess).toBe(true);
    expect(loaded(path).security.approvals).toBe("careful");
    // The daemon's, and not every account's: the mode the daemon's own saves keep.
    expect(statSync(path).mode & 0o777).toBe(0o640);
    // The wizard starts a file it makes `careful`, and skips that once a file is there — so this one says it too.
    expect(readFileSync(join(ROOT, "apps/engine/src/modules/setup/service.ts"), "utf8")).toContain('upsertTomlTable(source, "security", { approvals: "careful" })');
  });

  test("a config with no word of the gateway gets the table, and keeps everything it had — a last line with no newline too", () => {
    const dir = install('[daemon]\nport = 18300\n\n[security]\napprovals = "balanced"');
    expect(on(dir).status).toBe(0);
    const path = join(dir, ".nouride/config.toml");
    expect(readFileSync(path, "utf8")).toBe('[daemon]\nport = 18300\n\n[security]\napprovals = "balanced"\n\n[nougate]\nin_process = true\n');
    expect(loaded(path).nougate.inProcess).toBe(true);
    expect(loaded(path).security.approvals).toBe("balanced");
    // Rewritten in place: the mode it had is the mode it has.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a [nougate] table without the key gets it under the table, beside what it set", () => {
    const dir = install("[nougate] # the gateway\nport = 18400\n\n[retention]\nlog_days = 5\n");
    expect(on(dir).status).toBe(0);
    const path = join(dir, ".nouride/config.toml");
    expect(readFileSync(path, "utf8")).toBe("[nougate] # the gateway\nin_process = true\nport = 18400\n\n[retention]\nlog_days = 5\n");
    expect(loaded(path).nougate).toEqual({ inProcess: true, port: 18400 });
  });

  test("an operator's own answer stays: off is kept off, and a form it does not edit is left with a warning", () => {
    for (const config of ["[nougate]\nin_process = false\n", "nougate.in_process = false\n", "nougate = { in_process = false }\n"]) {
      const dir = install(config);
      expect(on(dir).out).toContain("already says whether it is on");
      expect(readFileSync(join(dir, ".nouride/config.toml"), "utf8")).toBe(config);
    }
    const dotted = install("nougate.port = 18400\n");
    expect(on(dotted).out).toContain("WARN: ");
    expect(readFileSync(join(dotted, ".nouride/config.toml"), "utf8")).toBe("nougate.port = 18400\n");
    // A key of the same name under another table is not the gateway's.
    const elsewhere = install("[other]\nin_process = false\n");
    expect(on(elsewhere).status).toBe(0);
    expect(loaded(join(elsewhere, ".nouride/config.toml")).nougate.inProcess).toBe(true);
  });

  test("the file it edits is the one the daemon reads: `.nouride/config.toml`, else a bare `config.toml` beside the install", () => {
    const bare = install("[daemon]\nport = 18300\n", "config.toml");
    expect(run(`gateway_config '${bare}'`).out).toBe(`${bare}/config.toml`);
    expect(on(bare).status).toBe(0);
    expect(existsSync(join(bare, ".nouride/config.toml"))).toBe(false);
    expect(loaded(join(bare, "config.toml")).nougate.inProcess).toBe(true);
    const both = install("[daemon]\nport = 18300\n", "config.toml");
    writeFileSync(join(both, ".nouride/config.toml"), "");
    expect(run(`gateway_config '${both}'`).out).toBe(`${both}/.nouride/config.toml`);
  });

  test("runs after the install's home is made and before the service starts the daemon that reads it", () => {
    const call = INSTALL.indexOf('gateway_on "$(gateway_config "$INSTALL_DIR")" "$SERVICE_USER" "$SERVICE_GROUP"');
    expect(call).toBeGreaterThan(INSTALL.indexOf("# <<< home"));
    expect(call).toBeLessThan(INSTALL.indexOf("# ── The unit ──"));
    expect(INSTALL.slice(INSTALL.lastIndexOf("\n\n", call), call)).toContain('if [ "$GATEWAY_ON" = "1" ]; then');
    // install-bundle-router.sh is the same installer, told `--variant router`.
    expect(readFileSync(join(ROOT, "scripts/install-bundle-router.sh"), "utf8")).toContain('sh "$STAGE/install.sh" --variant router "$@"');
  });
});
