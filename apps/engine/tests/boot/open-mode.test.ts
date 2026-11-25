/**
 * An install that held `[security.access] mode = "open"`, everyone let in on every connection, brought forward at
 * the first start of this build (`boot/open-mode.ts`).
 *
 * `open` is one agent's now. An install's own is not read as that: it becomes `pair`, and everyone an agent here had
 * already answered is let in by name on the connection they wrote on, so they go on talking and only a new sender
 * meets a pairing code. Each case is a `config.toml` and a database as an older install left them, loaded as the
 * daemon loads them and asked at the door as a message is.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { bringOpenModeForward, holdsOpenMode, OPEN_MODE_NOTE } from "@/boot/open-mode.ts";
import { openAndMigrate } from "@/db/index.ts";
import { AccessStore } from "@/modules/access/access.store.ts";
import { OpenModeStore } from "@/modules/access/open-mode.store.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { tempDir } from "../temp-dirs.ts";

const said: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "config.access" && said.push(entry)));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  said.length = 0;
});

const OPEN = `# the family's box
[security.access]
mode = "open"            # anyone can talk to it
allowlist = ["9001"]

[gateways.telegram.nouva]
enabled = true
token = "telegram_nouva"
agent = "nouva"

[gateways.whatsapp.main]
enabled = true
`;

/** An install's file and database as an older build left them, and its door as the daemon asks it. */
async function install(text: string) {
  const dir = tempDir("open-mode");
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, text);
  const db: SqliteDb = await openAndMigrate(join(dir, "nouride.db"));
  cleanup.push(() => (db.close(), removePath(dir)));
  const config = readConfigText(text, configPath);
  const access = new AccessStore({ db, ...config.security.access });
  const turns = new EventedTurnStore(db, new EventStore(db));
  let n = 0;
  return {
    configPath,
    config,
    db,
    access,
    file: () => readFileSync(configPath, "utf8"),
    /** A message of theirs an agent answered: a turn the install's records hold. */
    answered(gatewayId: string, senderId: string, chatId = `dm-${senderId}`) {
      return turns.note({ sessionId: `ses_nouva:${gatewayId}:${chatId}`, agentId: "nouva", gatewayId, chatId, messageId: `m-${++n}`, senderId, prompt: "hello", reply: "hi" });
    },
    forward: () => bringOpenModeForward({ configPath, config, source: readFileSync(configPath, "utf8"), senders: new OpenModeStore(db), access }),
    /** Whether a message from them is let in now, as the door asks: by the mode the running config holds. */
    door: (gatewayId: string, senderId: string) => access.check({ gatewayId, senderId, chatId: `dm-${senderId}`, mode: config.security.access.mode, staticAllowlist: config.security.access.allowlist }).action,
  };
}

describe("a file that says the whole install is open", () => {
  test("is read as pair by the daemon that loads it, before anything is written", async () => {
    const at = await install(OPEN);
    expect(holdsOpenMode(OPEN)).toBe(true);
    expect(at.config.security.access).toMatchObject({ mode: "pair", allowlist: ["9001"] });
    // What `config check` says of it before a start does it.
    expect(OPEN_MODE_NOTE.message).toBe('[security.access] mode = "open" is no longer taken: the next start writes mode = "pair", and lets in by name everyone an agent here has already answered');
    expect(OPEN_MODE_NOTE.hint).toContain("open that agent to everyone on its Access page");
    for (const other of ['[security.access]\nmode = "pair"\n', '[security.access]\nmode = "allowlist"\n', "", "[security]\n", 'mode = "open"\n', "not = [toml"]) expect(holdsOpenMode(other)).toBe(false);
  });

  test("everyone an agent had answered goes on talking, on the connection they wrote on; a new sender is asked to pair; the file says pair, the rest of it as it was", async () => {
    const at = await install(OPEN);
    at.answered("telegram:nouva", "111");
    at.answered("telegram:nouva", "111");
    at.answered("whatsapp:main", "62811@s.whatsapp.net");
    // One whose conversation aged out: the install's records no longer hold a turn of theirs.
    at.db.prepare("DELETE FROM turn_records WHERE id = ?").run(at.answered("telegram:nouva", "333"));

    expect(await at.forward()).toEqual({ letIn: 2, already: 0 });

    expect(at.file()).toBe(OPEN.replace('mode = "open"            # anyone can talk to it', 'mode = "pair"            # anyone can talk to it'));
    expect({ a: at.door("telegram:nouva", "111"), b: at.door("whatsapp:main", "62811@s.whatsapp.net") }).toEqual({ a: "allow", b: "allow" });
    // Let in where they wrote, not on every connection: the same id on another app is somebody else.
    expect(at.door("whatsapp:main", "111")).toBe("pair");
    expect({ agedOut: at.door("telegram:nouva", "333"), stranger: at.door("telegram:nouva", "444") }).toEqual({ agedOut: "pair", stranger: "pair" });
    // The list in the file holds as it did.
    expect(at.door("telegram:nouva", "9001")).toBe("allow");
    expect(said.map((entry) => [entry.level, entry.message, entry.data?.let_in])).toEqual([
      ["info", '[security.access] mode was "open", which is one agent\'s now: written as "pair", and everyone an agent here had answered let in by name', 2],
    ]);
  });

  test("run again, it does nothing: the file no longer says open, and nobody is let in twice", async () => {
    const at = await install(OPEN);
    at.answered("telegram:nouva", "111");
    await at.forward();
    const once = at.file();
    said.length = 0;
    expect(await at.forward()).toBeNull();
    expect({ file: at.file(), said }).toEqual({ file: once, said: [] });
    // Stopped after the senders and before the file, the next start does both again, to the same end.
    writeFileSync(at.configPath, OPEN);
    expect(await at.forward()).toEqual({ letIn: 0, already: 1 });
    expect(at.file()).toBe(once);
    expect(at.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sender_access WHERE status = 'approved'").get()?.n).toBe(1);
  });

  test("a block is kept, and what was no person's message lets nobody in", async () => {
    const at = await install(OPEN);
    at.answered("telegram:nouva", "111");
    at.answered("telegram:nouva", "666");
    at.access.block("telegram:nouva", "666", "admin");
    // The daemon's own events, the dashboard's signed-in accounts, and a connection since removed.
    at.answered("telegram:nouva", "nouride:system");
    at.answered("web:dashboard", "web:7");
    at.answered("discord:old", "222");
    expect(await at.forward()).toEqual({ letIn: 1, already: 0 });
    expect(at.door("telegram:nouva", "666")).toBe("ignore");
    expect(at.db.prepare<{ sender: string }>("SELECT gateway_id || ' ' || sender_id AS sender FROM sender_access WHERE status = 'approved'").all().map((row) => row.sender)).toEqual(["telegram:nouva 111"]);
  });
});

describe("a file that never said it", () => {
  test("is left alone, and nobody is let in", async () => {
    const pair = OPEN.replace('mode = "open"', 'mode = "pair"');
    const at = await install(pair);
    at.answered("telegram:nouva", "111");
    expect(await at.forward()).toBeNull();
    expect({ file: at.file(), door: at.door("telegram:nouva", "111"), said }).toEqual({ file: pair, door: "pair", said: [] });
  });
});
