/**
 * The agents' HOME is `.nouride/home` at boot when the unit still says the install directory — an install upgraded
 * with `nouride update` keeps the unit it had, so the daemon has to do it itself. Nothing is copied: every 0.7.x start
 * did that, and the upgrade floor makes sure one ran.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { settleAgentHome } from "@/boot/agent-home.ts";

let root: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, NOURIDE_BIN: process.env.NOURIDE_BIN };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-home-"));
  mkdirSync(join(root, ".nouride", "data"), { recursive: true });
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "config"), "Host nas\n");
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const config = () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.daemon.dataDir = join(root, ".nouride", "data");
  return c;
};

describe("settleAgentHome", () => {
  test("a HOME that is still the install directory becomes .nouride/home, and nothing is copied into it", () => {
    process.env.HOME = root;
    settleAgentHome(config(), null);
    expect(process.env.HOME).toBe(join(root, ".nouride", "home"));
    expect(existsSync(join(root, ".nouride", "home", ".ssh"))).toBe(true);
    expect(existsSync(join(root, ".nouride", "home", ".ssh", "config"))).toBe(false);
    expect(readFileSync(join(root, ".ssh", "config"), "utf8")).toBe("Host nas\n");
    expect(process.env.PATH?.startsWith(`${join(root, ".nouride", "bin")}:`)).toBe(true);
    expect(process.env.NOURIDE_BIN).toBe(join(root, ".nouride", "bin"));
  });

  test("a person's own home is left alone", () => {
    const own = join(root, "someone");
    mkdirSync(own);
    process.env.HOME = own;
    settleAgentHome(config(), null);
    expect(process.env.HOME).toBe(own);
    expect(existsSync(join(root, ".nouride", "home"))).toBe(false);
  });

  test("ssh is bridged after the move, so the include lands in the HOME the agents get", () => {
    const system = join(root, "usr-bin");
    mkdirSync(system);
    writeFileSync(join(system, "ssh"), "#!/bin/sh\n");
    chmodSync(join(system, "ssh"), 0o755);
    process.env.HOME = root;
    process.env.PATH = system;
    settleAgentHome(config(), root);
    expect(readFileSync(join(root, ".nouride", "home", ".ssh", "config"), "utf8")).toContain(`Include ${root}/.ssh/config`);
    expect(readFileSync(join(root, ".ssh", "config"), "utf8")).toBe("Host nas\n");
    expect(existsSync(join(root, ".nouride", "bin", "ssh"))).toBe(true);
  });
});
