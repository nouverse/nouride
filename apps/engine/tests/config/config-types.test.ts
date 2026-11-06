/**
 * What a config file sets that the daemon cannot use: a value of the wrong type, a number out of its bounds, a key an
 * open table does not read. Each passed `config check` ("would start") while it inverted or switched off what it
 * named — the SSRF guard, a spend cap, a retention — and nothing said so.
 *
 * 0.7.7 ran on the default in its place and reported it as bad; since 0.7.8 the file is refused, naming each one.
 */

import { describe, expect, test } from "bun:test";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { parseConfig } from "@/modules/config/global/index.ts";
import { parseGateways, parseProviders } from "@/modules/config/global/open-sections.ts";
import { validate } from "@/modules/config/global/validate.ts";
import { configJsonSchema } from "@/modules/config/schema.ts";

const loaded = (raw: Record<string, unknown>) => {
  const config = parseConfig(raw);
  validate(config);
  return config;
};
const refusal = (raw: Record<string, unknown>): string => {
  try {
    loaded(raw);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("it loaded");
};

describe("a value of the wrong type", () => {
  test("is refused at load, by path, with what to write — every one in the file at once", () => {
    // A truthy string let private hosts through the SSRF guard; a string allowlist was three one-character senders.
    const said = refusal({ security: { web: { allow_private_urls: "false" }, access: { allowlist: "123" } }, dashboard: { enabled: "false" } });
    expect(said).toContain("the config sets values this daemon cannot use");
    expect(said).toContain('[security.web] allow_private_urls = "false" is not true or false: write it without quotes');
    expect(said).toContain('[security.access] allowlist = "123" is not a list');
    expect(said).toContain('[dashboard] enabled = "false" is not true or false');
  });

  test("a table given a scalar is refused, and so is a number where text belongs — not a TypeError naming nothing", () => {
    expect(refusal({ security: { exec: "full" } })).toBe('[security] exec = "full" is not a table: it is a section of its own');
    expect(refusal({ daemon: { log_level: 5 } })).toBe("[daemon] log_level = 5 is not text: put it in quotes");
  });

  test("a key validate refuses by name is still refused, with its own words", () => {
    expect(refusal({ agents: { group_context_messages: "twenty" } })).toMatch(/whole number/);
  });
});

describe("a number out of its bounds", () => {
  test("is refused, whatever the key — a negative cap was off, a negative retention nothing kept", () => {
    const said = refusal({ retention: { log_days: -1 }, llm: { limits: { max_daily_cost_usd: -5, cost_alert_threshold_pct: 500 } }, daemon: { backup_keep: 2.5 } });
    expect(said).toContain("[retention] log_days = -1 is not a whole number from 0 up");
    expect(said).toContain("[llm.limits] max_daily_cost_usd = -5 is not a number from 0 up");
    expect(said).toContain("[llm.limits] cost_alert_threshold_pct = 500 is not a whole number from 0 to 100");
    expect(said).toContain("[daemon] backup_keep = 2.5 is not a whole number from 0 up");
  });

  test("one in bounds is left alone, fractions where a fraction is meant", () => {
    const config = loaded({ llm: { defaults: { temperature: 0.3 }, limits: { max_daily_cost_usd: 1.5 } } });
    expect(config.llm.defaults.temperature).toBe(0.3);
    expect(config.llm.limits.maxDailyCostUsd).toBe(1.5);
  });

  test("the bounds are in `config schema`, so an editor can check a file before the daemon does", () => {
    const schema = JSON.stringify(configJsonSchema("llm.limits"));
    expect(schema).toContain('"cost_alert_threshold_pct":{"type":"integer","minimum":0,"maximum":100');
  });
});

describe("a key an open table does not read", () => {
  test("is said once at load, as the merge says one — `enable = true` left a gateway off with nothing said", () => {
    const said: LogEntry[] = [];
    addLogSink((entry) => void said.push(entry));
    parseGateways({ telegram: { bot: { enable: true, token: "t" } } });
    parseProviders({ local: { kind: "openai", base_url: "http://127.0.0.1:1/v1", api_key: "k", apikey: "typo" } });
    const keys = said.filter((entry) => entry.message.includes("ignored")).map((entry) => entry.data?.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "[gateways.telegram.bot] enable",
        "[providers.local] apikey",
      ]),
    );
  });

  test("`bridge_command` and `bridge_transport = \"stdio\"` are refused, each naming what to remove (0.7.22 removed them)", () => {
    expect(() => parseGateways({ whatsapp: { main: { enabled: true, bridge_command: ["node", "bridge.js"] } } })).toThrow(
      "[gateways.whatsapp.main] bridge_command is gone with the stdio transport: remove it from this table.",
    );
    expect(() => parseGateways({ whatsapp: { main: { enabled: true, bridge_transport: "stdio" } } })).toThrow(
      /\[gateways\.whatsapp\.main\] bridge_transport = "stdio" is gone: the bridge runs in this process.*Remove bridge_transport from this table\./,
    );
    expect(parseGateways({ whatsapp: { main: { enabled: true, bridge_transport: "inproc" } } })).toHaveLength(1);
  });
});
