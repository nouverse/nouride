/**
 * Every editor in `edit.ts`, against the files people actually write: `config.example.toml` whole, and the
 * hand-written shapes the 0.7.7 audit found broken — a literal string, a value over several lines, a `]` in a comment,
 * a table written inline or as dotted keys, a quoted header, a sub-table, a comment after a value.
 *
 * Two things hold for each, checked here rather than trusted to the editor's own check: the result parses to what was
 * there with exactly the one change made, and the comments the operator wrote are still in it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseToml } from "@nouride/runtime";
import { removeTomlKey, removeTomlTable, upsertTomlTable } from "@/modules/config/edit.ts";
import { addMissingPeopleKeys, removeMcpServer, removePerson, upsertMcpServer, upsertPerson } from "@/modules/config/edit-blocks.ts";

type Parsed = Record<string, unknown>;

const EXAMPLE = readFileSync(join(import.meta.dir, "../../../../config.example.toml"), "utf8");
const parse = (text: string) => parseToml<Parsed>(text);

/** `after` parses to `before` with `change` made to it, and nothing else. */
function expectChange(before: string, after: string, change: (parsed: Parsed) => void): void {
  const expected = structuredClone(parse(before));
  change(expected);
  expect(parse(after)).toEqual(expected as never);
}

function at(parsed: Parsed, path: string[]): Parsed {
  let table = parsed;
  for (const segment of path) table = (table[segment] ??= {}) as Parsed;
  return table;
}

describe("config.example.toml, through every table the settings write", () => {
  const writes: [string, Record<string, string | number | boolean | string[]>][] = [
    ["security.access", { mode: "allowlist" }],
    ["agents", { group_context_messages: 12, mentions_enabled: false, mention_max_hops: 3 }],
    ["security.exec", { sensitive_paths: "hardline" }],
    ["llm.limits", { max_tool_iterations: 40, max_turn_duration_ms: 600000, max_daily_cost_usd: 5 }],
    ["dashboard", { password_login: false }],
    ["security.web", { search_kind: "brave", search_api_key: "brave_key", fallback_backends: ["duckduckgo"] }],
    ["skills", { off: ["a", "b"] }],
    ["jobs", { quiet_after_minutes: 30 }],
    ["rsi", { mode: "off", cooldown_ms: 1000 }],
    ["mcp_server", { enabled: true }],
    ["daemon", { default_agent: "nouva" }],
    ["providers.local", { kind: "openai", base_url: "http://127.0.0.1:1/v1", api_key: "local_key" }],
    ["gateways.telegram.second", { enabled: false, token: "second_token", agent: "nouva" }],
    ["memory", { prompt_recent: 8 }],
    ["memory.semantic", { enabled: true, model: "bge-m3" }],
  ];
  for (const [table, values] of writes) {
    test(`[${table}]`, () => {
      const after = upsertTomlTable(EXAMPLE, table, values);
      expectChange(EXAMPLE, after, (parsed) => Object.assign(at(parsed, table.split(".")), values));
      // The documentation is the file: every comment line of the example is still there.
      for (const line of EXAMPLE.split("\n").filter((l) => l.trim().startsWith("#"))) expect(after).toContain(line);
    });
  }
});

describe("hand-written shapes", () => {
  test("a value over several lines is replaced whole, not its first line", () => {
    const before = `[security.web]\nfallback_backends = [\n  "duckduckgo", # first\n  "brave",\n]\n`;
    const after = upsertTomlTable(before, "security.web", { fallback_backends: ["searxng"] });
    expectChange(before, after, (parsed) => (at(parsed, ["security", "web"]).fallback_backends = ["searxng"]));
  });

  test("a comment after a value stays when the value changes", () => {
    const before = `[security.web]\nsearch_api_key = "old" # a secret NAME, never the key itself\n`;
    const after = upsertTomlTable(before, "security.web", { search_api_key: "brave_search_api_key" });
    expect(after).toBe(`[security.web]\nsearch_api_key = "brave_search_api_key" # a secret NAME, never the key itself\n`);
  });

  test("a new key goes under its table's last value, not under the next section's banner", () => {
    const before = `[dashboard]\nport = 18254\n\n# ── Control API ──\n# The token the CLI uses.\n[control]\nx = 1\n`;
    const after = upsertTomlTable(before, "dashboard", { password_login: false });
    expect(after).toBe(`[dashboard]\nport = 18254\npassword_login = false\n\n# ── Control API ──\n# The token the CLI uses.\n[control]\nx = 1\n`);
  });

  test("a table written inline in its parent is changed there", () => {
    const before = `[security]\naccess = { mode = "pair", allowlist = ["telegram:1"] } # who may talk\n`;
    const after = upsertTomlTable(before, "security.access", { mode: "allowlist" });
    expectChange(before, after, (parsed) => (at(parsed, ["security", "access"]).mode = "allowlist"));
    expect(after).toContain("# who may talk");
  });

  test("a table written as dotted keys in its parent is changed there", () => {
    const before = `[security]\naccess.mode = "pair" # dotted\n`;
    const after = upsertTomlTable(before, "security.access", { mode: "open", allowlist: ["a"] });
    expectChange(before, after, (parsed) => Object.assign(at(parsed, ["security", "access"]), { mode: "open", allowlist: ["a"] }));
  });

  test("a header with spaces or quotes is the same table", () => {
    for (const header of ["[ security.access ]", '["security"."access"]', "[security . 'access']"]) {
      const before = `${header}\nmode = "pair"\n`;
      const after = upsertTomlTable(before, "security.access", { mode: "allowlist" });
      expectChange(before, after, (parsed) => (at(parsed, ["security", "access"]).mode = "allowlist"));
    }
  });

  test("a key removed takes its whole value with it", () => {
    const before = `[llm]\nmodel = "m"\nstop = [\n  "a",\n  "b",\n]\nprovider = "p"\n`;
    const after = removeTomlKey(before, "llm", "stop");
    expectChange(before, after, (parsed) => delete at(parsed, ["llm"]).stop);
  });

  test("a table removed takes its sub-tables, and leaves a sibling whose name it begins", () => {
    const before = [
      "[gateways.telegram.nouva]",
      'token = "t"',
      "",
      "[gateways.telegram.nouva.resilience]",
      "max_attempts = 3",
      "",
      "# ── The second bot ──",
      "[gateways.telegram.nouva2]",
      'token = "u"',
      "",
    ].join("\n");
    const after = removeTomlTable(before, "gateways.telegram.nouva");
    expectChange(before, after, (parsed) => delete at(parsed, ["gateways", "telegram"]).nouva);
    // The banner sat above the next table, and stays with it.
    expect(after).toContain("# ── The second bot ──\n[gateways.telegram.nouva2]");
  });

  test("a provider removed with its headers sub-table, so the next boot has no half-profile", () => {
    const before = `[providers.openrouter]\nkind = "openai"\n\n[providers.openrouter.headers]\nX-Title = "nouride"\n\n[providers.local]\nkind = "openai"\n`;
    const after = removeTomlTable(before, "providers.openrouter");
    expectChange(before, after, (parsed) => delete at(parsed, ["providers"]).openrouter);
  });
});

describe("[[people]]", () => {
  test("a literal-string key is the person's key: found, patched, not given a second one", () => {
    const before = `[[people]]\nkey = 'ann'\nname = 'Ann'\n`;
    expect(addMissingPeopleKeys(before, ["ann"])).toBe(before);
    const after = upsertPerson(before, { key: "ann", name: "Ann B" });
    expectChange(before, after, (parsed) => ((parsed.people as Parsed[])[0]!.name = "Ann B"));
    expectChange(before, removePerson(before, { key: "ann" }), (parsed) => delete parsed.people);
  });

  test("notes over several lines, basic or literal, are replaced whole", () => {
    for (const notes of ['"""\nlikes tea\nhates "coffee"\n"""', "'''\nlikes tea\n'''"]) {
      const before = `[[people]]\nkey = "ann"\nname = "Ann"\nnotes = ${notes}\n\n[[people]]\nkey = "bo"\nname = "Bo"\n`;
      const after = upsertPerson(before, { key: "ann", name: "Ann", notes: "likes tea, black" });
      expectChange(before, after, (parsed) => ((parsed.people as Parsed[])[0]!.notes = "likes tea, black"));
    }
  });

  test("ids over several lines, with a ] in a comment, are read and replaced whole", () => {
    const before = `[[people]]\nkey = "ann"\nname = "Ann"\nids = [\n  "telegram:1", # ] not the end\n  'discord:2',\n]\n`;
    const after = upsertPerson(before, { key: "ann", name: "Ann", ids: ["telegram:1"] });
    expectChange(before, after, (parsed) => ((parsed.people as Parsed[])[0]!.ids = ["telegram:1"]));
    // Found by an account in that array when the block has no key.
    const keyless = before.replace('key = "ann"\n', "");
    const keyed = upsertPerson(keyless, { key: "ann", name: "Ann" }, ["discord:2"]);
    expectChange(keyless, keyed, (parsed) => ((parsed.people as Parsed[])[0]!.key = "ann"));
  });
});

describe("[[servers]]", () => {
  const block = [
    "[[servers]]",
    "# the search box on the NAS",
    "name = 'search'",
    'transport = "streamable-http"',
    'url = "http://nas:8080/mcp"',
    'parallel_safe = ["search_*"]',
    'headers = { "X-Api-Key" = "named" }',
    "",
  ].join("\n");

  test("a save from the form changes what the form owns and keeps the rest", () => {
    const after = upsertMcpServer(block, { name: "search", transport: "streamable-http", url: "http://nas:9090/mcp" });
    expectChange(block, after, (parsed) => ((parsed.servers as Parsed[])[0]!.url = "http://nas:9090/mcp"));
    expect(after).toContain("# the search box on the NAS");
  });

  test("a literal-string name is found, to change and to remove", () => {
    const removed = removeMcpServer(block, "search");
    expectChange(block, removed, (parsed) => delete parsed.servers);
  });
});

describe("what the editor cannot change safely is refused, not written", () => {
  test("a file that does not parse is not edited", () => {
    expect(() => upsertTomlTable("[security\nmode = 1\n", "security", { mode: "x" })).toThrow();
  });

  test("a table this editor does not model — one element's sub-table — is a refusal, not a file saying something else", () => {
    // Appending `[servers.env]` would hand the env to whichever server happens to be last.
    const before = `[[servers]]\nname = "a"\n\n[[servers]]\nname = "b"\n`;
    expect(() => upsertTomlTable(before, "servers.env", { TOKEN: "x" })).toThrow("cannot change safely");
  });
});
