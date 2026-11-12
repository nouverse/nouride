/**
 * A change an agent suggested, read against the automation as it runs (`modules/automations/lib/suggested.ts`): what
 * it would add, change and remove. Steps are matched by what they do, since an agent that writes a list anew has its
 * steps named by their place: one step put in must not make every step after it read as changed.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "@nouride/wire";
import type { Step } from "@/modules/automations/lib/steps";
import { changeWords, stepMarks } from "@/modules/automations/lib/suggested";

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
});
