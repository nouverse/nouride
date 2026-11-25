/**
 * What strangers may cost an agent open to everyone: two numbers its admin gave, counted by the operator's own day.
 *
 * The agent's tokens in a day, whoever it answered, and one person's messages to it in a day. Past either, a
 * stranger's message begins nothing and they are told once that day; its admin is told once when the agent's day is
 * used. Both counts are in the database, so a restart resets neither, and the day is the operator's, not UTC's.
 * A person let in by name is held to neither. Through the real pipeline and the real usage store, since the count
 * that closes the agent is the one every model call writes.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { OpenDoorStore } from "@/modules/access/open-door.store.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { envelope as envelopeAt, FakeGateway, tempDir } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  setSystemTime();
  for (const dispose of cleanup) dispose();
  cleanup = [];
});

const OWNER = "owner-1";
const ENOUGH = (most: number) => `That is all for today: I can take ${most} ${most === 1 ? "message" : "messages"} a day from each person. Please write again tomorrow.`;
const CLOSED = "Nora has answered all it can for today. Please write again tomorrow.";

/** Nora is open, with these limits, on her own bot. Each answer of the scripted model is metered as 15 tokens: 10 in, 5 out. */
async function install(limits: { tokens?: number; messages?: number; closedReply?: string; noCount?: boolean; installTokens?: number; nouvaBot?: boolean }) {
  // A bot for each start of the daemon: the one before it is no longer listened to.
  const bots = [new FakeGateway("telegram:nora", "telegram")];
  // The orchestrator's own bot, where a test wants an ordinary agent beside the open one.
  const nouvas = new FakeGateway("telegram:nouva", "telegram");
  const alerts: { key: string; text: string }[] = [];
  const open = `[open]\nmax_daily_tokens = ${limits.tokens ?? 1_000_000}\nmax_daily_messages_per_person = ${limits.messages ?? 100}\n${limits.closedReply ? `closed_reply = "${limits.closedReply}"\n` : ""}`;
  const deps = ({ db }: { db: SqliteDb }) => ({
    usage: new UsageStore(db),
    notifier: { alert: async (key: string, text: string) => (alerts.push({ key, text }), true), toChat: async () => {} } as never,
    ...(limits.noCount ? { openDoor: undefined } : {}),
  });
  const bench = await pipelineBench({
    turns: [{ text: "we open at nine" }],
    agents: [
      { id: "nouva", configToml: '[agent]\ndisplay_name = "Nouva"\n\n[llm]\nprovider = "test"\n' },
      { id: "nora", configToml: `[agent]\ndisplay_name = "Nora"\naccess = "open"\n\n${open}\n[llm]\nprovider = "test"\n` },
    ],
    config: {
      daemon: { orchestrator: "nouva", timezone: "Asia/Jakarta" },
      security: { access: { mode: "pair", allowlist: [OWNER] } },
      gateways: { telegram: { nora: { enabled: true, token: "t-nora", agent: "nora" }, ...(limits.nouvaBot ? { nouva: { enabled: true, token: "t-nouva", agent: "nouva" } } : {}) } },
      // The install's own cap on a day, every agent's use together.
      ...(limits.installTokens ? { llm: { defaults: { provider: "test", model: "test-model" }, limits: { max_daily_tokens: limits.installTokens } } } : {}),
    },
    ...(limits.nouvaBot ? { gateways: [bots[0]!, nouvas] } : { gateway: bots[0]! }),
    deps,
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  let sent = 0;
  const rig = {
    alerts,
    nouvas,
    bench,
    /** The model's requests since the last start. */
    requests: () => rig.bench.requests.length,
    /** Everything said, across every start. */
    said: () => bots.flatMap((bot) => bot.sent.map((message) => message.text)),
    async write(senderId: string, text = "when do you open?") {
      bots.at(-1)!.receive(envelopeAt({ id: `m-${++sent}`, timestamp: Date.now(), gatewayId: "telegram:nora", chatId: `dm-${senderId}`, senderId, senderName: senderId, text }));
      await rig.bench.pipeline.idle();
    },
    /** The daemon stopped and started on the same data. */
    async restart() {
      bots.push(new FakeGateway("telegram:nora", "telegram"));
      rig.bench = await rig.bench.reboot({ turns: [{ text: "we open at nine" }], gateway: bots.at(-1)!, deps });
      rig.bench.pipeline.setTools(new Map());
      rig.bench.pipeline.attach();
    },
  };
  return rig;
}

describe("one person's messages in a day", () => {
  test("past the number they are told once and then left unanswered; nobody else is held by their count", async () => {
    const h = await install({ messages: 2 });
    await h.write("ana");
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said() }).toEqual({ requests: 2, said: ["we open at nine", "we open at nine"] });
    await h.write("ana");
    await h.write("ana");
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said().slice(2) }).toEqual({ requests: 2, said: [ENOUGH(2)] });
    await h.write("budi");
    expect({ requests: h.requests(), said: h.said().at(-1) }).toEqual({ requests: 3, said: "we open at nine" });
    expect(h.alerts).toEqual([]);
  });

  test("a command that reaches no model is not one of them, and a person let in by name is held to no number", async () => {
    const h = await install({ messages: 1 });
    await h.write("ana", "/help");
    await h.write("ana", "/help");
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said().at(-1) }).toEqual({ requests: 1, said: "we open at nine" });
    for (let i = 0; i < 3; i++) await h.write(OWNER);
    expect(h.requests()).toBe(4);
    expect(h.said()).not.toContain(ENOUGH(1));
  });

  test("a restart resets nothing: the count is in the database", async () => {
    const h = await install({ messages: 2 });
    await h.write("ana");
    await h.write("ana");
    await h.restart();
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said().at(-1) }).toEqual({ requests: 0, said: ENOUGH(2) });
    // And that they were told is kept too: not said again after another restart.
    await h.restart();
    await h.write("ana");
    expect(h.said().filter((text) => text === ENOUGH(2))).toHaveLength(1);
  });

  test("the day is the operator's own: a new one begins at their midnight, not at UTC's", async () => {
    // 23:30 in Jakarta, the same UTC day as 00:10 the next morning there.
    setSystemTime(new Date("2026-09-25T16:30:00Z"));
    const h = await install({ messages: 1 });
    await h.write("ana");
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said().at(-1) }).toEqual({ requests: 1, said: ENOUGH(1) });
    setSystemTime(new Date("2026-09-25T17:10:00Z"));
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said().at(-1) }).toEqual({ requests: 2, said: "we open at nine" });
  });
});

describe("the agent's tokens in a day", () => {
  test("once they are used it is closed to strangers: each is told once, its admin once, and nothing more is spent", async () => {
    // Two answers use 30 of 20: the second began under the number, and the third message finds the day used.
    const h = await install({ tokens: 20 });
    await h.write("ana");
    await h.write("budi");
    expect(h.requests()).toBe(2);
    await h.write("ana");
    await h.write("ana");
    await h.write("cici");
    await h.write("cici");
    expect({ requests: h.requests(), said: h.said().slice(2) }).toEqual({ requests: 2, said: [CLOSED, CLOSED] });
    expect(h.alerts).toEqual([
      {
        key: "open_agent_closed:nora",
        text: "Nora has used the 20 tokens it may use in a day, and answers nobody from the public until tomorrow. Its daily limit is on its page in the dashboard, under Access.",
      },
    ]);
  });

  test("said in its admin's own sentence where they wrote one, and a person let in by name is still answered", async () => {
    const h = await install({ tokens: 10, closedReply: "Toko tutup dulu ya, besok buka lagi." });
    await h.write("ana");
    await h.write("ana");
    expect(h.said().at(-1)).toBe("Toko tutup dulu ya, besok buka lagi.");
    await h.write(OWNER);
    expect({ requests: h.requests(), said: h.said().at(-1) }).toEqual({ requests: 2, said: "we open at nine" });
  });

  test("they are its own: what another agent used that day closes nothing of this one", async () => {
    const h = await install({ tokens: 20 });
    new UsageStore(h.bench.db).record({ agentId: "nouva", model: "m", provider: "p", inputTokens: 90_000, outputTokens: 10_000 });
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said() }).toEqual({ requests: 1, said: ["we open at nine"] });
  });

  test("a process that keeps no count answers a stranger nothing, and a person let in by name as ever", async () => {
    const h = await install({ noCount: true });
    await h.write("ana");
    expect({ requests: h.requests(), said: h.said() }).toEqual({ requests: 0, said: [] });
    await h.write(OWNER);
    expect({ requests: h.requests(), said: h.said() }).toEqual({ requests: 1, said: ["we open at nine"] });
  });

  test("a restart resets nothing, and the next day of the operator's opens it again", async () => {
    setSystemTime(new Date("2026-09-25T16:30:00Z"));
    const h = await install({ tokens: 10 });
    await h.write("ana");
    await h.restart();
    await h.write("budi");
    expect({ requests: h.requests(), said: h.said().at(-1), alerts: h.alerts.length }).toEqual({ requests: 0, said: CLOSED, alerts: 1 });
    await h.restart();
    await h.write("cici");
    // Its admin was told once that day, across the restart too.
    expect(h.alerts).toHaveLength(1);
    setSystemTime(new Date("2026-09-25T17:10:00Z"));
    await h.write("budi");
    expect({ requests: h.requests(), said: h.said().at(-1) }).toEqual({ requests: 1, said: "we open at nine" });
  });
});

describe("the install's own cap on a day, reached", () => {
  test("whoever writes to the open agent is told its own sentence: not the cap, what was spent, or the setting that raises it", async () => {
    // Read by a second reader of the branch: a stranger was told "Today's usage has reached the 20 token cap: 30 so
    // far across 2 request(s). Raise max_daily_tokens…", which is the install's own business in the install's words.
    const h = await install({ installTokens: 20, nouvaBot: true, closedReply: "The shop's desk is closed for today." });
    await h.write("stranger-1");
    await h.write("stranger-2");
    expect(h.requests()).toBe(2);
    // Thirty tokens against a cap of twenty: nobody's turn begins.
    await h.write("stranger-3");
    expect(h.requests()).toBe(2);
    expect(h.said().at(-1)).toBe("The shop's desk is closed for today.");
    for (const ofTheInstall of ["cap", "max_daily_tokens", "request(s)", "30", "20"]) expect(h.said().at(-1)).not.toContain(ofTheInstall);

    // The admin is told the figures, and an ordinary agent's own chat is told them as ever.
    expect(h.alerts.map((alert) => alert.key)).toContain("cost_cap");
    expect(h.alerts.find((alert) => alert.key === "cost_cap")?.text).toContain("has reached the 20 token cap");
    h.nouvas.receive(envelopeAt({ id: "o-1", timestamp: Date.now(), gatewayId: "telegram:nouva", chatId: `dm-${OWNER}`, senderId: OWNER, senderName: "Gading", text: "are you there?" }));
    await h.bench.pipeline.idle();
    expect(h.nouvas.sent.at(-1)?.text).toContain("Today's usage has reached the 20 token cap");
  });

  test("with no sentence of its admin's, the daemon's own for a day that is used", async () => {
    const h = await install({ installTokens: 10 });
    await h.write("stranger-1");
    await h.write("stranger-2");
    expect(h.said().at(-1)).toBe(CLOSED);
  });
});

describe("the count itself", () => {
  const DAY = Date.parse("2026-09-25T00:00:00+07:00");
  const limits = { maxDailyTokens: 100, maxDailyMessagesPerPerson: 2 };
  const from = (senderId: string, over: { day?: number; tokensToday?: number } = {}) => ({ agentId: "nora", gatewayId: "telegram:nora", senderId, day: DAY, tokensToday: 0, limits, ...over });

  async function store() {
    const dir = tempDir("open-door");
    const db = await openAndMigrate(join(dir, "test.db"));
    cleanup.push(() => (db.close(), removePath(dir)));
    return { db, door: new OpenDoorStore(db) };
  }

  test("tokens the daemon counted itself, for a provider that reported none, close the agent as reported ones do", async () => {
    const { db, door } = await store();
    const usage = new UsageStore(db, () => DAY + 60_000);
    usage.record({ agentId: "nora", model: "m", provider: "p", inputTokens: 80, outputTokens: 30, estimated: true });
    const used = usage.since(DAY, "nora");
    expect({ tokens: used.inputTokens + used.outputTokens, estimated: used.estimatedRequests }).toEqual({ tokens: 110, estimated: 1 });
    expect(door.take(from("ana", { tokensToday: used.inputTokens + used.outputTokens }))).toEqual({ action: "closed", say: true, first: true });
    // Another agent's tokens are not this one's.
    expect(usage.since(DAY, "nouva").inputTokens).toBe(0);
  });

  test("at the number is past it, for both; and who wrote today is counted by person", async () => {
    const { door } = await store();
    expect(door.take(from("ana", { tokensToday: 99 }))).toEqual({ action: "answer" });
    expect(door.take(from("ana", { tokensToday: 100 }))).toEqual({ action: "closed", say: true, first: true });
    expect(door.take(from("ana", { tokensToday: 100 }))).toEqual({ action: "closed", say: false, first: false });
    expect(door.take(from("budi", { tokensToday: 100 }))).toEqual({ action: "closed", say: true, first: false });
    // Reopened by a higher number, the same day: they go on, and past their own messages they are told that once.
    expect(door.take(from("ana"))).toEqual({ action: "answer" });
    expect(door.take(from("ana"))).toEqual({ action: "enough", say: true });
    expect(door.take(from("ana"))).toEqual({ action: "enough", say: false });
    expect(door.today("nora", DAY)).toEqual({ people: 2, messages: 2 });
    expect(door.today("nouva", DAY)).toEqual({ people: 0, messages: 0 });
  });

  test("the same sender on another connection, or writing to another agent, has their own count", async () => {
    const { door } = await store();
    door.take(from("ana"));
    door.take(from("ana"));
    expect(door.take(from("ana"))).toMatchObject({ action: "enough" });
    expect(door.take({ ...from("ana"), gatewayId: "whatsapp:nora" })).toEqual({ action: "answer" });
    expect(door.take({ ...from("ana"), agentId: "nia" })).toEqual({ action: "answer" });
  });

  test("days past a week are taken out as a new one begins, so the table has a ceiling", async () => {
    const { db, door } = await store();
    const day = (n: number) => DAY + n * 24 * 60 * 60_000;
    for (let n = 0; n < 10; n++) door.take(from("ana", { day: day(n) }));
    const kept = db.prepare<{ day: number }>("SELECT DISTINCT day FROM open_door ORDER BY day").all().map((row) => row.day);
    expect(kept).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map(day));
  });
});
