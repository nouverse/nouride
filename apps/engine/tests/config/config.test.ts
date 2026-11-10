import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { addLogSink } from "@nouride/shared";
import { mergeConfig, parseConfig, reportConfigAdvisories } from "@/modules/config/global/index.ts";

const base = () => structuredClone(DEFAULT_CONFIG);

describe("mergeConfig", () => {
  test("maps snake_case TOML keys onto camelCase config", () => {
    const merged = mergeConfig(base(), {
      llm: { limits: { max_tool_iterations: 7 } },
      security: { tool_timeout_ms: 1234 },
    });
    expect(merged.llm.limits.maxToolIterations).toBe(7);
    expect(merged.security.toolTimeoutMs).toBe(1234);
  });

  test("leaves untouched sections at their defaults", () => {
    const merged = mergeConfig(base(), { daemon: { log_level: "debug" } });
    expect(merged.daemon.logLevel).toBe("debug");
    expect(merged.daemon.name).toBe(DEFAULT_CONFIG.daemon.name);
    expect(merged.queue).toEqual(DEFAULT_CONFIG.queue);
  });

  test("replaces arrays instead of appending", () => {
    // `allowlist = []` has to be able to mean "nobody", which a merge that concatenated could never express.
    const withEntries = mergeConfig(base(), { security: { access: { allowlist: ["a", "b"] } } });
    expect(withEntries.security.access.allowlist).toEqual(["a", "b"]);
    expect(mergeConfig(withEntries, { security: { access: { allowlist: [] } } }).security.access.allowlist)
      .toEqual([]);
  });

  test("accepts optional keys that have no default value", () => {
    const merged = mergeConfig(base(), {
      daemon: { orchestrator: "nouva" },
      llm: { context: { summary_model: "claude-haiku-4-5-20251001" } },
    });
    expect(merged.daemon.orchestrator).toBe("nouva");
    expect(merged.llm.context.summaryModel).toBe("claude-haiku-4-5-20251001");
  });

  test("ignores an unknown key rather than carrying it into the config", () => {
    const merged = mergeConfig(base(), { daemon: { log_levl: "debug" } });
    expect(merged.daemon.logLevel).toBe(DEFAULT_CONFIG.daemon.logLevel);
    expect(merged.daemon).not.toHaveProperty("logLevl");
  });
});

describe("parseConfig — provider profiles", () => {
  test("ships no provider profiles with no config at all", () => {
    const config = parseConfig({});
    expect(Object.keys(config.providers)).toEqual([]);
  });

  test("one credential serves two endpoints of the same deployment", () => {
    // The shape the old per-vendor env vars could not express: a single Nougate key behind
    // both wire formats.
    const config = parseConfig({
      providers: {
        "nougate-openai": {
          kind: "openai",
          base_url: "https://nougate.nouverse.tech/openai/v1",
          api_key: "nougate",
        },
        "nougate-anthropic": {
          kind: "anthropic",
          base_url: "https://nougate.nouverse.tech/anthropic/v1",
          api_key: "nougate",
        },
      },
    });

    expect(config.providers["nougate-openai"]?.apiKeySecret).toBe("nougate");
    expect(config.providers["nougate-anthropic"]?.apiKeySecret).toBe("nougate");
    expect(config.providers["nougate-openai"]?.kind).toBe("openai");
    expect(config.providers["nougate-anthropic"]?.kind).toBe("anthropic");
  });

  test("a fully specified profile parses correctly", () => {
    const config = parseConfig({
      providers: {
        anthropic: {
          kind: "anthropic",
          base_url: "https://api.anthropic.com/v1",
          api_key: "anthropic_api_key",
        },
      },
    });
    expect(config.providers.anthropic).toEqual({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeySecret: "anthropic_api_key",
      // What its endpoint is known to keep a cached prompt for: read off the address, not written in the file.
      cacheMinutes: 5,
    });
  });

  test("keeps extra headers for gateways that need attribution", () => {
    const config = parseConfig({
      providers: {
        openrouter: {
          kind: "openai",
          base_url: "https://openrouter.ai/api/v1",
          api_key: "openrouter",
          headers: { "HTTP-Referer": "https://nouverse.tech" },
        },
      },
    });
    expect(config.providers.openrouter?.headers).toEqual({
      "HTTP-Referer": "https://nouverse.tech",
    });
  });

  test("rejects a pasted credential where a secret name belongs", () => {
    expect(() =>
      parseConfig({
        providers: {
          nougate: { kind: "openai", base_url: "https://x/v1", api_key: "sk-nou-realkeyvalue" },
        },
      }),
    ).toThrow(/looks like a credential, not a name/);
  });

  test("rejects an unknown wire format", () => {
    expect(() =>
      parseConfig({ providers: { x: { kind: "gemini", base_url: "https://x", api_key: "k" } } }),
    ).toThrow(/kind must be "openai" or "anthropic"/);
  });

  test("a profile says how it is billed: included for a subscription, metered when it says nothing, nothing else", () => {
    const profiles = (billing?: string) =>
      parseConfig({ providers: { nougate: { kind: "openai", base_url: "https://x/v1", api_key: "nougate", ...(billing ? { billing } : {}) } } }).providers;
    expect(profiles("included").nougate?.billing).toBe("included");
    expect(profiles().nougate?.billing).toBeUndefined();
    expect(profiles("metered").nougate?.billing).toBeUndefined();
    expect(() => profiles("free")).toThrow(/billing must be "metered" or "included", got "free"/);
  });

  test("rejects a default provider that names no profile", () => {
    // Caught at load rather than on the first message of every agent.
    expect(() => parseConfig({ llm: { defaults: { provider: "anthropc" } } })).toThrow(
      /provider "anthropc" is not defined/,
    );
  });
});

describe("parseConfig — gateway instances", () => {
  test("no gateways by default, so a fresh checkout serves only the dashboard", () => {
    expect(parseConfig({}).gateways).toEqual([]);
  });

  test("names each instance so one platform can host several bots", () => {
    // The thing a single DISCORD_BOT_TOKEN could never express: two agents, two bot
    // identities, one daemon.
    const config = parseConfig({
      gateways: {
        telegram: {
          nouva: { enabled: true, token: "telegram-nouva", agent: "nouva" },
          nox: { enabled: true, token: "telegram-nox", agent: "nox" },
        },
      },
    });

    expect(config.gateways.map((g) => g.id)).toEqual(["telegram:nouva", "telegram:nox"]);
    expect(config.gateways[0]).toMatchObject({
      platform: "telegram",
      name: "nouva",
      tokenSecret: "telegram-nouva",
      agent: "nouva",
      mode: "polling",
    });
  });

  test("refuses webhook mode, on or off: never implemented, and 0.7.22 removed it from every file", () => {
    for (const enabled of [true, false]) {
      expect(() => parseConfig({ gateways: { telegram: { a: { enabled, token: "t", mode: "webhook" } } } })).toThrow(
        /\[gateways\.telegram\.a\] mode = "webhook" is gone: it was never implemented\. Remove mode: Telegram polls\./,
      );
    }
  });


  test("refuses an enabled instance with no token", () => {
    expect(() => parseConfig({ gateways: { discord: { main: { enabled: true } } } })).toThrow(
      /is enabled but has no token/,
    );
  });

  test("allows a disabled instance with no token", () => {
    const config = parseConfig({ gateways: { discord: { main: { enabled: false } } } });
    expect(config.gateways[0]?.enabled).toBe(false);
  });

  test("does not require a bot token for whatsapp, which talks to its own bridge", () => {
    const config = parseConfig({
      gateways: { whatsapp: { main: { enabled: true, encryption_key: "wa-key" } } },
    });
    expect(config.gateways[0]?.encryptionKeySecret).toBe("wa-key");
  });

  test("rejects an unknown platform", () => {
    expect(() => parseConfig({ gateways: { slack: { main: { enabled: true } } } })).toThrow(
      /not a known platform/,
    );
  });

  test("rejects a pasted bot token where a secret name belongs", () => {
    expect(() =>
      parseConfig({
        gateways: {
          telegram: {
            nouva: {
              enabled: true,
              token: "8123456789:AAF-abcdefghijklmnopqrstuvwxyz012345678",
            },
          },
        },
      }),
    ).toThrow(/looks like a credential, not a name/);
  });
});

describe("the spend cap", () => {
  test("the shipped default does not claim one", () => {
    // It used to default to 50, which reads as "$50/day is enforced" — and for the whole of Phase 1
    // nothing recorded spend and nothing stopped a turn. Zero remains the default now that it *is*
    // enforced, for a different reason: a cap nobody asked for that stops an agent mid-job is a worse
    // first experience than no cap.
    expect(parseConfig({}).llm.limits.maxDailyCostUsd).toBe(0);
  });

  // `addLogSink` has no remover, so one sink is installed for this block and the buffer is read by
  // offset. Adding one per test would leave every earlier sink still firing.
  const warnings: string[] = [];
  addLogSink((entry) => {
    if (entry.level === "warn") warnings.push(entry.message);
  });

  test("setting it no longer warns, because it is no longer inert", () => {
    // This test previously asserted the opposite, and that was correct at the time: the warning
    // existed because the value described a guarantee nobody had implemented. Spend is recorded per
    // provider call now and a turn over the cap is refused before the provider is called, so the
    // warning would be the thing that is false.
    const from = warnings.length;
    reportConfigAdvisories(parseConfig({ llm: { limits: { max_daily_cost_usd: 25 } } }), (message) => void warnings.push(message));
    expect(warnings.slice(from).join("\n")).not.toMatch(/NOT enforced/);
  });

  test("zero is silent", () => {
    const from = warnings.length;
    reportConfigAdvisories(parseConfig({}), (message) => void warnings.push(message));
    expect(warnings.slice(from).join("\n")).not.toMatch(/max_daily_cost_usd/);
  });
});

/** 0.5's `[session_memory]` and 0.7.x's `[rsi]`: 0.7.x rewrote both on disk, and 0.8.0 refuses them, naming today's. */
describe("parseConfig — tables 0.7.x rewrote", () => {
  test("[session_memory] is refused, naming [rollover]", () => {
    expect(() => parseConfig({ session_memory: { reset: { mode: "daily", at_hour: 5 } } })).toThrow(/\[session_memory\] is gone: its reset is \[rollover\]/);
  });

  test("[rsi] is refused, naming [skills.learning] and its modes", () => {
    expect(() => parseConfig({ rsi: { mode: "always_allow" } })).toThrow(/\[rsi\] is gone: write \[skills\.learning\].*always_allow is auto/);
    expect(() => parseConfig({ rsi: { mode: "off" }, skills: { learning: { mode: "off" } } })).toThrow(/\[rsi\] is gone/);
  });
});

describe("parseConfig — [skills.learning] mode", () => {
  test("an unrecognised mode parses rather than refusing to boot", () => {
    /**
     * Deliberate, and the engine is where it is made safe: the loader tolerates a bad enum so a file
     * it accepted yesterday cannot stop the daemon starting, and `ReflectionEngine.autonomous`
     * matches `auto` exactly, so a typo is gated rather than autonomous. `lintConfig` is what reports it.
     */
    expect(String(parseConfig({ skills: { learning: { mode: "automatic" } } }).skills.learning.mode)).toBe("automatic");
  });

});
