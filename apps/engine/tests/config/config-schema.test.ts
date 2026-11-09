/**
 * The config surface, described for something that cannot read the source.
 *
 * The whole point is that a packaged install has no `src/` to inspect, so these answers have to come
 * from the binary. Which makes drift the thing to guard: a schema that describes a key the loader
 * ignores, or omits one it accepts, is worse than no schema — it is believed.
 */

import { describe, expect, test } from "bun:test";
import {
  CONFIG_ENUMS,
  configAnnotationDrift,
  configJsonSchema,
  describeConfig,
  fieldsIn,
  findField,
  lintConfig,
  snakeCase,
  FALLBACK_BACKEND_NAMES,
} from "@/modules/config/schema.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { configProblem, parseConfig } from "@/modules/config/global/index.ts";

describe("the described surface matches the real one", () => {
  test("every described key resolves to a real place in the config", () => {
    // `deepMerge` accepts a key if and only if it exists in `DEFAULT_CONFIG`, so that object is the
    // authority. Anything here that does not resolve is documentation of a key the loader would
    // ignore — an operator would set it, see no error, and get no effect.
    const open = new Set(["providers", "gateways", "people"]);
    for (const field of describeConfig()) {
      if (open.has(field.path)) continue;
      let cursor: unknown = DEFAULT_CONFIG;
      for (const segment of field.path.split(".")) {
        const camel = segment.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        expect(cursor === null || typeof cursor !== "object").toBe(false);
        expect(camel in (cursor as Record<string, unknown>)).toBe(true);
        cursor = (cursor as Record<string, unknown>)[camel];
      }
    }
  });

  test("no annotation describes a key that no longer exists", () => {
    // The one direction the derivation cannot protect: prose outliving its key. A renamed setting
    // would leave an entry here that `config explain` never reaches and nothing else would notice.
    expect(configAnnotationDrift()).toEqual([]);
  });

  test("every leaf of the real config is described", () => {
    const described = new Set(describeConfig().map((f) => f.path));
    const missing: string[] = [];
    const walk = (node: Record<string, unknown>, prefix: string): void => {
      for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${snakeCase(key)}` : snakeCase(key);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          walk(value as Record<string, unknown>, path);
        } else if (!described.has(path)) {
          missing.push(path);
        }
      }
    };
    walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, "");
    expect(missing).toEqual([]);
  });

  test("enum values are the ones the loader actually accepts", () => {
    // `CONFIG_ENUMS` is imported by `config/global/validate.ts` for exactly this reason, but the four it validates
    // are worth pinning: a schema advertising a value that fails at boot is the worst kind of lie.
    for (const value of CONFIG_ENUMS["security.exec.landlock"]) {
      expect(() => parseConfig({ security: { exec: { landlock: value } } })).not.toThrow();
    }
    for (const value of CONFIG_ENUMS["security.access.mode"]) {
      expect(() => parseConfig({ security: { access: { mode: value } } })).not.toThrow();
    }
    expect(() => parseConfig({ security: { exec: { landlock: "nonsense" } } })).toThrow();
  });

  test("the shipped defaults are inside their own enums", () => {
    // A default outside its enum would make `config check` refuse a file nobody wrote.
    const config = parseConfig({});
    for (const [path, allowed] of Object.entries(CONFIG_ENUMS)) {
      let cursor: unknown = config;
      for (const segment of path.split(".")) {
        const camel = segment.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        cursor = (cursor as Record<string, unknown>)[camel];
      }
      if (cursor === undefined) continue;
      expect(allowed as readonly string[]).toContain(String(cursor));
    }
  });
});

describe("what a caller gets back", () => {
  test("a section filter returns that section and nothing else", () => {
    const fields = fieldsIn("security.web");
    expect(fields.length).toBeGreaterThan(3);
    expect(fields.every((f) => f.path.startsWith("security.web."))).toBe(true);
  });

  test("the JSON Schema nests the way the TOML does", () => {
    // The mistake this whole command exists to answer is `[web]` versus `[security.web]`. A flat list
    // of dotted paths would answer the easy half of it.
    const schema = configJsonSchema() as any;
    expect(schema.properties.security.properties.web.properties.search_endpoint.type).toBe("string");
    expect(schema.properties.web).toBeUndefined();
  });

  test("a number with no default is still described as a number, with the bounds the loader holds it to", () => {
    // Absent means "worked out" for these, so the walk had no value to read a type from and called them text: an agent
    // reading the schema would write `max_running = "3"`, which the loader refuses.
    type Section = { properties: Record<string, Record<string, unknown>> };
    const missions = configJsonSchema("missions") as Section;
    // No most and no default: both are the agents'.
    expect(Object.keys(missions.properties.max_running ?? {})).not.toContain("maximum");
    expect(missions.properties.max_running).toMatchObject({ type: "integer", minimum: 1 });
    expect(Object.keys(missions.properties.max_running ?? {})).not.toContain("default");
    const context = configJsonSchema("llm.context") as Section;
    expect(context.properties.compact_at_tokens).toMatchObject({ type: "integer", minimum: 16_000 });
    // `config explain` reads the field itself.
    expect(findField("missions.max_running")).toMatchObject({ type: "number", minimum: 1, integer: true });
    expect(findField("llm.context.compact_at_tokens")?.type).toBe("number");
  });

  test("a section schema is rooted at that section", () => {
    const schema = configJsonSchema("security.web") as any;
    expect(schema.properties.search_endpoint).toBeDefined();
    expect(schema.properties.security).toBeUndefined();
  });

  test("a credential field says it holds a name, not a value", () => {
    // The single most expensive misunderstanding available here: pasting the key into the config.
    const field = findField("security.web.search_api_key");
    expect(field?.secretRef).toBe(true);
    const schema = configJsonSchema("security.web") as any;
    expect(schema.properties.search_api_key["x-secret-ref"]).toBe(true);
  });

  test("the caveat travels with the field, because it is the part nobody can guess", () => {
    expect(findField("security.web.search_endpoint")?.caveat).toContain("allow_private_urls");
    expect(findField("security.web.allow_private_urls")?.caveat).toContain("SSRF");
  });

  test("job_max_ms says what it stops, what it spares, and that 0 is off — nothing fails without the annotation", () => {
    const field = findField("security.job_max_ms");
    expect(field?.description).toContain("0 never stops one");
    expect(field?.caveat).toContain("Services are exempt");
    expect(field?.caveat).toContain("2147483647");
    expect(field?.example).toContain("job_max_ms = ");
  });

  test("open-shaped sections are described by hand rather than by whatever is loaded", () => {
    // Walking `config.providers` would document one install; the format is what a reader needs.
    const providers = findField("providers");
    expect(providers?.type).toBe("table[]");
    expect(providers?.caveat).toContain("name");
  });
});

describe("the semantic lint", () => {
  const base = (over: Record<string, unknown>) => parseConfig(over);

  test("an alerts gateway no connection is called — the dashboard's `local:dev` until 0.6 — is said, naming the real ones", () => {
    const gateways = { telegram: { nouva: { enabled: true, token: "telegram_nouva" } } };
    const lints = lintConfig(base({ gateways, alerts: { gateway: "local:dev", chat_id: "dev" } }));
    const hit = lints.find((l) => l.message.includes("[alerts] gateway"));
    expect(hit?.message).toBe('[alerts] gateway "local:dev" is no connection of this daemon, so daemon failures reach the log and nobody else');
    expect(hit?.hint).toBe('Name one of [gateways]: "telegram:nouva".');
    // One that exists says nothing.
    expect(lintConfig(base({ gateways, alerts: { gateway: "telegram:nouva", chat_id: "1" } })).some((l) => l.message.includes("[alerts]"))).toBe(false);
  });

  test("a private search endpoint without the flag is the headline case", () => {
    // Boots fine, then refuses every request. The RFC's own example configuration.
    const lints = lintConfig(
      base({
        security: { web: { search_endpoint: "http://192.168.0.10:9088/res/v1/web/search" } },
      }),
    );
    const hit = lints.find((l) => l.message.includes("192.168.0.10"));
    expect(hit?.level).toBe("bad");
    expect(hit?.hint).toContain("allow_private_urls");
  });

  test("the same endpoint with the flag set is silent", () => {
    const lints = lintConfig(
      base({
        security: {
          web: { search_endpoint: "http://192.168.0.10:9088/res/v1/web/search", allow_private_urls: true },
        },
      }),
    );
    expect(lints.some((l) => l.message.includes("192.168.0.10"))).toBe(false);
  });

  test("a public endpoint is not mistaken for a private one", () => {
    const lints = lintConfig(base({ security: { web: { search_endpoint: "https://api.search.brave.com/res/v1/web/search" } } }));
    expect(lints.some((l) => l.message.includes("SSRF") || l.message.includes("blocks"))).toBe(false);
  });

  test("searxng with no endpoint cannot work and says so", () => {
    const lints = lintConfig(base({ security: { web: { search_kind: "searxng" } } }));
    expect(lints.some((l) => l.level === "bad" && l.message.includes("searxng"))).toBe(true);
  });

  test("brave with neither key nor proxy is a warning, not a refusal", () => {
    // It still works — search falls back to keyless scraping rather than disappearing.
    const lints = lintConfig(base({ security: { web: { search_kind: "brave", search_api_key: "" } } }));
    const hit = lints.find((l) => l.message.includes("neither"));
    expect(hit?.level).toBe("warn");
  });

  test("exa loads, and with no key's name it cannot work and says so", () => {
    // Unlike Brave it does not fall back to the free sources: the agents would have no web search at all.
    const missing = lintConfig(base({ security: { web: { search_kind: "exa", search_api_key: "" } } }));
    expect(missing.find((l) => l.message.includes('search_kind = "exa"'))).toMatchObject({
      level: "bad",
      message: '[security.web] search_kind = "exa" has no search_api_key',
    });
    const named = lintConfig(base({ security: { web: { search_kind: "exa", search_api_key: "exa_api_key" } } }));
    expect(named.filter((l) => l.message.includes("exa"))).toEqual([]);
    // The loader's own steps: accepted, and a typo refused naming every kind there is.
    expect(configProblem('[security.web]\nsearch_kind = "exa"\nsearch_api_key = "exa_api_key"\n')).toBeNull();
    expect(configProblem('[security.web]\nsearch_kind = "gogle"\n')).toContain('search_kind must be one of "brave", "searxng", "exa"');
  });

  test("exa as a fallback with no key to use is reported", () => {
    const lints = lintConfig(base({ security: { web: { search_api_key: "", fallback_backends: ["exa", "duckduckgo"] } } }));
    expect(lints.some((l) => l.message === "[security.web] fallback_backends lists exa, which has no credential to use")).toBe(true);
  });

  test("an unusable name in the fallback chain is reported rather than skipped in silence", () => {
    const lints = lintConfig(base({ security: { web: { fallback_backends: ["gopher"] } } }));
    expect(lints.some((l) => l.message.includes("gopher"))).toBe(true);
  });

  test("searxng as a fallback is reported, because it has no endpoint to fall back onto", () => {
    const lints = lintConfig(base({ security: { web: { fallback_backends: ["searxng"] } } }));
    expect(lints.some((l) => l.message.includes("searxng"))).toBe(true);
  });

  test("an enum typo is reported even where the loader tolerates it", () => {
    // `search_kind` is not refused at boot — the loader ignores an unrecognised value — so this is
    // the only place it is ever said out loud.
    const config = base({});
    (config.security.web as { searchKind: string }).searchKind = "gogle";
    const lints = lintConfig(config);
    expect(lints.some((l) => l.level === "bad" && l.message.includes("gogle"))).toBe(true);
  });

  test("a queue timeout below the turn deadline is reported", () => {
    // A message queued behind one full-length turn is dropped before it ever runs.
    const lints = lintConfig(base({ queue: { queue_timeout_ms: 120_000 } }));
    expect(lints.some((l) => l.message.includes("queue_timeout_ms"))).toBe(true);
  });

  test("the shipped defaults produce no `bad` lint", () => {
    // Warnings are fine — no alert channel, no spend cap. A `bad` on a file nobody wrote would mean
    // the lint is wrong rather than the config.
    expect(lintConfig(parseConfig({})).filter((l) => l.level === "bad")).toEqual([]);
  });

  test("every fallback name the lint accepts is one the chain can use", () => {
    for (const name of FALLBACK_BACKEND_NAMES) {
      const lints = lintConfig(base({ security: { web: { fallback_backends: [name] } } }));
      expect(lints.some((l) => l.message.includes(`"${name}", which is not a backend`))).toBe(false);
    }
  });
});
