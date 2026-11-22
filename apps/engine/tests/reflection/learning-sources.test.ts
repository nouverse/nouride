/**
 * What skill learning looks at, on which model, how often, and what it leaves for a person to read: a mission that
 * ended done, a kind of work a person asks to have written now, the skills a conversation read, the small model for
 * the deciding call, the widening gap after looks that gave nothing, and the reason kept when nothing was written.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ChatMessage } from "@nouride/shared";
import { skillsDirFor, writeNewSkill } from "@nouride/persona";
import { Cooldowns } from "@/modules/reflection/cooldown.ts";
import { TUNING } from "@/modules/reflection/tuning.ts";
import { createAnswer, learning, recovered, removeTempDirs, skipAnswer, tempDir, updateAnswer, worked } from "./harness.ts";

afterEach(removeTempDirs);

const mission = (id: string, extra: Record<string, string> = {}) => ({
  agentId: "nouva",
  gatewayId: "telegram:nouva",
  chatId: "8142",
  sessionId: `ses_nouva:mission:${id}`,
  title: "Move the site to the new host",
  goal: "Move the site to the new host and keep the old one answering until DNS has moved.",
  report: "Moved. The old host answers a redirect; the certificate was issued again on the new one.",
  ...extra,
});

describe("a mission that ended done is looked at once", () => {
  test("the pass reads its goal, its own last turn and its report", async () => {
    const kept: ChatMessage[] = [{ role: "assistant", content: "rsync finished, switching the proxy", timestamp: 1 }];
    const h = learning({ triage: skipAnswer(), conversations: { "ses_nouva:mission:m1": kept } });
    await h.engine.observeMission(mission("m1"));
    expect(h.calls()).toEqual({ triage: 1, written: 0 });
    const prompt = h.asked[0]!.prompt;
    expect(prompt).toContain("Why this turn was flagged: a mission ended done: Move the site to the new host.");
    expect(prompt).toContain("user: Mission: Move the site to the new host and keep the old one answering");
    expect(prompt).toContain("assistant: rsync finished, switching the proxy");
    expect(prompt).toContain("The mission's report, as it ended done:\n\nMoved. The old host answers a redirect");
  });

  test("a new kind of work waits for a second mission of the kind, and its draft is announced where the mission reports", async () => {
    const h = learning();
    await h.engine.observeMission(mission("m1"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.candidates.list().map((held) => held.name)).toEqual(["restart-stuck-ingress"]);
    await h.engine.observeMission(mission("m2"));
    const [draft] = h.drafts.pending();
    expect(draft).toMatchObject({ triggerKind: "mission", gatewayId: "telegram:nouva", chatId: "8142", sessionId: "ses_nouva:mission:m2" });
    expect(h.candidates.list()).toEqual([]);
  });

  test("a lesson for a skill that exists lands from the first mission", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "site-moving", description: "Use when moving a site.", body: "1. Copy the files.", author: "nouva" });
    const h = learning({ agentsDir, triage: updateAnswer("site-moving"), written: JSON.stringify({ description: "Use when moving a site.", edits: [{ old: "1. Copy the files.", new: "1. Copy the files.\n2. Issue the certificate again." }] }) });
    await h.engine.observeMission(mission("m1"));
    expect(h.drafts.pending().map((draft) => [draft.target, draft.triggerKind])).toEqual([["site-moving", "mission"]]);
  });

  test("with learning off nothing is asked", async () => {
    const h = learning({ mode: "off" });
    await h.engine.observeMission(mission("m1"));
    expect(h.calls().triage).toBe(0);
  });

  // A chat's turn is dropped while another reflection of its agent is in flight; a mission's end has no next turn.
  test("it waits for a reflection of its agent already in flight, where a chat's turn would be dropped", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    const h = learning({ triage: skipAnswer(), triageWaits: async () => void ((held += 1) === 1 && (await gate)) });
    const first = h.engine.observe(recovered("ses_chat"));
    const dropped = h.engine.observe(recovered("ses_other"));
    const ended = h.engine.observeMission(mission("m1"));
    release();
    await Promise.all([first, dropped, ended]);
    expect(h.calls().triage).toBe(2);
    expect(h.asked[1]!.prompt).toContain("a mission ended done");
  });
});

describe("a kind of work seen once, as a person reads it", () => {
  const seenIn = (session: string): Record<string, ChatMessage[]> => ({ [session]: [{ role: "user", content: "ingress 502 lagi", timestamp: 1 }, { role: "assistant", content: "rollout restart, beres", timestamp: 2 }] });

  test("each sighting is counted, and it says whether its conversation is still kept", async () => {
    const h = learning({ conversations: seenIn("ses_1") });
    await h.engine.observe(recovered("ses_1"));
    await h.engine.observe(recovered("ses_1"));
    expect(h.engine.candidates()).toMatchObject([{ name: "restart-stuck-ingress", sightings: 2, kept: true }]);
    const gone = learning();
    await gone.engine.observe(recovered("ses_1"));
    expect(gone.engine.candidates()).toMatchObject([{ sightings: 1, kept: false }]);
  });

  test("written now on a person's word: from that conversation, with no triage, and the candidate is done with", async () => {
    const h = learning({ conversations: seenIn("ses_1") });
    await h.engine.observe(recovered("ses_1"));
    const outcome = await h.engine.writeCandidate("restart-stuck-ingress", "gading");
    expect(outcome).toMatchObject({ ok: true, draft: { name: "restart-stuck-ingress", triggerKind: "user_request", triggerReason: expect.stringContaining("a fix that worked") } });
    expect(h.calls()).toEqual({ triage: 1, written: 1 });
    const prompt = h.asked.at(-1)!.prompt;
    expect(prompt).toContain("assistant: rollout restart, beres");
    expect(prompt).toContain("This class of work was named `restart-stuck-ingress`: Use when the ingress answers 502 after a node reboot. Keep that name unless it is wrong.");
    expect(h.engine.candidates()).toEqual([]);
  });

  test("its conversation gone: nothing is asked, and the reason is said", async () => {
    const h = learning();
    await h.engine.observe(recovered("ses_1"));
    expect(await h.engine.writeCandidate("restart-stuck-ingress", "gading")).toEqual({
      ok: false,
      why: "gone",
      error: "the conversation it was seen in is gone, so there is nothing to write it from. It is written when the work comes back",
    });
    expect(await h.engine.writeCandidate("never-seen", "gading")).toMatchObject({ ok: false, why: "not_held" });
    expect(h.calls().written).toBe(0);
    expect(h.engine.candidates()).toHaveLength(1);
  });

  // After `/new` the conversation is still there and holds nothing: there is as little to write it from.
  test("its conversation emptied is the same", async () => {
    const h = learning({ conversations: { ses_1: [] } });
    await h.engine.observe(recovered("ses_1"));
    expect(await h.engine.writeCandidate("restart-stuck-ingress", "gading")).toMatchObject({ ok: false, error: expect.stringContaining("is gone") });
    expect(h.calls().written).toBe(0);
  });

  test("a draft the daemon refuses is said as the reason, and the kind of work stays held", async () => {
    const leaky = JSON.stringify({ name: "restart-stuck-ingress", description: "Use when the ingress answers 502.", body: "1. ssh root@172.16.42.8 and restart" });
    const h = learning({ conversations: seenIn("ses_1"), written: leaky });
    await h.engine.observe(recovered("ses_1"));
    const outcome = await h.engine.writeCandidate("restart-stuck-ingress", "gading");
    expect(outcome).toEqual({ ok: false, why: "nothing", error: "its draft was refused: it names a machine's address (172.16.42.8). Facts about this environment belong in memory" });
    expect(h.engine.candidates()).toHaveLength(1);
  });

  test("forgotten on a person's word, and on record", async () => {
    const h = learning();
    await h.engine.observe(recovered("ses_1"));
    expect(h.engine.forgetCandidate("restart-stuck-ingress", "gading")).toBe(true);
    expect(h.engine.candidates()).toEqual([]);
    expect(h.audited.at(-1)).toMatchObject({ action: "skill_candidate_forgotten", actor: "gading", details: { skill: "restart-stuck-ingress" } });
    expect(h.engine.forgetCandidate("restart-stuck-ingress", "gading")).toBe(false);
  });
});

describe("a look that wrote nothing says why, where a person can read it", () => {
  test("triage's own reason is kept with what made it look", async () => {
    const h = learning({ triage: skipAnswer("a number looked up, nothing done") });
    await h.engine.observe(recovered("ses_1"));
    expect(h.audited.filter((row) => row.action === "skill_pass_nothing")).toMatchObject([
      { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "123", details: { why: "a number looked up, nothing done", trigger: "error_recovery" } },
    ]);
  });

  test("a lesson for a skill that ships with Nouride, or that a person wrote, says so", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "by-hand", description: "Use when it is needed.", body: "1. do it" });
    const h = learning({ agentsDir, triage: updateAnswer("by-hand") });
    await h.engine.observe(recovered("ses_1"));
    expect(h.audited.find((row) => row.action === "skill_pass_nothing")?.details).toMatchObject({ why: "the lesson belongs to by-hand, which a person wrote and is not changed" });
    expect(h.calls().written).toBe(0);
  });
});

describe("the skills a conversation read are named to triage", () => {
  test("one read by its path is said outright, with the rule that a lesson on its ground goes to it", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "site-contributing", description: "Use when changing the site.", body: "1. build", author: "nouva" });
    await writeNewSkill(agentsDir, { name: "never-opened", description: "Use when nothing else fits.", body: "1. wait", author: "nouva" });
    const path = join(skillsDirFor(agentsDir), "site-contributing", "SKILL.md");
    const messages: ChatMessage[] = [
      { role: "user", content: "ubah header situsnya", timestamp: 1 },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: { path } }], timestamp: 2 },
      { role: "tool", content: "1. build", toolCallId: "c1", timestamp: 3 },
      { role: "assistant", content: "sudah", timestamp: 4 },
    ];
    const h = learning({ agentsDir, triage: skipAnswer() });
    await h.engine.observe({ ...recovered("ses_1"), messages, chain: messages });
    expect(h.asked[0]!.prompt).toContain("Skills this conversation read: site-contributing. A lesson about what one of them covers goes to that one first, by update or attach, unless it is marked off limits above.");
  });

  test("nothing is said where none was read", async () => {
    const h = learning({ triage: skipAnswer() });
    await h.engine.observe(recovered("ses_1"));
    expect(h.asked[0]!.prompt).not.toContain("Skills this conversation read");
  });
});

// Measured on a live box's conversations before it was left so: the agents' small model would act on 1 of 13 where
// their own would on 7.
describe("the deciding call runs on the model that writes", () => {
  test("an agent with a small model still decides on its own: the small one is not asked", async () => {
    const h = learning({ smallModel: "tiny-1" });
    await h.engine.observe(recovered("ses_1", "simpan jadi skill ya"));
    expect(h.asked.map((one) => [one.triage, one.model])).toEqual([[true, h.agent.config.llm.model], [false, h.agent.config.llm.model]]);
  });

  test("a model somebody named for learning does both", async () => {
    const h = learning({ smallModel: "tiny-1", model: "chosen-9" });
    await h.engine.observe(recovered("ses_1", "simpan jadi skill ya"));
    expect(h.asked.map((one) => one.model)).toEqual(["chosen-9", "chosen-9"]);
  });

  test("a tier named for learning is that tier's model for both", async () => {
    const h = learning({ smallModel: "tiny-1", model: "small" });
    await h.engine.observe(recovered("ses_1", "simpan jadi skill ya"));
    expect(h.asked.map((one) => one.model)).toEqual(["tiny-1", "tiny-1"]);
  });
});

describe("after a look that gave nothing, the next waits for twice the work", () => {
  const clocks = (tuning = {}) => {
    let at = 0;
    const cooldowns = new Cooldowns({ ...TUNING, reflectAfter: 8, ...tuning }, () => at);
    const turn = (rounds: number, later = 0) => cooldowns.accumulate(worked("ses_1", rounds, { at: (at += later) }));
    return { cooldowns, turn };
  };

  test("eight rounds, then sixteen, and no further: it doubles once", () => {
    const { cooldowns, turn } = clocks();
    turn(1);
    expect(cooldowns.dueAfter("ses_1")).toBe(8);
    for (const due of [16, 16, 16]) {
      cooldowns.missed("ses_1");
      expect(cooldowns.dueAfter("ses_1")).toBe(due);
    }
    expect(TUNING.maxDoublings).toBe(1);
  });

  test("how many times it may double is a dial: twice is eight, sixteen, thirty-two", () => {
    const { cooldowns, turn } = clocks({ maxDoublings: 2 });
    turn(1);
    for (const due of [16, 32, 32]) {
      cooldowns.missed("ses_1");
      expect(cooldowns.dueAfter("ses_1")).toBe(due);
    }
  });

  test("a draft kept sets it back", () => {
    const { cooldowns, turn } = clocks();
    turn(1);
    cooldowns.missed("ses_1");
    cooldowns.missed("ses_1");
    cooldowns.landed("ses_1");
    expect(cooldowns.dueAfter("ses_1")).toBe(8);
  });

  test("so does the chat put down for the break, and not a pause shorter than it", () => {
    const { cooldowns, turn } = clocks({ breakMs: 6 * 3_600_000 });
    turn(1, 1000);
    cooldowns.missed("ses_1");
    turn(1, 5 * 3_600_000);
    expect(cooldowns.dueAfter("ses_1")).toBe(16);
    turn(1, 6 * 3_600_000);
    expect(cooldowns.dueAfter("ses_1")).toBe(8);
  });

  test("a chat never looked at waits for the first amount", () => {
    expect(clocks().cooldowns.dueAfter("ses_unseen")).toBe(8);
  });

  test("through the pass: the same work that made it look does not make it look again, and twice that does", async () => {
    const h = learning({ triage: skipAnswer(), tuning: { reflectAfter: 4, maxDoublings: 2 } });
    await h.engine.observe(worked("ses_1", 4));
    expect(h.calls().triage).toBe(1);
    await h.engine.observe(worked("ses_1", 4));
    expect(h.calls().triage).toBe(1);
    await h.engine.observe(worked("ses_1", 4));
    expect(h.calls().triage).toBe(2);
    // Another chat of the same agent has given nothing yet, and is looked at after the first amount.
    await h.engine.observe(worked("ses_2", 4));
    expect(h.calls().triage).toBe(3);
  });

  test("a person asking is never made to wait by it", async () => {
    const h = learning({ triage: [skipAnswer(), createAnswer()], tuning: { reflectAfter: 4 } });
    await h.engine.observe(worked("ses_1", 4));
    await h.engine.observe(worked("ses_1", 1, { userText: "simpan jadi skill ya" }));
    expect(h.drafts.pending()).toHaveLength(1);
  });
});

describe("what learning would do with a conversation, with nothing kept", () => {
  test("it says what triage decided and what was written, and keeps no candidate and no draft", async () => {
    const h = learning({ smallModel: "tiny-1" });
    const out = await h.engine.tryOut({ agentId: "nouva", transcript: "user: ingress 502\n\nassistant: rollout restart", reason: "a recorded conversation" });
    expect(out).toMatchObject({ decision: "create", name: "restart-stuck-ingress", why: "a fix that worked", refused: null, calls: 2, triageModel: h.agent.config.llm.model, model: h.agent.config.llm.model, before: 0 });
    expect("bodyChars" in out && out.bodyChars).toBeGreaterThan(20);
    expect(h.engine.candidates()).toEqual([]);
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked[0]!.prompt).toContain("Why this turn was flagged: a recorded conversation.");
  });

  test("a decision to write nothing comes back with its reason, and a model can be named for the try", async () => {
    const h = learning({ triage: skipAnswer("nothing done") });
    const out = await h.engine.tryOut({ agentId: "nouva", transcript: "user: jam berapa?", triageModel: "other-2" });
    expect(out).toMatchObject({ decision: "nothing", why: "nothing done", calls: 1, triageModel: "other-2" });
    expect(h.asked[0]!.model).toBe("other-2");
  });

  test("what the daemon would refuse is said, after the writer's second try", async () => {
    const leaky = JSON.stringify({ name: "restart-stuck-ingress", description: "Use when the ingress answers 502.", body: "1. ssh root@172.16.42.8" });
    const h = learning({ written: leaky });
    const out = await h.engine.tryOut({ agentId: "nouva", transcript: "user: ingress 502" });
    expect(out).toMatchObject({ decision: "create", calls: 3, refused: expect.stringContaining("172.16.42.8") });
  });

  test("asked only what it would decide, it writes nothing and pays for no writing", async () => {
    const h = learning();
    const out = await h.engine.tryOut({ agentId: "nouva", transcript: "user: ingress 502", decideOnly: true });
    expect(out).toMatchObject({ decision: "create", name: "restart-stuck-ingress", calls: 1, bodyChars: 0 });
    expect(h.calls()).toEqual({ triage: 1, written: 0 });
  });

  test("an agent that is not there is an error, and no call", async () => {
    const h = learning();
    expect(await h.engine.tryOut({ agentId: "nobody", transcript: "user: hi" })).toEqual({ error: 'no agent "nobody"' });
    expect(h.asked).toEqual([]);
  });
});
