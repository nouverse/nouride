/**
 * `nouride config check` over who may talk to an install without a code: an agent open to everyone, and a file that
 * still says the whole install is.
 *
 * The check is where a person looks before an upgrade and after an edit, with no daemon to ask. It says which agents
 * answer anyone, where and within which numbers, since nothing else on a terminal does; that an open agent's pack
 * lists tools it does not hold; and what the next start will write over the old `open`. Spawned, as it is run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentChecks, openFromStatus, unusedWhileOpen } from "@/cli/commands/open-agents.ts";
import { runCli } from "../cli-harness.ts";

let root: string;
let configPath: string;

const LIMITS = "\n[open]\nmax_daily_tokens = 200000\nmax_daily_messages_per_person = 30\n\n";

function pack(id: string, extra = ""): void {
  mkdirSync(join(root, "agents", id), { recursive: true });
  writeFileSync(join(root, "agents", id, "IDENTITY.md"), `${id}\n`);
  writeFileSync(join(root, "agents", id, "config.toml"), `${extra}[llm]\nprovider = "nougate"\nmodel = "m"\n`);
}

function install(more = ""): void {
  writeFileSync(
    configPath,
    `[daemon]\ndata_dir = "${join(root, "data")}"\nagents_dir = "${join(root, "agents")}"\norchestrator = "nouva"\n\n[dashboard]\nport = 9\n\n` +
      '[providers.nougate]\nkind = "openai"\nbase_url = "https://example.invalid/v1"\napi_key = "nougate"\n' +
      more,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-check-open-"));
  configPath = join(root, "config.toml");
  install();
  pack("nouva");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const check = (...flags: string[]) => runCli(["config", "check", ...flags], { cwd: root, config: configPath, env: { LOG_LEVEL: "warn" } });
const BOT = '\n[gateways.telegram.nora]\nenabled = true\ntoken = "telegram_nora"\nagent = "nora"\n';

describe("an agent open to everyone", () => {
  test("is said with where anyone reaches it and the numbers that bound it, and that its pack's other tools are not used", async () => {
    // Its own bot, another agent's, and one of its own that is switched off: anyone reaches it on the first alone.
    install(`${BOT}\n[gateways.telegram.nouva]\nenabled = true\ntoken = "telegram_nouva"\nagent = "nouva"\n\n[gateways.discord.nora]\nenabled = false\ntoken = "discord_nora"\nagent = "nora"\n`);
    pack("nora", `[agent]\naccess = "open"\n${LIMITS}[tools]\nenabled = ["exec", "read", "memory_search", "send_file"]\n\n`);
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("✓ this configuration would start");
    expect(run.out).toContain("· nora is open to everyone on telegram:nora: at most 200,000 tokens a day, and 30 messages a person");
    expect(run.out).toContain("Who wrote to it is on its page in the dashboard, not under `nouride access`. Its pack's other tools are not used while it is open: exec, read.");
    // The agent that is not open is not listed.
    expect(run.out).not.toContain("nouva is open");

    const envelope = JSON.parse((await check("--json")).out) as { ok: boolean; data: { open: unknown[] } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.open).toEqual([{ id: "nora", connections: ["telegram:nora"], limits: { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30 }, unusedTools: ["exec", "read"] }]);
  });

  test("with no connection of its own is open to nobody, and that is said as something to put right", async () => {
    pack("nora", `[agent]\naccess = "open"\n${LIMITS}`);
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("! nora is open to everyone, and owns no connection: nobody can reach it");
    expect(run.out).toContain("Give it a bot or a number of its own on its Connections tab in the dashboard, or close it on its Access tab.");
  });

  test("without its two limits will not load, and the check fails naming them", async () => {
    install(BOT);
    pack("nora", '[agent]\naccess = "open"\n\n');
    const run = await check();
    expect(run.code).toBe(1);
    expect(run.out).toContain('✗ agent nora will not load: agents/nora/config.toml [agent] access = "open" needs [open] max_daily_tokens');
    expect(run.out).not.toContain("nora is open to everyone");
  });

  test("an install with none says nothing of it", async () => {
    const run = await check();
    expect(run.out).not.toContain("open to everyone");
    expect((JSON.parse((await check("--json")).out) as { data: { open: unknown[] } }).data.open).toEqual([]);
  });
});

describe("a file that still says the whole install is open", () => {
  test("would start, as pair: what the next start writes is said, and the check writes nothing itself", async () => {
    install('\n[security.access]\nmode = "open"\n');
    const before = readFileSync(configPath, "utf8");
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("✓ this configuration would start");
    expect(run.out).toContain('! [security.access] mode = "open" is no longer taken: the next start writes mode = "pair", and lets in by name everyone an agent here has already answered');
    expect(run.out).toContain("To let anyone talk to one agent, open that agent to everyone on its Access page in the dashboard");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    // A file that says pair or allowlist has no such line.
    install('\n[security.access]\nmode = "allowlist"\n');
    expect((await check()).out).not.toContain("no longer taken");
  });

  test("a mode that never was is refused, with the two an install takes", async () => {
    install('\n[security.access]\nmode = "everyone"\n');
    const run = await check();
    expect(run.code).not.toBe(0);
    expect(run.out + run.err).toContain('[security.access] mode must be one of "allowlist", "pair", got "everyone"');
  });
});

describe("the lines themselves", () => {
  test("what the running daemon counted of its day is said with it, in the singular where it is one", () => {
    const [line] = openAgentChecks([{ id: "nora", connections: ["telegram:nora", "whatsapp:shop"], limits: { maxDailyTokens: 5_000, maxDailyMessagesPerPerson: 1 }, packTools: ["memory_search"], today: { tokens: 1_250, people: 1 } }]);
    expect(line).toEqual({
      level: "ok",
      message: "nora is open to everyone on telegram:nora, whatsapp:shop: at most 5,000 tokens a day, and 1 message a person (today: 1,250 tokens, 1 person)",
      hint: "Anyone who finds it is answered with no code, from the documents opened to everyone. Who wrote to it is on its page in the dashboard, not under `nouride access`.",
    });
  });

  test("`doctor` reads them from the running daemon: the open ones alone, with where, the numbers and the day", () => {
    const nora = { id: "nora", access: "open", tools: ["exec"], open: { connections: ["telegram:nora"], limits: { maxDailyTokens: 9, maxDailyMessagesPerPerson: 2 }, today: { tokens: 3, people: 2 } } };
    const agents = [nora, { id: "nouva", access: "pair", tools: ["exec"], open: { connections: ["telegram:nouva"], limits: null } }, { id: "old", tools: [] }];
    expect(openFromStatus(agents)).toEqual([{ id: "nora", connections: ["telegram:nora"], limits: { maxDailyTokens: 9, maxDailyMessagesPerPerson: 2 }, packTools: ["exec"], today: { tokens: 3, people: 2 } }]);
    expect(openAgentChecks(openFromStatus(agents))[0]?.message).toBe("nora is open to everyone on telegram:nora: at most 9 tokens a day, and 2 messages a person (today: 3 tokens, 2 people)");
  });

  test("the tools of a pack an open agent does not hold are every one but the daemon's four", () => {
    expect(unusedWhileOpen(["exec", "memory_search", "memory_read", "attachment_read", "send_file", "nouride", "memory_write"])).toEqual(["exec", "nouride", "memory_write"]);
    expect(unusedWhileOpen([])).toEqual([]);
  });
});
