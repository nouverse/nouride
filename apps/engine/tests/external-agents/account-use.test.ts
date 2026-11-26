/**
 * An account's use asked of its maker (`account-use.ts`): with the token where the row says the CLI keeps it, read as
 * the agent whose folder it is in; once in five minutes; and the newer of that and what a CLI on it said while working.
 */

import { describe, expect, test } from "bun:test";
import type { CliRow, CliUse } from "@nouride/acp";
import { AccountUses, USE_FRESH_MS, type RunningOnAccount } from "@/modules/external-agents/account-use.ts";

const NOW = Date.parse("2026-11-27T10:00:00Z");
const USE: CliUse = { limits: [{ id: "five_hour", label: "5-hour", windows: [{ usedPercent: 44, minutes: 300, resetsAt: NOW + 3_600_000 }] }] };

const HTTP: CliRow = {
  id: "maker-cli",
  name: "Maker CLI",
  command: "maker",
  args: [],
  install: "x",
  versionArgs: ["--version"],
  instructionFile: "AGENTS.md",
  profileEnv: "MAKER_HOME",
  sharedLogin: { args: [], env: "MAKER_TOKEN", tokenPrefix: "tok-" },
  readUse: {
    kind: "http",
    method: "POST",
    url: "https://maker.example.test/usage",
    token: [{ env: "MAKER_TOKEN" }, { file: "auth.json", path: ["tokens", "access"] }],
    headers: { "Content-Type": "application/json" },
    fileHeaders: { "Account-Id": { file: "auth.json", path: ["tokens", "account"] } },
    body: "{}",
    parse: (answer) => ((answer as { ok?: boolean }).ok ? USE : null),
  },
};

function harness(options: { shared?: string; files?: Record<string, string>; status?: number; running?: RunningOnAccount[] } = {}) {
  let now = NOW;
  const asked: { url: string; init: RequestInit }[] = [];
  const read: string[] = [];
  const uses = new AccountUses({
    sharedToken: () => options.shared,
    folderOf: (row, agentId, account) => `/agents/${agentId}/.cli/${row.id}/${account}`,
    readAs: async (agentId, path) => (read.push(`${agentId} ${path}`), options.files?.[path]),
    running: () => options.running ?? [],
    fetch: (async (url: string, init: RequestInit) => (asked.push({ url, init }), new Response(JSON.stringify({ ok: true }), { status: options.status ?? 200 }))) as unknown as typeof fetch,
    now: () => now,
  });
  return { uses, asked, read, later: (ms: number) => void (now += ms) };
}

describe("an account's use, asked of its maker", () => {
  test("with a shared account's kept token, as the row asks it, once in five minutes", async () => {
    const { uses, asked, later } = harness({ shared: "tok-shared" });
    expect(await uses.of(HTTP, "work", [])).toEqual({ use: USE, at: NOW });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://maker.example.test/usage");
    expect(asked[0]!.init).toMatchObject({ method: "POST", body: "{}", headers: { accept: "application/json", "Content-Type": "application/json", authorization: "Bearer tok-shared" } });
    // Asked again within five minutes: the last read. Past them: asked again.
    later(USE_FRESH_MS - 1);
    expect(await uses.of(HTTP, "work", [])).toEqual({ use: USE, at: NOW });
    expect(asked).toHaveLength(1);
    later(1);
    await uses.of(HTTP, "work", []);
    expect(asked).toHaveLength(2);
  });

  test("else from the sign-in file of the first agent on it that has one, read as that agent, with the headers beside it", async () => {
    const auth = JSON.stringify({ tokens: { access: "tok-file", account: "acc-9" } });
    const { uses, asked, read } = harness({ files: { "/agents/kuro/.cli/maker-cli/work/auth.json": auth } });
    expect((await uses.of(HTTP, "work", ["nix", "kuro"]))?.use).toEqual(USE);
    expect(read).toEqual(["nix /agents/nix/.cli/maker-cli/work/auth.json", "kuro /agents/kuro/.cli/maker-cli/work/auth.json"]);
    expect(asked[0]!.init.headers).toMatchObject({ authorization: "Bearer tok-file", "Account-Id": "acc-9" });
  });

  test("not known where no token is found, the maker refuses, or a CLI with no reader said nothing; a failed read is not asked again at once", async () => {
    const none = harness({ files: { "/agents/nix/.cli/maker-cli/work/auth.json": "not json" } });
    expect(await none.uses.of(HTTP, "work", ["nix"])).toBeNull();
    expect(none.asked).toHaveLength(0);
    const refused = harness({ shared: "tok-shared", status: 401 });
    expect(await refused.uses.of(HTTP, "work", [])).toBeNull();
    expect(await refused.uses.of(HTTP, "work", [])).toBeNull();
    expect(refused.asked).toHaveLength(1);
    const { readUse: _none, ...silent } = HTTP;
    expect(await harness({ shared: "tok-shared" }).uses.of(silent, "work", [])).toBeNull();
  });

  test("two asking at once wait for the one read", async () => {
    const { uses, asked } = harness({ shared: "tok-shared" });
    const [first, second] = await Promise.all([uses.of(HTTP, "work", []), uses.of(HTTP, "work", [])]);
    expect(first).toEqual(second);
    expect(asked).toHaveLength(1);
  });

  test("by a method of the CLI's own, asked on a CLI running on the account; none running is not known", async () => {
    const methods: string[] = [];
    const row: CliRow = { ...HTTP, readUse: { kind: "acp", method: "_maker/billing", parse: (answer) => ((answer as { ok?: boolean }).ok ? USE : null) } };
    const running: RunningOnAccount = { ask: async (method) => (methods.push(method), { ok: true }), accountUse: null };
    expect((await harness({ running: [running] }).uses.of(row, "work", []))?.use).toEqual(USE);
    expect(methods).toEqual(["_maker/billing"]);
    expect(await harness().uses.of(row, "work", [])).toBeNull();
  });

  test("what a CLI on the account said while it worked, where it is newer than the last read", async () => {
    const said = { use: { limits: [] }, at: NOW + 1 };
    const { readUse: _none, ...silent } = HTTP;
    expect(await harness({ running: [{ ask: async () => null, accountUse: said }] }).uses.of(silent, "work", [])).toBe(said);
    expect(await harness({ shared: "tok-shared", running: [{ ask: async () => null, accountUse: { ...said, at: NOW - 1 } }] }).uses.of(HTTP, "work", [])).toEqual({ use: USE, at: NOW });
  });
});
