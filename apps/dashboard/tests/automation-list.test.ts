/**
 * The Automations list's decisions (`modules/automations/lib/list.ts`): which automations are rows, the state each
 * says, its preview, its last run in words, and what the filter and the search keep.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "@nouride/wire";
import { counts, lastRunLine, matches, parseStart, previewOf, rows, searchedIn, stateOf } from "@/modules/automations/lib/list";
import type { Step } from "@/modules/automations/lib/steps";

const one = (id: string, over: Partial<AutomationSummary> = {}): AutomationSummary => ({
  id, agentId: "nix", name: `Automation ${id}`, enabled: true, trigger: { kind: "every", everyMs: 600_000 }, payload: { kind: "systemEvent", text: "Hi" }, delivery: { mode: "announce" },
  target: { gatewayId: "telegram:nouva", chatId: "1" }, session: "fresh", createdBy: "gading", createdAt: 1, runCount: 0, failCount: 0, failStreak: 0, describes: "every 10m", start: "scheduled", ...over,
});
const name = (id: string) => ({ nix: "Nix", nouva: "Nouva" })[id] ?? id;

describe("the rows", () => {
  test("a change an agent suggested is not a row of its own while what it would change is listed", () => {
    const list = [one("a", { suggested: "b" }), one("b", { proposal: { by: "nouva", at: 1, replaces: "a" } }), one("c", { proposal: { by: "nouva", at: 1 } }), one("d", { proposal: { by: "nouva", at: 1, replaces: "gone" } })];
    expect(rows(list).map((row) => row.id)).toEqual(["a", "c", "d"]);
  });

  test("how many each choice of the filter holds, and what each keeps", () => {
    const list = [one("a"), one("b", { start: "webhook" }), one("c", { start: "manual" }), one("d")];
    expect(counts(list)).toEqual({ all: 4, scheduled: 2, webhook: 1, manual: 1 });
    expect(list.filter((row) => matches(row, "webhook")).map((row) => row.id)).toEqual(["b"]);
    expect(list.filter((row) => matches(row, "all"))).toHaveLength(4);
    expect([parseStart("webhook"), parseStart("scheduled"), parseStart("manual"), parseStart("x"), parseStart(undefined), parseStart(["webhook"])]).toEqual(["webhook", "scheduled", "manual", "all", "all", "all"]);
  });
});

describe("the state a row says", () => {
  test("most pressing first: suggested, waiting for you, a change suggested, failing, paused, on", () => {
    const waiting = { id: "r", jobId: "a", startedAt: 1, status: "waiting" as const, waiting: { kind: "approval" as const, step: "s", since: 1, until: 2, ask: "Go?" } };
    expect(stateOf(one("a", { proposal: { by: "nouva", at: 1 }, enabled: false }), name)).toEqual({ word: "Suggested by Nouva", tone: "needs" });
    expect(stateOf(one("a", { lastRun: waiting, suggested: "b", failStreak: 2 }), name)).toEqual({ word: "Waiting for you", tone: "needs" });
    expect(stateOf(one("a", { suggested: "b", failStreak: 2 }), name)).toEqual({ word: "A change is suggested", tone: "needs" });
    expect(stateOf(one("a", { failStreak: 2, enabled: false }), name)).toEqual({ word: "Failing", tone: "failed" });
    expect(stateOf(one("a", { enabled: false }), name)).toEqual({ word: "Paused", tone: "quiet" });
    expect(stateOf(one("a"), name)).toEqual({ word: "On", tone: "done" });
    // A run that waits for a mission is the automation at work, not something for the person.
    expect(stateOf(one("a", { lastRun: { id: "r", jobId: "a", startedAt: 1, status: "waiting", waiting: { kind: "mission", step: "s", missionId: "msn_1", since: 1 } } }), name).word).toBe("On");
  });

  test("one that told and turned itself off says so, quietly: nobody paused it, and nothing failed", () => {
    expect(stateOf(one("a", { enabled: false, disabledReason: "told" }), name)).toEqual({ word: "Told you, now off", tone: "quiet" });
    // Turned on again it is on, whatever it was off for; off for another reason it is paused.
    expect(stateOf(one("a", { enabled: true, disabledReason: "told" }), name)).toEqual({ word: "On", tone: "done" });
    expect(stateOf(one("a", { enabled: false, disabledReason: "5 runs failed in a row" }), name)).toEqual({ word: "Paused", tone: "quiet" });
  });
});

describe("a row's preview and last run", () => {
  const steps = (count: number): Step[] => Array.from({ length: count }, (_, n) => ({ id: `s${n + 1}`, kind: n % 2 === 0 ? "command" : "agentTurn", ...(n % 2 === 0 ? { argv: ["true"] } : { message: "x" }) }) as Step);

  test("at most six kinds, then how many more; one thing is one", () => {
    expect(previewOf(one("a"))).toEqual({ kinds: ["systemEvent"], more: 0 });
    expect(previewOf(one("a", { payload: { kind: "steps", steps: steps(6) } }))).toEqual({ kinds: ["command", "agentTurn", "command", "agentTurn", "command", "agentTurn"], more: 0 });
    expect(previewOf(one("a", { payload: { kind: "steps", steps: steps(9) } }))).toMatchObject({ more: 3 });
    expect(previewOf(one("a", { payload: { kind: "steps", steps: steps(9) } })).kinds).toHaveLength(6);
  });

  test("its last run: when and how it went; none for one that never ran", () => {
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const at = new Date(2026, 10, 12, 9, 40).getTime();
    const run = (status: "success" | "error" | "running", more = {}) => lastRunLine(one("a", { lastRun: { id: "r", jobId: "a", startedAt: at, status, ...more } }), now);
    expect(run("success", { finishedAt: at + 14_000 })).toMatchObject({ tone: "done" });
    expect(run("success", { finishedAt: at + 14_000 })?.words).toMatch(/^Today .+, done in 14 s$/);
    expect(run("error", { finishedAt: at + 1_000 })?.words).toMatch(/, failed$/);
    expect(run("running")).toMatchObject({ tone: "working" });
    expect(lastRunLine(one("a"), now)).toBeNull();
  });

  test("the search looks in its name, its agent by id and by name, and what each step says", () => {
    const row = one("a", { name: "Shop check", payload: { kind: "steps", steps: [{ id: "s1", kind: "command", argv: ["sh", "-lc", "curl shop"], name: "Ping" }, { id: "s2", kind: "approval", ask: "Send it?" }] } });
    expect(searchedIn(row, name)).toEqual(["Shop check", "nix", "Nix", "Ping", "curl shop", "", "Send it?"]);
  });
});
