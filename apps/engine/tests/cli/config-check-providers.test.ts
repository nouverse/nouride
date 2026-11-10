/**
 * `nouride config check` says where a provider profile sends a reply's output limit, where that is not `max_tokens`,
 * and what the next start will write into a profile on OpenAI's own API that does not say it yet — the check the
 * release notes send people to before an upgrade. Spawned, as an operator runs it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli-harness.ts";

let root: string;
let configPath: string;

const PROFILES =
  '[providers.openai]\nkind = "openai"\nbase_url = "https://api.openai.com/v1"\napi_key = "openai_api_key"\n\n' +
  '[providers.gate]\nkind = "openai"\nbase_url = "https://gate.example.invalid/v1"\napi_key = "gate_api_key"\nmax_tokens_field = "max_completion_tokens"\n\n' +
  '[providers.nougate]\nkind = "openai"\nbase_url = "http://127.0.0.1:18256/openai/v1"\napi_key = "nougate_api_key"\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-check-providers-"));
  configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[daemon]\ndata_dir = "${join(root, "data")}"\nagents_dir = "${join(root, "agents")}"\n\n[dashboard]\nport = 9\n\n${PROFILES}`,
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const check = (...flags: string[]) => runCli(["config", "check", ...flags], { cwd: root, config: configPath, env: { LOG_LEVEL: "warn" } });

describe("nouride config check, on provider profiles", () => {
  test("names the field where it is not max_tokens, and what the next start writes for OpenAI's own API, writing nothing", async () => {
    const before = readFileSync(configPath, "utf8");
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("providers openai, gate (output limit as max_completion_tokens), nougate");
    expect(run.out).toContain('! [providers.openai] will be given max_tokens_field = "max_completion_tokens" at the next start');
    expect(run.out).toContain("OpenAI's own API takes a reply's output limit only as max_completion_tokens for its newer models");
    expect(run.out).not.toContain("[providers.nougate] will be given");
    // A check, not a start: the file is the next start's to change.
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("--json carries each profile's field on the OpenAI wire", async () => {
    const run = await check("--json");
    const envelope = JSON.parse(run.out) as { data: { providers: unknown[]; notes: { message: string }[] } };
    expect(envelope.data.providers).toEqual([
      { name: "openai", kind: "openai", maxTokensField: "max_tokens" },
      { name: "gate", kind: "openai", maxTokensField: "max_completion_tokens" },
      { name: "nougate", kind: "openai", maxTokensField: "max_tokens" },
    ]);
    expect(envelope.data.notes.map((note) => note.message)).toContain('[providers.openai] will be given max_tokens_field = "max_completion_tokens" at the next start');
  });

  test("once the profile says it, nothing is left to write", async () => {
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace('api_key = "openai_api_key"\n', 'api_key = "openai_api_key"\nmax_tokens_field = "max_completion_tokens"\n'));
    const run = await check();
    expect(run.out).toContain("providers openai (output limit as max_completion_tokens), gate (output limit as max_completion_tokens), nougate");
    expect(run.out).not.toContain("will be given");
  });

  test("says how long each endpoint keeps a cached prompt, where its profile or its address says", async () => {
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8") +
        '\n[providers.anthropic]\nkind = "anthropic"\nbase_url = "https://api.anthropic.com/v1"\napi_key = "anthropic_api_key"\n' +
        '\n[providers.local]\nkind = "openai"\nbase_url = "http://127.0.0.1:11434/v1"\napi_key = "local_api_key"\ncache_minutes = 0\n',
    );
    const run = await check();
    expect(run.code).toBe(0);
    // Anthropic's own API by its address, the local one by its key; the others do not say, and nothing is claimed for them.
    expect(run.out).toContain("providers openai, gate (output limit as max_completion_tokens), nougate, anthropic (prompt cache kept 5 min), local (prompt cache kept 0 min)");

    const envelope = JSON.parse((await check("--json")).out) as { data: { providers: { name: string; cacheMinutes?: number }[] } };
    expect(envelope.data.providers.map((profile) => [profile.name, profile.cacheMinutes])).toEqual([
      ["openai", undefined],
      ["gate", undefined],
      ["nougate", undefined],
      ["anthropic", 5],
      ["local", 0],
    ]);
  });

  test("a cache_minutes that is not a whole number of minutes does not start, and the check names it", async () => {
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace('api_key = "gate_api_key"\n', 'api_key = "gate_api_key"\ncache_minutes = "five"\n'));
    const run = await check();
    expect(run.code).not.toBe(0);
    expect(run.out + run.err).toContain("[providers.gate] cache_minutes must be a whole number of minutes, 0 or more");
  });
});
