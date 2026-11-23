/**
 * A change an agent suggested, read against the automation as it runs (`modules/automations/lib/suggested.ts`): what
 * it would add, change and remove. Steps are matched by what they do, since an agent that writes a list anew has its
 * steps named by their place: one step put in must not make every step after it read as changed.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "@nouride/wire";
import type { Step } from "@/modules/automations/lib/steps";
import { draftOf } from "@/modules/automations/lib/draft";
import { changeWords, draftChangeWords, scriptsBrought, stepMarks } from "@/modules/automations/lib/suggested";

const run = (id: string, line: string, more: Partial<Step> = {}): Step => ({ id, kind: "command", argv: ["sh", "-lc", line], ...more }) as Step;
const say = (id: string, text: string, more: Partial<Step> = {}): Step => ({ id, kind: "systemEvent", text, ...more }) as Step;
const marks = (current: Step[], suggested: Step[]) => {
  const found = stepMarks(current, suggested);
  return { current: Object.fromEntries(found.current), suggested: Object.fromEntries(found.suggested) };
};

describe("what a suggested change does to each step", () => {
  const NOW = [run("check", "curl shop"), say("tell", "It is down.")];

  test("the same list has no marks", () => {
    expect(marks(NOW, NOW)).toEqual({ current: {}, suggested: {} });
  });

  test("a step at the end is added; the rest have no mark", () => {
    expect(marks(NOW, [...NOW, run("log", "date >> log")])).toEqual({ current: {}, suggested: { log: "added" } });
  });

  test("a step that says something else is changed, on both sides", () => {
    expect(marks(NOW, [NOW[0]!, say("tell", "It is down, and noted.")])).toEqual({ current: { tell: "changed" }, suggested: { tell: "changed" } });
  });

  test("a step that is gone is removed", () => {
    expect(marks(NOW, [NOW[0]!])).toEqual({ current: { tell: "removed" }, suggested: {} });
  });

  test("a list written anew, its ids by place: one step put in is one step added, not every step after it changed", () => {
    const current = [run("s1", "curl shop"), say("s2", "It is down.")];
    const suggested = [run("s1", "curl shop"), run("s2", "date >> log"), say("s3", "It is down.")];
    expect(marks(current, suggested)).toEqual({ current: {}, suggested: { s2: "added" } });
  });

  test("a path that leads elsewhere is a change; one that leads to the same step under another id is not", () => {
    const current = [run("s1", "curl shop", { whenFailed: { to: "s2" } }), say("s2", "It is down.")];
    const renamed = [run("a", "curl shop", { whenFailed: { to: "b" } }), say("b", "It is down.")];
    expect(marks(current, renamed)).toEqual({ current: {}, suggested: {} });
    const rerouted = [run("s1", "curl shop", { whenFailed: "next", then: "end" }), say("s2", "It is down.")];
    expect(marks(current, rerouted)).toEqual({ current: { s1: "changed" }, suggested: { s1: "changed" } });
  });

  test("a step moved among the others, keeping its id, is changed", () => {
    const current = [run("a", "one"), run("b", "two"), run("c", "three")];
    expect(marks(current, [current[1]!, current[2]!, current[0]!])).toEqual({ current: { a: "changed" }, suggested: { a: "changed" } });
  });
});

describe("the banner's sentence", () => {
  const automation = (steps: Step[], over: Partial<AutomationSummary> = {}): AutomationSummary => ({
    id: "cron_1", agentId: "nouva", name: "Shop check", enabled: true, trigger: { kind: "every", everyMs: 600_000 }, payload: { kind: "steps", steps }, delivery: { mode: "announce" },
    target: { gatewayId: "telegram:nouva", chatId: "1" }, session: "fresh", createdBy: "gading", createdAt: 1, runCount: 0, failCount: 0, failStreak: 0, describes: "every 10m", start: "scheduled", ...over,
  });
  const NOW = [run("check", "curl shop"), say("tell", "It is down."), say("bye", "Bye.")];

  test("says what is added, changed and removed, by the steps' numbers", () => {
    const suggested = [NOW[0]!, say("tell", "It is down, and noted."), run("log", "date >> log")];
    expect(changeWords(automation(NOW), automation(suggested), "UTC")).toBe("Adds step 3. Changes step 2. Removes step 3 of the ones it runs now.");
    expect(changeWords(automation(NOW), automation([...NOW, run("x", "one"), run("y", "two"), run("z", "three")]), "UTC")).toBe("Adds steps 4, 5 and 6.");
  });

  test("says a new name, a new start and a new chat; and when nothing would change", () => {
    expect(changeWords(automation(NOW), automation(NOW, { name: "Shop watch" }), "UTC")).toBe('Renames it to "Shop watch".');
    expect(changeWords(automation(NOW), automation(NOW, { trigger: { kind: "cron", expr: "0 7 * * *" } }), "UTC")).toBe("It would start every day at 07:00.");
    expect(changeWords(automation(NOW), automation(NOW, { target: { gatewayId: "telegram:nouva", chatId: "2" } }), "UTC")).toBe("It would report to another chat.");
    expect(changeWords(automation(NOW), automation(NOW), "UTC")).toBe("It would run as it does now.");
  });

  test("says a mark where it reports that the change sets or drops: telling once, and telling at once whatever the hour", () => {
    const once = { delivery: { mode: "announce" as const, once: true as const } };
    const both = { delivery: { mode: "announce" as const, once: true as const, atOnce: true as const } };
    expect(changeWords(automation(NOW), automation(NOW, once), "UTC")).toBe("It would tell once, then turn itself off.");
    expect(changeWords(automation(NOW, once), automation(NOW), "UTC")).toBe("It would go on telling, and no longer turn itself off.");
    expect(changeWords(automation(NOW, once), automation(NOW, both), "UTC")).toBe("It would tell at once, even in quiet hours.");
    expect(changeWords(automation(NOW, both), automation(NOW, once), "UTC")).toBe("What it says in quiet hours would be kept until they end.");
    // The same marks on both sides are no change.
    expect(changeWords(automation(NOW, both), automation(NOW, both), "UTC")).toBe("It would run as it does now.");
    // A step marked to go on only when what it says changes is a change to that step.
    expect(changeWords(automation(NOW), automation([{ ...NOW[0]!, onlyChanged: true }, ...NOW.slice(1)]), "UTC")).toBe("Changes step 1.");
  });

  test("a change to the draft on the page says the same, and what only such a change can be: another agent, another end", () => {
    const draft = (steps: Step[], over: Partial<AutomationSummary> = {}) => draftOf(automation(steps, over), "UTC");
    const suggested = [NOW[0]!, say("tell", "It is down, and noted."), run("log", "date >> log")];
    expect(draftChangeWords(draft(NOW), draft(suggested), "UTC")).toBe("Adds step 3. Changes step 2. Removes step 3 of the ones it runs now.");
    expect(draftChangeWords(draft(NOW), draft(NOW, { agentId: "nox" }), "UTC")).toBe("Another agent would run it.");
    const lasting = (lasts?: number) => draft(NOW, { delivery: { mode: "announce", ...(lasts === undefined ? {} : { lasts }) } });
    expect(draftChangeWords(lasting(), lasting(3_600_000), "UTC")).toBe("How long it lasts would change.");
    expect(draftChangeWords(lasting(3_600_000), lasting(7_200_000), "UTC")).toBe("How long it lasts would change.");
    expect(draftChangeWords(lasting(3_600_000), lasting(), "UTC")).toBe("It would have no end.");
    // A start by hand or by its address is said as that, not as a time.
    expect(draftChangeWords(draft(NOW), draft(NOW, { start: "manual", trigger: { kind: "manual" } }), "UTC")).toBe("It would start when you press Run now.");
    expect(draftChangeWords(draft(NOW), draft(NOW, { start: "webhook", trigger: { kind: "webhook" } }), "UTC")).toBe("It would start when its address is called.");
    // Reporting elsewhere than it watches is another chat too.
    expect(draftChangeWords(draft(NOW), draft(NOW, { delivery: { mode: "announce", gatewayId: "whatsapp:nouva", chatId: "9" } }), "UTC")).toBe("It would report to another chat.");
    expect(draftChangeWords(draft(NOW), draft(NOW), "UTC")).toBe("It would run as it does now.");
  });
});

describe("a script a change brings", () => {
  const script = (id: string, text: string): Step => ({ id, kind: "command", argv: ["python3"], script: { text, about: "Counts" } }) as Step;
  const draft = (steps: Step[]) => draftOf({ id: "cron_1", agentId: "nouva", name: "Count", enabled: true, trigger: { kind: "every", everyMs: 600_000 }, payload: { kind: "steps", steps }, delivery: { mode: "announce" }, target: { gatewayId: "telegram:nouva", chatId: "1" }, session: "fresh", createdBy: "gading", createdAt: 1, runCount: 0, failCount: 0, failStreak: 0, describes: "every 10m", start: "scheduled" }, "UTC");

  test("is named by its step's place: a new one, and one whose text is not what the draft held", () => {
    const now = draft([run("a", "ls"), script("b", "print(1)")]);
    expect(scriptsBrought(now, draft([run("a", "ls"), script("b", "print(1)")]))).toEqual([]);
    expect(scriptsBrought(now, draft([run("a", "ls"), script("b", "print(2)")]))).toEqual([2]);
    expect(scriptsBrought(now, draft([script("new", "print(9)"), run("a", "ls"), script("b", "print(1)")]))).toEqual([1]);
    // The same text under another id, or at another place, is a script the person has read already.
    expect(scriptsBrought(now, draft([script("s1", "print(1)"), run("s2", "ls")]))).toEqual([]);
    // A line of a shell is read on its card: only a script's text is behind a button.
    expect(scriptsBrought(now, draft([run("a", "rm -rf build"), script("b", "print(1)")]))).toEqual([]);
  });
});
