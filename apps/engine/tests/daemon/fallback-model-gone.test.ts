/**
 * 0.7's `[llm] fallback_model`, refused where it is read rather than rewritten at boot.
 *
 * 0.8.0 wrote it as `fallbacks` in every pack at its first start, and this version starts only on data 0.8.0 has run
 * on — so the rewrite is gone, and a pack that says `fallback_model` now came back after that: pulled from git, edited
 * by hand. That agent does not load, the others do, and the message is the line to write. Held on the two paths an
 * operator meets it: `nouride config check`, and the daemon's own boot, which must leave the file as it was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli-harness.ts";
import { eventually } from "../wait.ts";

let root = "";
let configPath = "";

const OLD = '[llm]\nprovider = "nougate"\nmodel = "pro"\nfallback_model = "flash" # cheaper\n';
const REFUSAL = 'agents/nox/config.toml [llm] fallback_model was replaced by fallbacks in 0.8.0: write fallbacks = [{ provider = "nougate", model = "flash" }] in its place';

function pack(id: string, config: string): string {
  mkdirSync(join(root, "agents", id), { recursive: true });
  writeFileSync(join(root, "agents", id, "IDENTITY.md"), `${id}\n`);
  const path = join(root, "agents", id, "config.toml");
  writeFileSync(path, config);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-fallback-model-"));
  configPath = join(root, "config.toml");
  mkdirSync(join(root, "memory"));
  writeFileSync(
    configPath,
    [
      "[daemon]",
      `data_dir = "${join(root, "data")}"`,
      `agents_dir = "${join(root, "agents")}"`,
      `workspace_dir = "${join(root, "workspace")}"`,
      "[memory]",
      `dir = "${join(root, "memory")}"`,
      "[dashboard]",
      "enabled = false",
      "[nougate]",
      "in_process = false",
      "[providers.nougate]",
      'kind = "openai"',
      'base_url = "https://example.invalid/v1"',
      'api_key = "nougate"',
      "",
    ].join("\n"),
  );
  pack("nouva", '[llm]\nprovider = "nougate"\nmodel = "pro"\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a pack that still says fallback_model", () => {
  test("nouride config check names it, with the fallbacks line to write, and the other agent would load", async () => {
    pack("nox", OLD);
    const run = await runCli(["config", "check"], { cwd: root, config: configPath, env: { LOG_LEVEL: "warn" } });
    expect(run.code).toBe(1);
    expect(run.out).toContain(`✗ agent nox will not load: ${REFUSAL}`);
    expect(run.out).toContain("this configuration would start, but 1 agent will not load");
  });

  test("the daemon's boot refuses that agent and leaves its file as written — nothing rewrites it", async () => {
    const path = pack("nox", OLD);
    // Nothing from this shell may point the daemon at a real install.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NOURIDE_|NOUGATE_|INITIAL_ADMIN_)/.test(name) && !["PORT", "HOST", "LOG_LEVEL"].includes(name)));
    const child = spawn("bun", [join(import.meta.dir, "../../src/index.ts")], { cwd: root, env: { ...env, NOURIDE_CONFIG: configPath } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    try {
      // The line that ends the loading, after each pack's own: the output arrives in chunks, and a refusal seen alone
      // may be ahead of the rest.
      await eventually(() => out.includes('"message":"agents loaded"'), 30_000, "the daemon to load the packs");
      // As the log line carries it, quotes escaped.
      expect(out).toContain(JSON.stringify(REFUSAL).slice(1, -1));
      expect(out).toContain('"message":"agents loaded","data":{"count":1,"ids":["nouva"],"failed":1}');
      expect(readFileSync(path, "utf8")).toBe(OLD);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("close", resolve));
    }
  }, 45_000);
});
