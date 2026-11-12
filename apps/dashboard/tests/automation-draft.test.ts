/**
 * An automation as its page holds it, and what a save sends (`modules/automations/lib/draft.ts`). One made before
 * lists is drawn as a single step and saved as the one thing it is; it becomes a list when a second step is added or
 * its step takes something only a list holds. A change sends what changed and nothing else.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "@nouride/wire";
import {
  READS_OUTPUT, blankDraft, changed, createBody, deliveryOf, draftOf, draftProblems, listedSteps, patchBody, payloadOf, savesAsList, sessionOf, settled, stepsOf, turnsIntoList, type Draft,
} from "@/modules/automations/lib/draft";
import type { Step } from "@/modules/automations/lib/steps";

const TZ = "Asia/Jakarta";
const automation = (over: Partial<AutomationSummary>): AutomationSummary => ({
  id: "cron_1", agentId: "nouva", name: "Morning brief", enabled: true, trigger: { kind: "every", everyMs: 600_000 }, payload: { kind: "agentTurn", message: "Sum up the mail." },
  delivery: { mode: "announce" }, target: { gatewayId: "telegram:nouva", chatId: "8142" }, session: "fresh", createdBy: "gading", createdAt: 1, runCount: 0, failCount: 0, failStreak: 0,
  describes: "every 10m", start: "scheduled", ...over,
});
const loaded = (over: Partial<AutomationSummary> = {}): Draft => draftOf(automation(over), TZ);
const say = (id: string, text = "hello"): Step => ({ id, kind: "systemEvent", text });

describe("an automation as a draft", () => {
  test("one thing is drawn as the single step it is, each kind with what it holds", () => {
    expect(stepsOf({ kind: "agentTurn", message: "Sum up.", model: "big" })).toEqual([{ id: "s1", kind: "agentTurn", message: "Sum up.", model: "big" }]);
    expect(stepsOf({ kind: "systemEvent", text: "Hi" })).toEqual([{ id: "s1", kind: "systemEvent", text: "Hi" }]);
    expect(stepsOf({ kind: "command", argv: ["sh", "-lc", "ls"], cwd: "/srv", timeoutMs: 5000, then: "agentTurn" })).toEqual([{ id: "s1", kind: "command", argv: ["sh", "-lc", "ls"], cwd: "/srv", timeoutMs: 5000 }]);
    expect(stepsOf({ kind: "mission", goal: "Do it", checks: ["true"], review: false })).toEqual([{ id: "s1", kind: "mission", goal: "Do it", checks: ["true"], review: false }]);
    expect(stepsOf({ kind: "steps", steps: [say("a"), say("b")] })).toEqual([say("a"), say("b")]);
  });

  test("a loaded one keeps how it starts, where it reports, and whether it was a list", () => {
    const draft = loaded({ payload: { kind: "command", argv: ["sh", "-lc", "ls"], then: "agentTurn" }, session: "chat", delivery: { mode: "none" } });
    expect(draft).toMatchObject({ name: "Morning brief", agentId: "nouva", start: "scheduled", gatewayId: "telegram:nouva", chatId: "8142", session: "chat", then: "agentTurn", list: false, delivery: { mode: "none" } });
    expect(draft.trigger).toMatchObject({ mode: "interval", everyCount: "10", everyUnit: "m" });
    expect(loaded({ payload: { kind: "steps", steps: [say("a")] } }).list).toBe(true);
    expect(blankDraft("nouva", "telegram:nouva", TZ)).toMatchObject({ name: "", agentId: "nouva", start: "scheduled", chatId: "", steps: [], session: "fresh", delivery: { mode: "announce" }, list: false });
  });
});

describe("one thing, or a list", () => {
  test("one step with nothing only a list holds is saved as the one thing it is", () => {
    const draft = loaded();
    expect(savesAsList(draft)).toBe(false);
    expect(payloadOf(draft)).toEqual({ kind: "agentTurn", message: "Sum up the mail." });
    expect(payloadOf({ steps: [{ id: "s1", kind: "command", argv: ["sh", "-lc", "ls"], timeoutMs: 9000 }], then: "agentTurn", list: false })).toEqual({ kind: "command", argv: ["sh", "-lc", "ls"], timeoutMs: 9000, then: "agentTurn" });
    expect(payloadOf({ steps: [say("s1", " Hi ")], then: "deliver", list: false })).toEqual({ kind: "systemEvent", text: "Hi" });
    expect(payloadOf({ steps: [{ id: "s1", kind: "mission", goal: " Do ", checks: ["true"] }], then: "deliver", list: false })).toEqual({ kind: "mission", goal: "Do", checks: ["true"] });
  });

  test("a second step, a name, an agent of its own, a path of its own or a wait for a person makes it a list", () => {
    const one = (step: Step) => savesAsList({ steps: [step], list: false });
    expect(savesAsList({ steps: [say("a"), say("b")], list: false })).toBe(true);
    expect(one({ ...say("a"), name: "Tell" })).toBe(true);
    expect(one({ id: "a", kind: "agentTurn", message: "x", agentId: "nix" })).toBe(true);
    expect(one({ ...say("a"), then: "end" })).toBe(true);
    expect(one({ id: "a", kind: "approval", ask: "Go?" })).toBe(true);
    // A name of spaces is no name.
    expect(one({ ...say("a"), name: "  " })).toBe(false);
    // One loaded as a list stays one, however short; and no steps is a list too, which a save refuses.
    expect(savesAsList({ steps: [say("a")], list: true })).toBe(true);
    expect(payloadOf({ steps: [say("a")], then: "deliver", list: true })).toEqual({ kind: "steps", steps: [say("a")] });
  });

  test("a command that woke its agent becomes the command and a step for the agent, written out in the draft", () => {
    const draft = loaded({ payload: { kind: "command", argv: ["sh", "-lc", "ls"], then: "agentTurn" } });
    const named: Draft = { ...draft, steps: [{ ...draft.steps[0]!, name: "List" }] };
    expect(listedSteps(named)).toEqual([{ id: "s1", kind: "command", argv: ["sh", "-lc", "ls"], name: "List" }, { id: "s2", kind: "agentTurn", message: READS_OUTPUT }]);
    const after = settled(named);
    expect(after.then).toBe("deliver");
    expect(after.steps).toHaveLength(2);
    expect(payloadOf(after)).toEqual({ kind: "steps", steps: after.steps });
    // A step added after the command, or before it: the agent's step stands right after the command either way.
    const ids = (steps: Step[]) => settled({ ...draft, steps }).steps.map((step) => `${step.id}:${step.kind}`);
    expect(ids([draft.steps[0]!, say("s2")])).toEqual(["s1:command", "s3:agentTurn", "s2:systemEvent"]);
    expect(ids([say("s2"), draft.steps[0]!])).toEqual(["s2:systemEvent", "s1:command", "s3:agentTurn"]);
    // While it is one thing, and for a command that only sent its output, nothing is added.
    expect(settled(draft)).toBe(draft);
    expect(listedSteps({ ...named, then: "deliver" })).toHaveLength(1);
    expect(turnsIntoList(draft, after)).toEqual(["Its command handed what it printed to the agent. That is a step of its own now, after the command."]);
  });

  test("one on its chat's history starts each run clean as a list, said before the save; a list that stays a list says nothing", () => {
    const was = loaded({ session: "chat" });
    const now: Draft = { ...was, steps: [...was.steps, say("s2")] };
    expect(sessionOf(was)).toBe("chat");
    expect(sessionOf(now)).toBe("fresh");
    expect(sessionOf({ ...now, session: "isolated" })).toBe("isolated");
    expect(turnsIntoList(was, now)).toEqual(["It read its chat's history. With more than one step, each run starts clean instead."]);
    expect(patchBody(was, now).session).toBe("fresh");
    expect(turnsIntoList(now, { ...now, steps: [...now.steps, say("s3")] })).toEqual([]);
    expect(turnsIntoList(was, was)).toEqual([]);
    expect(turnsIntoList(null, now)).toEqual([]);
  });

  test("a mission tells its chat when it is done or needs someone, whatever was picked", () => {
    const quiet = { steps: [say("a"), { id: "b", kind: "mission", goal: "x" } as Step], delivery: { mode: "none" as const } };
    expect(deliveryOf(quiet)).toEqual({ mode: "announce" });
    expect(deliveryOf({ steps: [say("a")], delivery: { mode: "none" } })).toEqual({ mode: "none" });
  });
});

describe("what a save sends", () => {
  test("a change sends only what changed", () => {
    const was = loaded();
    expect(patchBody(was, was)).toEqual({});
    expect(changed(was, was)).toBe(false);
    expect(patchBody(was, { ...was, name: " Evening brief " })).toEqual({ name: "Evening brief" });
    expect(patchBody(was, { ...was, steps: [{ id: "s1", kind: "agentTurn", message: "Sum up the news." }] })).toEqual({ payload: { kind: "agentTurn", message: "Sum up the news." } });
    expect(patchBody(was, { ...was, chatId: "-100" })).toEqual({ target: { gatewayId: "telegram:nouva", chatId: "-100" } });
    expect(patchBody(was, { ...was, delivery: { mode: "none" } })).toEqual({ delivery: { mode: "none" } });
    expect(patchBody(was, { ...was, session: "isolated" })).toEqual({ session: "isolated" });
    expect(changed(was, { ...was, name: "x" })).toBe(true);
  });

  test("a step added sends the whole list, each step as it stands", () => {
    const was = loaded();
    const now: Draft = { ...was, steps: [...was.steps, { id: "s2", kind: "approval", ask: "Send it?" }, say("s3", "Done.")] };
    expect(patchBody(was, now)).toEqual({ payload: { kind: "steps", steps: [{ id: "s1", kind: "agentTurn", message: "Sum up the mail." }, { id: "s2", kind: "approval", ask: "Send it?" }, { id: "s3", kind: "systemEvent", text: "Done." }] } });
  });

  test("the start: a time changed is sent as the server parses it, a start by hand as `manual`, and a webhook's never", () => {
    const was = loaded();
    expect(patchBody(was, { ...was, trigger: { ...was.trigger, everyCount: "30" } })).toEqual({ every: "30m" });
    expect(patchBody(was, { ...was, start: "manual" })).toEqual({ manual: true });
    expect(patchBody({ ...was, start: "manual" }, was)).toEqual({ every: "10m" });
    const hook = loaded({ start: "webhook", trigger: { kind: "webhook" } });
    expect(patchBody(hook, { ...hook, name: "New order" })).toEqual({ name: "New order" });
    // A start at one moment, already past, is not sent again with another change: it would be refused.
    const once = loaded({ trigger: { kind: "at", at: 1_000 } });
    expect(patchBody(once, { ...once, name: "Later" })).toEqual({ name: "Later" });
  });

  test("a report elsewhere than its chat is kept when only the mode changes", () => {
    const was = loaded({ delivery: { mode: "announce", gatewayId: "discord:nix", chatId: "ops" } });
    expect(patchBody(was, { ...was, delivery: { ...was.delivery, mode: "none" } })).toEqual({ delivery: { mode: "none", gatewayId: "discord:nix", chatId: "ops" } });
  });

  test("a new one: its agent, name, work, chat and start; a webhook has no start to send; once may stay listed", () => {
    const draft: Draft = { ...blankDraft("nouva", "telegram:nouva", TZ), name: " Shop check ", chatId: " -100 ", steps: [{ id: "s1", kind: "command", argv: ["sh", "-lc", "true"] }, say("s2", "Up.")] };
    const body = { agentId: "nouva", name: "Shop check", payload: { kind: "steps" as const, steps: draft.steps }, target: { gatewayId: "telegram:nouva", chatId: "-100" }, delivery: { mode: "announce" as const } };
    expect(createBody(draft)).toEqual({ ...body, every: "15m" });
    expect(createBody({ ...draft, start: "manual" })).toEqual({ ...body, manual: true });
    expect(createBody({ ...draft, start: "webhook" })).toEqual(body);
    const once: Draft = { ...draft, trigger: { ...draft.trigger, mode: "once", at: "2030-01-01T09:00" }, keepAfterRun: true };
    expect(createBody(once)).toEqual({ ...body, at: "2030-01-01 09:00", tz: TZ, keepAfterRun: true });
    expect(createBody({ ...once, keepAfterRun: false })).toEqual({ ...body, at: "2030-01-01 09:00", tz: TZ });
  });

  test("what a save still lacks, in the order the page shows it: a name, a start, who and where, the steps", () => {
    const blank = blankDraft("", "", TZ);
    expect(draftProblems(blank).problems.map((problem) => `${problem.part}: ${problem.message}`)).toEqual([
      "name: Give it a name.",
      "who: Pick the agent that runs it.",
      "who: Pick the chat it reports to.",
      "steps: Add a step: what should happen when it starts.",
    ]);
    const bad: Draft = { ...loaded(), trigger: { ...loaded().trigger, everyCount: "0" }, steps: [say("s1"), { id: "s2", kind: "agentTurn", message: " " }] };
    expect(draftProblems(bad).problems.map((problem) => `${problem.part}: ${problem.message}`)).toEqual(["start: Say when it starts.", "steps: Step 2: Write what to ask the agent."]);
    expect(draftProblems(loaded()).problems).toEqual([]);
    // A start by hand, or by its address, has no time to lack.
    expect(draftProblems({ ...bad, start: "manual", steps: [say("s1")] }).problems).toEqual([]);
  });
});
