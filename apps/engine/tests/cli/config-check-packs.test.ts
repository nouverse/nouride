/**
 * `nouride config check` over a pack that will not load (`config-check-hides-pack-failures`).
 *
 * Found in the 0.7.7 → 0.7.10 upgrade run: a pack 0.7.7 loaded — two `[[mcp_servers]]` of one name, refused since
 * 0.7.10 — made the check every release note sends people to print one raw JSON log line and then "✓ this
 * configuration would start · agents 0 enabled", exit 0. The daemon then started, and that agent was gone: with one
 * agent, the bot stopped answering. Spawned, as an operator runs it before an upgrade, at a terminal's log floor.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli-harness.ts";

let root: string;
let configPath: string;

/** A pack: what its config.toml says beyond the provider every pack here names. */
function pack(id: string, extra = ""): void {
  mkdirSync(join(root, "agents", id), { recursive: true });
  writeFileSync(join(root, "agents", id, "IDENTITY.md"), `${id}\n`);
  writeFileSync(join(root, "agents", id, "config.toml"), `${extra}[llm]\nprovider = "nougate"\nmodel = "m"\n`);
}

/** A pack that does not load: an approval level no release has. (Two MCP servers of one name, what 0.7.10 refused, are in the library since 0.7.19.) */
const BROKEN = '[agent]\napprovals = "sometimes"\n\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-check-packs-"));
  configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[daemon]\ndata_dir = "${join(root, "data")}"\nagents_dir = "${join(root, "agents")}"\n\n[dashboard]\nport = 9\n\n` +
      '[providers.nougate]\nkind = "openai"\nbase_url = "https://example.invalid/v1"\napi_key = "nougate"\n',
  );
  pack("nouva");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** What a person's terminal shows: the CLI's own floor, `warn`, not the harness's `error`. */
const check = (...flags: string[]) => runCli(["config", "check", ...flags], { cwd: root, config: configPath, env: { LOG_LEVEL: "warn" } });

describe("nouride config check, with a pack that will not load", () => {
  test("names the pack and why, and fails: it would start, but that agent would not", async () => {
    pack("e2e", BROKEN);
    const run = await check();
    expect(run.code).toBe(1);
    expect(run.out).toContain('✗ agent e2e will not load: agents/e2e/config.toml [agent] approvals must be one of careful, balanced, trusted, per-person, got "sometimes"');
    expect(run.out).toContain("this configuration would start, but 1 agent will not load");
    expect(run.out).toContain("agents    1 enabled");
    // The report is the place it is said — no JSON log line above it, on either stream.
    expect(run.out + run.err).not.toContain('"level":');
  });

  test("--json carries each one, and is not ok", async () => {
    pack("e2e", BROKEN);
    const run = await check("--json");
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.out) as { ok: boolean; error: string; data: { starts: boolean; agents: string[]; failed: { id: string; error: string }[] } };
    expect(envelope).toMatchObject({ ok: false, error: "this configuration would start, but 1 agent will not load" });
    expect(envelope.data.starts).toBe(true);
    expect(envelope.data.agents).toEqual(["nouva"]);
    expect(envelope.data.failed).toEqual([{ id: "e2e", error: expect.stringContaining('got "sometimes"') }]);
  });

  test("a disabled pack that would not load is said, and does not fail the check — nothing would run it", async () => {
    pack("parked", '[agent]\napprovals = "sometimes"\nenabled = false\n\n');
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("! agent parked is disabled, and would not load: ");
    expect(run.out).toContain("✓ this configuration would start");
  });

  test("and once the pack is fixed, it would start, every agent with it", async () => {
    pack("e2e", '[agent]\napprovals = "careful"\n\n');
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("✓ this configuration would start");
    expect(run.out).toContain("agents    2 enabled");
    expect(run.out + run.err).not.toContain('"level":');
  });
});

describe("nouride config check, with a pack key nothing reads", () => {
  test("names the file, the table and the key, and the agent still loads (SIMPLIFY §3)", async () => {
    pack("e2e", '[agent]\nemojii = "x"\n\n[rsi]\nmode = "ask"\n\n');
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("✓ this configuration would start");
    expect(run.out).toContain("unknown pack config key ignored");
    expect(run.out).toContain("agents/e2e/config.toml [agent] emojii");
    expect(run.out).toContain("agents/e2e/config.toml [rsi]");
    expect(run.out).toContain("agents    2 enabled");
  });
});
