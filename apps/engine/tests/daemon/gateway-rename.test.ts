/**
 * Renaming a gateway instance.
 *
 * The failure this file exists to prevent is not a crash. It is a rename that reaches the sessions
 * table and misses the allowlist, leaving a daemon whose history is under the new name and whose
 * access rules are under the old one — so the bot stops answering the person who owns it, and nothing
 * anywhere says why. Each assertion below is one of the places the id hides; that the rename reaches
 * every column `db/keys.ts` lists is `tests/contracts/key-columns.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseToml, readTextFileIfExists, removePath, type SqliteDb } from "@nouride/runtime";
import { parseAgentConfig, type RawAgentConfig } from "@nouride/persona";
import { sessionId as sessionIdFor } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import {
  applyRename,
  identifier,
  planRename,
  RENAMED_IDENTIFIERS,
  RenameRefusal,
  rewriteConfig,
} from "@/modules/gateways/rename.ts";
import { planPackRenames } from "@/modules/gateways/rename-packs.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { tempDir } from "../helpers.ts";

let db: SqliteDb;
let dataDir: string;

const CONFIG = `# Nouride configuration.

[daemon]
timezone = "Asia/Jakarta"

[gateways.telegram.bot]
enabled = true
token = "telegram_bot_token"
agent = "nouva"

[gateways.telegram.bot2]
enabled = true
token = "second_bot"
agent = "nix"

[gateways.whatsapp.main]
enabled = true
session_dir = "./data/whatsapp"

[security.access]
allowlist = [
  "telegram:bot:5550001111",
  "whatsapp:main:628111000001@s.whatsapp.net",
]

[[people]]
id    = "telegram:bot:5550001111"
ids   = ["whatsapp:main:100000000000001@lid"]
name  = "Gading"
`;

/** A conversation on `gateway`, with a message, a turn and a usage row pointing at it. */
function conversation(agentId: string, gateway: string, chatId: string): string {
  const id = sessionIdFor(agentId, gateway, chatId);
  db.prepare(
    `INSERT INTO sessions (id, agent_id, chat_id, gateway, context_token_count,
                           created_at, started_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 1000, 1000, 1000)`,
  ).run(id, agentId, chatId, gateway);
  db.prepare("INSERT INTO session_messages (session_id, seq, hash, message) VALUES (?, 0, NULL, ?)").run(
    id,
    JSON.stringify({ role: "user", content: `hi from ${chatId}` }),
  );
  db.prepare(
    `INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, status, prompt, started_at)
     VALUES (?, ?, ?, ?, ?, 'done', 'hi', 1000)`,
  ).run(`turn_${id}`, id, agentId, gateway, chatId);
  db.prepare(
    `INSERT INTO llm_usage (id, agent_id, session_id, model, provider, input_tokens, output_tokens, timestamp)
     VALUES (?, ?, ?, 'm', 'p', 1, 1, 1000)`,
  ).run(`use_${id}`, agentId, id);
  return id;
}

function plan(from: string, to: string, config = CONFIG, existing = ["telegram:bot", "telegram:bot2", "whatsapp:main"]) {
  return planRename({ db, config, from, to, existing });
}

beforeEach(async () => {
  dataDir = tempDir("gateway-rename");
  db = await openAndMigrate(join(dataDir, "test.db"));
});

afterEach(() => {
  db.close();
  removePath(dataDir);
});

describe("what it refuses", () => {
  test("a rename that is not a rename", () => {
    expect(() => plan("telegram:bot", "telegram:bot")).toThrow(RenameRefusal);
  });

  test("an id that is not a gateway id", () => {
    expect(() => plan("telegram", "telegram:nouva")).toThrow(/not a gateway id/);
    expect(() => plan("telegram:bot", "nouva")).toThrow(/not a gateway id/);
  });

  test("changing the platform", () => {
    /**
     * The sharp one. It would keep every session, allowlist entry and person id and quietly reassign
     * them to a different network — and a Telegram user id is not a WhatsApp jid, so nothing would
     * match again and nothing would say so.
     */
    expect(() => plan("telegram:bot", "whatsapp:nouva")).toThrow(/cannot change the platform/);
  });

  test("renaming onto a gateway that already exists", () => {
    // That is a merge, and a merge has to decide what happens to two sessions with one key.
    expect(() => plan("telegram:bot", "telegram:bot2")).toThrow(/already configured/);
  });

  test("renaming onto a name rows already have, though the config no longer does", () => {
    /**
     * A gateway removed from the config leaves its rows: removing it deletes none. The dry run used to read only the
     * config, say yes, and the apply then died on `UNIQUE constraint failed: sender_access.gateway_id,
     * sender_access.sender_id` — for a person paired with both bots.
     */
    for (const gateway of ["telegram:bot", "telegram:nouva"]) {
      db.prepare(
        `INSERT INTO sender_access (gateway_id, sender_id, status, requested_at) VALUES (?, '5550001111', 'approved', 1000)`,
      ).run(gateway);
    }
    expect(() => plan("telegram:bot", "telegram:nouva")).toThrow(/rows already name "telegram:nouva": 1 in sender_access\.gateway_id/);
    // And nothing moved.
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sender_access WHERE gateway_id = 'telegram:bot'").get()?.n).toBe(1);
  });

  test("a message still waiting for its turn on it — the boot replays its stored envelope", () => {
    const envelope = JSON.stringify({ id: "m1", gatewayId: "telegram:bot", chatId: "111", text: "hello" });
    db.prepare(
      `INSERT INTO inbox (id, gateway_id, chat_id, received_at, sent_at, status, envelope) VALUES ('telegram:bot:111:m1', 'telegram:bot', '111', 1000, 1000, 'queued', ?)`,
    ).run(envelope);
    expect(() => plan("telegram:bot", "telegram:nouva")).toThrow(/still in flight .* 1 in inbox\. .*start the daemon/);
  });

  test("a turn that never ended on it — the boot closes it from its journal", () => {
    db.prepare(`INSERT INTO turn_journal (turn_id, seq, at, entry) VALUES ('turn_1', 0, 1000, ?)`).run(
      JSON.stringify({ head: { agentId: "nouva", gatewayId: "telegram:bot", chatId: "111", kind: "chat", startedAt: 1000 } }),
    );
    expect(() => plan("telegram:bot", "telegram:nouva")).toThrow(/1 in turn_journal/);
    // Another gateway's turn in flight is not this rename's business.
    db.prepare("DELETE FROM turn_journal").run();
    db.prepare(`INSERT INTO turn_journal (turn_id, seq, at, entry) VALUES ('turn_2', 0, 1000, ?)`).run(
      JSON.stringify({ head: { agentId: "nix", gatewayId: "telegram:bot2", chatId: "333", kind: "chat", startedAt: 1000 } }),
    );
    expect(() => plan("telegram:bot", "telegram:nouva")).not.toThrow();
  });

  test("`local`, gone since 0.6, and the dashboard's own `web` are not gateways a person renames", () => {
    expect(() => plan("local:dev", "local:other")).toThrow(/not a gateway id/);
    expect(() => plan("web:dashboard", "web:other")).toThrow(/not a gateway id/);
  });
});

describe("the plan", () => {
  test("counts every column that names the gateway, and no others", () => {
    conversation("nouva", "telegram:bot", "111");
    conversation("nouva", "telegram:bot", "222");
    conversation("nix", "telegram:bot2", "333");
    db.prepare(
      `INSERT INTO sender_access (gateway_id, sender_id, status, requested_at)
       VALUES ('telegram:bot', '5550001111', 'approved', 1000)`,
    ).run();

    const result = plan("telegram:bot", "telegram:nouva");
    const counts = Object.fromEntries(
      result.rows.map((row) => [`${row.table}.${row.column}`, row.count]),
    );

    expect(counts["sessions.gateway"]).toBe(2);
    expect(counts["sessions.id"]).toBe(2);
    expect(counts["turn_records.gateway_id"]).toBe(2);
    expect(counts["turn_records.session_id"]).toBe(2);
    expect(counts["llm_usage.session_id"]).toBe(2);
    expect(counts["session_messages.session_id"]).toBe(2);
    expect(counts["sender_access.gateway_id"]).toBe(1);
  });

  test("a longer instance name is not caught by a shorter one", () => {
    // `telegram:bot2` must survive a rename of `telegram:bot`. Prefix matching here would silently
    // rewrite a second bot's entire history.
    conversation("nix", "telegram:bot2", "333");
    const result = plan("telegram:bot", "telegram:nouva");
    expect(result.rows.find((row) => row.table === "sessions")).toBeUndefined();
  });

  test("lists the config lines that mention it, including the table header", () => {
    const result = plan("telegram:bot", "telegram:nouva");
    const text = result.configLines.map((line) => line.text);
    expect(text).toContain("[gateways.telegram.bot]");
    expect(text).toContain('"telegram:bot:5550001111",');
    expect(text).toContain('id    = "telegram:bot:5550001111"');
    // …and not the other bot's header, nor the secret whose *name* merely looks similar.
    expect(text).not.toContain("[gateways.telegram.bot2]");
    expect(text.some((line) => line.includes("telegram_bot_token"))).toBe(false);
  });

  test("finds a cron delivery override", () => {
    db.prepare(
      `INSERT INTO cron_jobs (id, agent_id, name, schedule, payload, delivery, created_at,
                              target_gateway_id, target_chat_id, session, keep_after_run, created_by)
       VALUES ('cron_1', 'nouva', 'j', '{}', '{}', ?, 1000, 'telegram:bot', '111', 'fresh', 0, 'test')`,
    ).run(JSON.stringify({ mode: "announce", gatewayId: "telegram:bot", chatId: "999" }));

    const result = plan("telegram:bot", "telegram:nouva");
    expect(result.rows.find((r) => r.column === "delivery $.gatewayId")?.count).toBe(1);
    expect(result.rows.find((r) => r.column === "target_gateway_id")?.count).toBe(1);
  });

  test("the room log, the event stream and the settled inbox are counted", () => {
    const session = conversation("nouva", "telegram:bot", "111");
    db.prepare(`INSERT INTO chat_messages (id, gateway_id, chat_id, sender_id, text, at) VALUES ('cm1', 'telegram:bot', '111', '5550001111', 'hi', 1000)`).run();
    db.prepare(`INSERT INTO events (at, turn_id, agent_id, gateway_id, chat_id, kind, data) VALUES (1000, ?, 'nouva', 'telegram:bot', '111', 'turn', ?)`).run(
      `turn_${session}`,
      JSON.stringify({ phase: "start", sessionId: session, prompt: "hi" }),
    );
    const counts = Object.fromEntries(plan("telegram:bot", "telegram:nouva").rows.map((row) => [`${row.table}.${row.column}`, row.count]));
    expect(counts["chat_messages.gateway_id"]).toBe(1);
    expect(counts["events.gateway_id"]).toBe(1);
    expect(counts["events.data $.sessionId"]).toBe(1);
  });

  test("the audit log is reported as kept, not counted as rewritten", () => {
    db.prepare(`INSERT INTO audit_log (id, timestamp, actor, action, gateway) VALUES ('a1', 1000, 'x', 'y', 'telegram:bot')`).run();
    const result = plan("telegram:bot", "telegram:nouva");
    expect(result.kept).toEqual([{ table: "audit_log", column: "gateway", count: 1 }]);
    expect(result.total).toBe(0);
  });
});

describe("applying it", () => {
  test("the conversation keeps its history under the new id", () => {
    const before = conversation("nouva", "telegram:bot", "111");
    applyRename(db, plan("telegram:bot", "telegram:nouva"));

    const after = sessionIdFor("nouva", "telegram:nouva", "111");
    const row = db
      .prepare<{ id: string; gateway: string }>("SELECT id, gateway FROM sessions")
      .get();
    expect(row).toEqual({ id: after, gateway: "telegram:nouva" });
    // The turn and the usage row follow the id, or the transcript is orphaned and the spend is
    // attributed to a conversation that no longer exists.
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM turn_records WHERE session_id = ?").get(after)?.n,
    ).toBe(1);
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM llm_usage WHERE session_id = ?").get(after)?.n,
    ).toBe(1);
    // And the messages, or the agent meets the chat again with no memory of it.
    expect(new SessionStore(db).messagesById(after)).toEqual([{ role: "user", content: "hi from 111" }]);
    expect(after).not.toBe(before);
  });

  test("a chat id containing a colon survives", () => {
    /**
     * A Telegram topic reaches us as `12345:67`, so a session id has more colons than its three
     * segments suggest. Splitting and reassembling would corrupt exactly these rows — and they are
     * the hardest to notice, because everything else looks right.
     */
    conversation("nouva", "telegram:bot", "12345:67");
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    expect(db.prepare<{ id: string }>("SELECT id FROM sessions").get()?.id).toBe(
      sessionIdFor("nouva", "telegram:nouva", "12345:67"),
    );
  });

  test("another gateway's rows are untouched", () => {
    conversation("nouva", "telegram:bot", "111");
    const other = conversation("nix", "telegram:bot2", "333");
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(other)?.n,
    ).toBe(1);
  });

  test("the access rule moves with it", () => {
    // The one that decides whether the bot still answers. It used to be the thing a hand-edit forgot.
    db.prepare(
      `INSERT INTO sender_access (gateway_id, sender_id, status, requested_at)
       VALUES ('telegram:bot', '5550001111', 'approved', 1000)`,
    ).run();
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    expect(
      db.prepare<{ gateway_id: string }>("SELECT gateway_id FROM sender_access").get()?.gateway_id,
    ).toBe("telegram:nouva");
  });

  test("the cron delivery override is rewritten inside its JSON", () => {
    db.prepare(
      `INSERT INTO cron_jobs (id, agent_id, name, schedule, payload, delivery, created_at,
                              target_gateway_id, target_chat_id, session, keep_after_run, created_by)
       VALUES ('cron_1', 'nouva', 'j', '{}', '{}', ?, 1000, 'telegram:bot', '111', 'fresh', 0, 'test')`,
    ).run(JSON.stringify({ mode: "announce", gatewayId: "telegram:bot", chatId: "999" }));

    applyRename(db, plan("telegram:bot", "telegram:nouva"));

    const row = db
      .prepare<{ delivery: string; target_gateway_id: string }>(
        "SELECT delivery, target_gateway_id FROM cron_jobs",
      )
      .get();
    expect(JSON.parse(row!.delivery).gatewayId).toBe("telegram:nouva");
    expect(row!.target_gateway_id).toBe("telegram:nouva");
  });

  test("a settled inbox row moves whole — a redelivery after the rename is still recognised", () => {
    const envelope = JSON.stringify({ id: "m1", gatewayId: "telegram:bot", chatId: "111", text: "telegram:bot is my bot" });
    db.prepare(
      `INSERT INTO inbox (id, gateway_id, chat_id, received_at, sent_at, status, envelope, settled_at) VALUES ('telegram:bot:111:m1', 'telegram:bot', '111', 1000, 1000, 'done', ?, 1000)`,
    ).run(envelope);
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    const row = db.prepare<{ id: string; gateway_id: string; envelope: string }>("SELECT id, gateway_id, envelope FROM inbox").get()!;
    expect(row.id).toBe("telegram:nouva:111:m1");
    expect(row.gateway_id).toBe("telegram:nouva");
    // The key moved, and the words somebody wrote did not.
    expect(JSON.parse(row.envelope)).toEqual({ id: "m1", gatewayId: "telegram:nouva", chatId: "111", text: "telegram:bot is my bot" });
  });

  test("the event stream follows its conversation: the row's gateway, and the session its turn started in", () => {
    const before = conversation("nouva", "telegram:bot", "111");
    db.prepare(`INSERT INTO events (at, turn_id, agent_id, gateway_id, chat_id, kind, data) VALUES (1000, ?, 'nouva', 'telegram:bot', '111', 'turn', ?)`).run(
      `turn_${before}`,
      JSON.stringify({ phase: "start", sessionId: before, prompt: "about :telegram:bot: and more" }),
    );
    // A row that is not JSON at all is a row that does not match, not an error that stops the rename.
    db.prepare(`INSERT INTO events (at, turn_id, agent_id, gateway_id, chat_id, kind, data) VALUES (1001, ?, 'nouva', 'telegram:bot', '111', 'note', 'not json')`).run(`turn_${before}`);
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    const rows = db.prepare<{ gateway_id: string; data: string }>("SELECT gateway_id, data FROM events ORDER BY seq").all();
    expect(rows.map((row) => row.gateway_id)).toEqual(["telegram:nouva", "telegram:nouva"]);
    expect(JSON.parse(rows[0]!.data)).toEqual({ phase: "start", sessionId: sessionIdFor("nouva", "telegram:nouva", "111"), prompt: "about :telegram:bot: and more" });
    expect(rows[1]!.data).toBe("not json");
  });

  test("memory's index moves with the chat — a database-only change the vault rename completes", () => {
    db.prepare(
      `INSERT INTO memory_episodes (id, status, kind, chat, day, week, month, started_at, ended_at) VALUES ('2026-09-25-0900-nouva', 'raw', 'group', 'telegram:bot:-1001', '2026-09-25', '2026-W39', '2026-09', 1, 2)`,
    ).run();
    db.prepare(`INSERT INTO memory_facts (id, subject, position, section, text, readers, readers_chat) VALUES ('f1', 'gading', 1, 'Notes', 'x', ',gading,', 'telegram:bot:-1001')`).run();
    db.prepare(`INSERT INTO memory_groups (chat, slug) VALUES ('telegram:bot:-1001', 'keluarga')`).run();
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    expect(db.prepare<{ chat: string }>("SELECT chat FROM memory_episodes").get()?.chat).toBe("telegram:nouva:-1001");
    expect(db.prepare<{ readers_chat: string }>("SELECT readers_chat FROM memory_facts").get()?.readers_chat).toBe("telegram:nouva:-1001");
    expect(db.prepare<{ chat: string }>("SELECT chat FROM memory_groups").get()?.chat).toBe("telegram:nouva:-1001");
  });

  test("a chat key's prefix is matched whole: `telegram:bot2`'s are its own, and `_` is not a wildcard", () => {
    for (const chat of ["telegram:bot2:-1001", "telegram:my_bot:-1001", "telegram:myxbot:-1001"]) {
      db.prepare(`INSERT INTO memory_groups (chat, slug) VALUES (?, 'g')`).run(chat);
    }
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    applyRename(db, plan("telegram:my_bot", "telegram:mine"));
    expect(db.prepare<{ chat: string }>("SELECT chat FROM memory_groups ORDER BY chat").all().map((row) => row.chat)).toEqual([
      "telegram:bot2:-1001",
      "telegram:mine:-1001",
      "telegram:myxbot:-1001",
    ]);
  });

  test("the audit log keeps the name the gateway had at the time", () => {
    db.prepare(
      `INSERT INTO audit_log (id, timestamp, actor, action, gateway) VALUES ('a1', 1000, 'x', 'y', 'telegram:bot')`,
    ).run();
    applyRename(db, plan("telegram:bot", "telegram:nouva"));
    // Rewriting an append-only record to agree with the present is how it stops being evidence.
    expect(db.prepare<{ gateway: string }>("SELECT gateway FROM audit_log").get()?.gateway).toBe(
      "telegram:bot",
    );
  });
});

describe("the config rewrite", () => {
  const after = rewriteConfig(CONFIG, "telegram:bot", "telegram:nouva");

  test("moves the table header", () => {
    expect(after).toContain("[gateways.telegram.nouva]");
    expect(after).not.toContain("[gateways.telegram.bot]\n");
  });

  test("moves the allowlist and the people ids", () => {
    expect(after).toContain('"telegram:nouva:5550001111"');
    expect(after).toContain('id    = "telegram:nouva:5550001111"');
  });

  test("leaves the other bot, its secret name, and everything else alone", () => {
    expect(after).toContain("[gateways.telegram.bot2]");
    expect(after).toContain('token = "second_bot"');
    // The secret is named `telegram_bot_token` — underscores, not a colon. A looser rewrite would
    // rename the secret this gateway authenticates with and the daemon would refuse to start.
    expect(after).toContain('token = "telegram_bot_token"');
    expect(after).toContain('timezone = "Asia/Jakarta"');
    expect(after).toContain("# Nouride configuration.");
  });

  test("leaves whatsapp untouched when telegram is what was renamed", () => {
    expect(after).toContain("[gateways.whatsapp.main]");
    expect(after).toContain('"whatsapp:main:628111000001@s.whatsapp.net"');
  });

  test("moves the sub-tables under the header with it, and not a sibling whose name it begins", () => {
    const tuned = `[gateways.telegram.bot]\ntoken = "t"\n\n[gateways.telegram.bot.resilience] # tuned by hand\nmax_attempts = 3\n\n[gateways.telegram.bot2]\ntoken = "u"\n`;
    const moved = rewriteConfig(tuned, "telegram:bot", "telegram:nouva");
    expect(moved).toContain("[gateways.telegram.nouva.resilience] # tuned by hand");
    expect(moved).not.toContain("[gateways.telegram.bot.resilience]");
    expect(moved).toContain("[gateways.telegram.bot2]");
  });

  test("a whatsapp rename reaches the jid-shaped ids", () => {
    const moved = rewriteConfig(CONFIG, "whatsapp:main", "whatsapp:nouva");
    expect(moved).toContain("[gateways.whatsapp.nouva]");
    expect(moved).toContain('"whatsapp:nouva:628111000001@s.whatsapp.net"');
    expect(moved).toContain('ids   = ["whatsapp:nouva:100000000000001@lid"]');
    // `session_dir` is a path, not an id — the pairing lives there and must not move.
    expect(moved).toContain('session_dir = "./data/whatsapp"');
  });
});

describe("agent packs", () => {
  /**
   * The documented sequence was stop, rename, start — and every agent bound through `[channels]` was then missing:
   * boot refuses a binding to a gateway it does not have, and the CLI had printed "✓ telegram:bot is now
   * telegram:nouva". An allowlist entry on the old id was quieter: that agent stopped answering that person.
   */
  const PACK = [
    "[llm]",
    'provider = "nougate"',
    "",
    "[channels]",
    '"telegram:bot" = ["-1001234"]',
    '"telegram:bot2" = ["-1009999"]',
    "",
    "[security]",
    'sender_allowlist = ["telegram:bot:5550001111", "whatsapp:main:628111000001@s.whatsapp.net"]',
    "",
  ].join("\n");
  const check = { defaults: DEFAULT_CONFIG.llm.defaults, providers: ["nougate"] };
  const BEFORE = ["telegram:bot", "telegram:bot2", "whatsapp:main"];
  const AFTER = ["telegram:nouva", "telegram:bot2", "whatsapp:main"];

  function pack(id: string, text: string): void {
    mkdirSync(join(dataDir, "agents", id), { recursive: true });
    writeFileSync(join(dataDir, "agents", id, "config.toml"), text);
  }
  const loads = (text: string, gateways: string[]) =>
    parseAgentConfig("nouva", parseToml<RawAgentConfig>(text), { defaults: check.defaults, knownProviders: check.providers, knownGateways: gateways });

  test("a pack bound to it is reported, and its new text loads against the renamed gateways", async () => {
    pack("nouva", PACK);
    pack("nix", '[llm]\nprovider = "nougate"\n\n[channels]\n"telegram:bot2" = ["-1009999"]\n');
    // Not packs: boot never reads these as agents, and a rename must not either.
    pack("skills", '"telegram:bot" = 1\n');
    pack("shared", '"telegram:bot" = 1\n');

    const { packs, refusals } = await planPackRenames({ agentsDir: join(dataDir, "agents"), from: "telegram:bot", to: "telegram:nouva", gateways: { before: BEFORE, after: AFTER }, check });
    expect(refusals).toEqual([]);
    expect(packs.map((entry) => entry.id)).toEqual(["nouva"]);
    expect(packs[0]!.lines.map((line) => line.text)).toEqual([
      '"telegram:bot" = ["-1001234"]',
      'sender_allowlist = ["telegram:bot:5550001111", "whatsapp:main:628111000001@s.whatsapp.net"]',
    ]);

    // The old text is what boot refused after a config-only rename; the new one is what it loads.
    expect(() => loads(PACK, AFTER)).toThrow(/"telegram:bot" is not a configured gateway/);
    const after = loads(packs[0]!.after, AFTER);
    expect(after.channels).toEqual({ "telegram:nouva": ["-1001234"], "telegram:bot2": ["-1009999"] });
    expect(after.senderAllowlist).toEqual(["telegram:nouva:5550001111", "whatsapp:main:628111000001@s.whatsapp.net"]);
  });

  test("a pack that loads now and would not after is a refusal — before anything is written", async () => {
    pack("nouva", PACK);
    // A config whose rename leaves the gateway out — the pack's binding then has nowhere to go.
    const { refusals } = await planPackRenames({ agentsDir: join(dataDir, "agents"), from: "telegram:bot", to: "telegram:nouva", gateways: { before: BEFORE, after: ["telegram:bot2", "whatsapp:main"] }, check });
    expect(refusals).toEqual([expect.stringContaining('nouva would not load with the new name: agents/nouva/config.toml [channels] "telegram:nouva" is not a configured gateway')]);
    expect(await readTextFileIfExists(join(dataDir, "agents", "nouva", "config.toml"))).toBe(PACK);
  });

  test("a pack already broken is rewritten all the same — the rename cannot make it worse", async () => {
    const broken = PACK.replace('provider = "nougate"', 'provider = "typo"');
    pack("nouva", broken);
    const { packs, refusals } = await planPackRenames({ agentsDir: join(dataDir, "agents"), from: "telegram:bot", to: "telegram:nouva", gateways: { before: BEFORE, after: AFTER }, check });
    expect(refusals).toEqual([]);
    expect(packs[0]).toMatchObject({ id: "nouva", loads: false });
    expect(packs[0]!.after).toContain('"telegram:nouva" = ["-1001234"]');
  });
});

describe("the one place this repo builds SQL by interpolation", () => {
  /**
   * `rename.ts` has to interpolate: it walks every column `db/keys.ts` lists in one transaction,
   * and a bound parameter cannot name an identifier. Every value it uses comes from that registry,
   * so nothing attacker-supplied reaches it — and that is precisely the reassurance that stops
   * holding the first time somebody adds a caller.
   *
   * So the guard is on the interpolation rather than on the registry, and this is the assertion that
   * the guard exists. The registry becomes one way of satisfying it instead of the reason it is safe.
   */
  test("anything that is not a plain lowercase name is refused", () => {
    for (const attempt of [
      'sessions"; DROP TABLE sessions; --',
      "gateway = 1 OR 1=1",
      "sessions; DELETE FROM users",
      "Sessions",
      "sessions ",
      "",
      "1sessions",
    ]) {
      expect(() => identifier(attempt)).toThrow(/refusing to build SQL/);
    }
  });

  test("the real table and column names pass", () => {
    // A guard so strict that the thing it protects stops working is not a guard, it is an outage.
    for (const name of [
      "sessions",
      "turn_records",
      "cron_jobs",
      "target_gateway_id",
      "parent_session_id",
      "gateway",
    ]) {
      expect(identifier(name)).toBe(name);
    }
  });

  test("every name the rename actually uses satisfies it", () => {
    /**
     * The check that keeps the two in step. A column added to `db/keys.ts` with a capital letter or a
     * quote in it would pass review and throw at the moment somebody ran the rename — which is with
     * the daemon stopped, mid-migration, and is the worst possible time to find out.
     */
    for (const name of RENAMED_IDENTIFIERS) {
      expect(() => identifier(name)).not.toThrow();
    }
  });
});
