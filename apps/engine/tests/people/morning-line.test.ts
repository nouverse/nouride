/**
 * The morning line (0.8.0): at the time a person set, once a day, what happened while they were away — theirs, or all
 * of it for an admin, who also hears what was spent. A quiet morning sends nothing; a restart says nothing twice; a
 * line due while the daemon was down comes within the hour, or not that day.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openAndMigrate } from "@/db/index.ts";
import { addLogSink, type ApprovalRequest, type Person } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { MissionStore } from "@/modules/missions/missions.store.ts";
import { newMission } from "@/modules/missions/start.ts";
import { MorningLines, morningText, type MorningFacts } from "@/modules/people/morning-line.ts";
import { morningFacts, morningRoute } from "@/boot/morning-lines.ts";
import { tempDir, turnStore } from "../helpers.ts";

const logged: string[] = [];
addLogSink((entry) => void (entry.component === "people.morning" && logged.push(entry.message)));

const QUIET: MorningFacts = { failed: [], approvals: [], needsYou: [], ended: [] };
const MIRA: Person = { key: "mira", name: "Mira", ids: ["telegram:555", "web:usr_mira"], morning: "07:00" };

describe("what it says", () => {
  test("a quiet morning says nothing — spending alone is not news", () => {
    expect(morningText(QUIET)).toBeNull();
    expect(morningText({ ...QUIET, spent: { usd: 1.2, tokens: 900, top: [] } })).toBeNull();
  });

  test("a heading a kind, with its count; what needs them first; one item a line", () => {
    const text = morningText({
      failed: [{ job: "Customer mail", why: "the provider was down" }],
      approvals: [{ agent: "nox", what: "exec" }, { agent: "nouva", what: "send_message" }],
      needsYou: [{ goal: "Pick a disk for the backups. Then copy them over.", what: "Which disk?" }],
      ended: [
        { goal: "Sum up the mail", status: "done" },
        { goal: "Fix the build", status: "failed", why: "gave up: no network" },
        { goal: "Tidy the logs", status: "stopped" },
      ],
      spent: { usd: 1.2, tokens: 900, top: [{ agent: "nouva", model: "big-1", usd: 0.8, tokens: 600 }] },
    })!;
    expect(text.split("\n")).toEqual([
      "☀ **Since yesterday morning**",
      "",
      "**Needs you · 3**",
      "• nox asks to run exec",
      "• nouva asks to run send_message",
      "• Pick a disk for the backups. (Which disk?)",
      "",
      "**Scheduled runs failed · 1**",
      "• Customer mail (the provider was down)",
      "",
      "**Missions done · 1**",
      "• Sum up the mail",
      "",
      "**Missions stopped or failed · 2**",
      "• Fix the build (gave up: no network)",
      "• Tidy the logs (stopped)",
      "",
      "**Spent in the last day · $1.20**",
      "• nouva on big-1: $0.80",
    ]);
  });

  test("a mission is its goal's first sentence cut at a word, without code marks; past four, the rest are counted", () => {
    const goal = "Run `sleep 45 && echo slept > slept.txt` in your mission folder as a background job, then tell me.";
    const text = morningText({ ...QUIET, ended: Array.from({ length: 6 }, () => ({ goal, status: "done" as const })) })!;
    const items = text.split("\n").filter((line) => line.startsWith("• "));
    expect(items).toHaveLength(5);
    expect(items[0]).toBe("• Run sleep 45 && echo slept > slept.txt in your mission folder as a…");
    expect(items[4]).toBe("• and 2 more");
    expect(text).not.toContain("`");
  });

  test("a day not every request of which had a price is said in tokens, short", () => {
    const text = morningText({
      ...QUIET,
      failed: [{ job: "Backup", why: "exit 1" }],
      spent: { usd: null, tokens: 28_265_819, top: [{ agent: "nouva", model: "flash-3", usd: 0, tokens: 17_857_169 }] },
    })!;
    expect(text).toContain("**Spent in the last day · 28.27M tokens**\n• nouva on flash-3: 17.86M tokens");
  });
});

describe("when it comes", () => {
  // 2026-10-26 in Jakarta (UTC+7): 07:00 there is 00:00 UTC.
  const at = (hhmm: string) => Date.parse(`2026-10-26T${hhmm}:00+07:00`);

  function lines(o: { people?: Person[]; facts?: MorningFacts; send?: boolean } = {}) {
    let now = at("06:59");
    let said: Record<string, string> = {};
    const sent: { key: string; text: string }[] = [];
    const morning = new MorningLines({
      people: () => o.people ?? [MIRA],
      timezone: () => "Asia/Jakarta",
      isAdmin: () => false,
      facts: () => o.facts ?? { ...QUIET, failed: [{ job: "Backup", why: "exit 1" }] },
      send: async (person, text) => (sent.push({ key: person.key, text }), o.send ?? true),
      said: { load: () => ({ ...said }), save: (next) => void (said = next) },
      now: () => now,
    });
    return { morning, sent, set: (hhmm: string) => void (now = at(hhmm)), said: () => said };
  }

  test("at their time, once a day — not before, and not again after a restart; the log says it went", async () => {
    logged.splice(0);
    const l = lines();
    expect(await l.morning.tick()).toEqual([]);
    l.set("07:00");
    expect(await l.morning.tick()).toEqual(["mira"]);
    l.set("07:01");
    expect(await l.morning.tick()).toEqual([]);
    expect(l.sent).toHaveLength(1);
    expect(l.said()).toEqual({ mira: "2026-10-26" });
    expect(logged).toEqual(["a morning line sent"]);
  });

  test("within the hour after its time after a restart; later than that, not that day", async () => {
    const late = lines();
    late.set("07:45");
    expect(await late.morning.tick()).toEqual(["mira"]);
    const missed = lines();
    missed.set("09:30");
    expect(await missed.morning.tick()).toEqual([]);
    expect(missed.said()).toEqual({ mira: "2026-10-26" });
  });

  test("a quiet morning sends nothing; somebody with no time set gets none", async () => {
    const quiet = lines({ facts: QUIET });
    quiet.set("07:05");
    expect(await quiet.morning.tick()).toEqual([]);
    const none = lines({ people: [{ ...MIRA, morning: undefined }] as Person[] });
    none.set("07:05");
    expect(await none.morning.tick()).toEqual([]);
    expect(none.sent).toEqual([]);
  });
});

describe("whose news it is", () => {
  const dirs: string[] = [];
  afterEach(() => void dirs.splice(0));

  async function sources() {
    const db = await openAndMigrate(join(tempDir("morning"), "nouride.db"));
    const cron = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "UTC" });
    const missions = new MissionStore(db);
    const job = (name: string, chatId: string, turnedOnBy?: string) => {
      const created = cron.create({ agentId: "nouva", name, trigger: { kind: "every", everyMs: 3_600_000 }, payload: { kind: "systemEvent", text: "x" }, target: { gatewayId: "telegram:nouva", chatId }, createdBy: "cli" });
      if (turnedOnBy) cron.settleProposal(created.id, turnedOnBy);
      const run = cron.startRun(created.id);
      cron.finishRun(run.id, { status: "error", result: `${name} broke` });
      return created;
    };
    job("Mira's report", "555");
    job("Turned on by Mira", "-100team", "555");
    job("Someone else's", "777");
    // A run of several steps that waits for a person's yes, in Mira's chat and in somebody else's.
    const asks = (name: string, chatId: string, question: string) => {
      const created = cron.create({ agentId: "nouva", name, trigger: { kind: "manual" }, payload: { kind: "steps", steps: [{ id: "ok", kind: "approval", ask: question }] }, target: { gatewayId: "telegram:nouva", chatId }, createdBy: "cli" });
      const run = cron.startRun(created.id);
      cron.parkRun(run.id, { at: "ok", wait: { kind: "approval", step: "ok", since: 1, until: 2, ask: question }, settles: true }, []);
    };
    asks("Mira's deploy", "555", "Deploy now?");
    asks("Someone else's deploy", "777", "Ship it?");
    const mission = (goal: string, startedBy: string, status: "waiting" | "done", reason: string | null = null) => {
      const one = newMission({ agentId: "nouva", goal, startedBy, gatewayId: "telegram:nouva", chatId: startedBy }, { id: MissionStore.newId(), settings: DEFAULT_CONFIG.missions as never, privateDir: "/p", now: Date.now() });
      missions.save({ ...one, status, reason, waitKind: status === "waiting" ? "input" : null, endedAt: status === "done" ? Date.now() - 1000 : null });
    };
    mission("Mira's question", "555", "waiting", "Which disk?");
    mission("Mira's done work", "555", "done");
    mission("Someone else's work", "777", "done");
    const approvals: ApprovalRequest[] = [
      { id: "apr_1", agentId: "nox", gateway: "telegram", chatId: "555", tool: "exec", status: "pending" } as ApprovalRequest,
      { id: "apr_2", agentId: "nox", gateway: "telegram", chatId: "777", tool: "write", status: "pending" } as ApprovalRequest,
    ];
    return morningFacts({
      cron,
      missions,
      approvals: () => ({ pending: () => approvals }),
      usage: { since: () => ({ usd: 2.5, inputTokens: 100, outputTokens: 50, unpricedRequests: 0 }) as never, spenders: () => [{ agentId: "nouva", model: "big-1", usd: 2.5, tokens: 150 }] },
    });
  }

  test("a person hears about their own chats, the jobs they turned on and their missions — nothing of the box's spend", async () => {
    const facts = (await sources())(MIRA, 0, false);
    expect(facts.failed.map((one) => one.job).sort()).toEqual(["Mira's report", "Turned on by Mira"]);
    expect(facts.approvals).toEqual([{ agent: "nox", what: "exec" }]);
    expect(facts.needsYou).toEqual([{ goal: "Mira's question", what: "Which disk?" }, { goal: "Mira's deploy", what: "Deploy now?" }]);
    expect(facts.ended.map((one) => one.goal)).toEqual(["Mira's done work"]);
    expect(facts.spent).toBeUndefined();
  });

  test("an admin hears all of it, and what was spent", async () => {
    const facts = (await sources())(MIRA, 0, true);
    expect(facts.failed).toHaveLength(3);
    expect(facts.approvals).toHaveLength(2);
    expect(facts.needsYou.map((one) => one.goal).sort()).toEqual(["Mira's deploy", "Mira's question", "Someone else's deploy"]);
    expect(facts.ended).toHaveLength(2);
    expect(facts.spent).toEqual({ usd: 2.5, tokens: 150, top: [{ agent: "nouva", model: "big-1", usd: 2.5, tokens: 150 }] });
  });

  test("a day said in tokens names its biggest spenders by tokens — the store orders by dollars", () => {
    const facts = morningFacts({
      cron: { recentRuns: () => [], get: () => null, waitingRuns: () => [] },
      missions: undefined,
      approvals: () => ({ pending: () => [] }),
      usage: {
        since: () => ({ usd: 3, inputTokens: 26_000_000, outputTokens: 1_000_000, unpricedRequests: 4 }) as never,
        spenders: () => [
          { agentId: "nestor", model: "opus", usd: 3, tokens: 8_000_000 },
          { agentId: "nox", model: "small", usd: 0.01, tokens: 300_000 },
          { agentId: "nouva", model: "flash", usd: 0, tokens: 17_000_000 },
          { agentId: "nix", model: "local", usd: 0, tokens: 1_700_000 },
        ],
      },
    })(MIRA, 0, true);
    expect(facts.spent?.usd).toBeNull();
    expect(facts.spent?.top.map((one) => one.agent)).toEqual(["nouva", "nestor", "nix"]);
  });
});

describe("where it goes (0.8.0)", () => {
  // Discord first in their list: before, that is where the line went, whichever they read.
  const GADING: Person = { key: "gading", name: "Gading", ids: ["discord:214", "telegram:555", "web:usr_1", "whatsapp:628@s.whatsapp.net"] };
  const route = (person: Person, lastFrom: { gatewayId: string; senderId: string }[] = []) => morningRoute(person, lastFrom).map((one) => `${one.platform}:${one.account}`);

  test("the account they picked first; then the one they last wrote from; then the rest — never the dashboard", () => {
    expect(route({ ...GADING, morningTo: "whatsapp:628@s.whatsapp.net" }, [{ gatewayId: "telegram:nouva", senderId: "555" }])).toEqual([
      "whatsapp:628@s.whatsapp.net",
      "telegram:555",
      "discord:214",
    ]);
    expect(route(GADING, [{ gatewayId: "telegram:nouva", senderId: "555" }])).toEqual(["telegram:555", "discord:214", "whatsapp:628@s.whatsapp.net"]);
    // Written from somewhere that is not theirs on that platform — the same number on Discord is somebody else.
    expect(route(GADING, [{ gatewayId: "discord:nix", senderId: "555" }])).toEqual(["discord:214", "telegram:555", "whatsapp:628@s.whatsapp.net"]);
  });

  test("the account they last wrote from, newest first, read from the turns", async () => {
    const db = await openAndMigrate(join(tempDir("morning-route"), "nouride.db"));
    const turns = turnStore(db);
    // Written at the times given, so which came last does not hang on the clock moving between two calls.
    const begin = (gatewayId: string, senderId: string, at: number) =>
      db.prepare("UPDATE turn_records SET started_at = ? WHERE id = ?").run(at, turns.begin({ sessionId: `ses_${senderId}`, agentId: "nouva", gatewayId, chatId: senderId, prompt: "hi", senderId }));
    begin("telegram:nouva", "555", 2_000);
    begin("discord:nouva", "214", 1_000);
    expect(turns.lastFrom(["214", "555"])[0]).toEqual({ gatewayId: "telegram:nouva", senderId: "555" });
    expect(route(GADING, turns.lastFrom(["214", "555"]))[0]).toBe("telegram:555");
    expect(turns.lastFrom([])).toEqual([]);
  });
});
