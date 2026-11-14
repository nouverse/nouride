/**
 * An agent moved to its next account when the one it is on reaches a limit. A turn failed on "You've reached your Fable
 * limit" and the person moved the chat back by hand, with another account signed in beside the first. What is decided
 * here: what a limit is, which account a turn starts on, what a refused message marks, and what the chat is told.
 */

import { describe, expect, test } from "bun:test";
import { AcpError, INTERNAL_ERROR, type CliRow } from "@nouride/acp";
import { NourideError } from "@nouride/shared";
import { AccountRotation, ACCOUNTS_SPENT, accountsOf, limitOf, OWN_MODEL, UNSAID_END_MS, type LimitMark } from "@/modules/external-agents/rotation.ts";
import { useOf } from "@/modules/external-agents/use.ts";

const ROW = { id: "claude-code", name: "Claude Code", limit: { key: "errorKind", value: "rate_limit", resets: "rateLimit.resetsAt" } } as CliRow;
const NOW = Date.parse("2026-11-14T13:00:00Z");
const HOUR = 60 * 60_000;

/** A refusal of a message the CLI had taken, as the connection marks one: the prompt's own failure. */
async function refusal(data?: unknown, code = INTERNAL_ERROR): Promise<AcpError> {
  const { CliConnection } = await import("@/modules/external-agents/connection.ts");
  const error = new AcpError(code, "session/prompt: Internal error: You've hit your Fable limit · resets Nov 19, 4pm (UTC).", data);
  const connection = new CliConnection(ROW, { cmd: [], env: {}, cwd: "/" }, "nix", (() => undefined) as never);
  (connection as unknown as { client: unknown }).client = { promptAnswer: async () => Promise.reject(error) };
  await connection.prompt("s1", [], () => {}, (async () => ({ outcome: "cancelled" })) as never).catch(() => undefined);
  return error;
}

const NIX = { id: "nix", name: "Nix", external: { cli: "claude-code", profile: "rina", accounts: ["rina", "work", "spare"] } };
const NOX = { id: "nox", name: "Nox", external: { cli: "claude-code", profile: "rina", accounts: ["rina", "spare"] } };
const SOLO = { id: "solo", name: "Solo", external: { cli: "claude-code", profile: "rina" } };

function rotation(options: { unusable?: string[]; kept?: Record<string, LimitMark> } = {}) {
  let now = NOW;
  let saved = options.kept ?? {};
  const said: [string, Record<string, unknown>][] = [];
  const turn = new AccountRotation({
    file: { load: () => saved, save: (next) => void (saved = next) },
    usable: (_row, account) => !(options.unusable ?? []).includes(account),
    now: () => now,
    record: (action, details) => void said.push([action, details]),
  });
  return { turn, said, kept: () => saved, later: (ms: number) => void (now += ms) };
}

describe("what a limit is", () => {
  test("the refusal's data as the row says it, with the end where the data names one, in seconds", async () => {
    const until = (NOW + 5 * HOUR) / 1000;
    expect(limitOf(ROW, await refusal({ errorKind: "rate_limit", rateLimit: { resetsAt: until } }), NOW)).toEqual({ until: NOW + 5 * HOUR, known: true });
  });

  test("with no end named, it is held an hour and said as not known: the sentence beside it is never read", async () => {
    // A real refusal at a model's own limit: the end was in its sentence alone ("resets Nov 19, 4pm").
    expect(limitOf(ROW, await refusal({ errorKind: "rate_limit" }), NOW)).toEqual({ until: NOW + UNSAID_END_MS, known: false });
    // An end already past is no end.
    expect(limitOf(ROW, await refusal({ errorKind: "rate_limit", rateLimit: { resetsAt: (NOW - HOUR) / 1000 } }), NOW)).toEqual({ until: NOW + UNSAID_END_MS, known: false });
  });

  test("not another failure, not a failure outside a message, not for a CLI whose row says nothing of limits", async () => {
    expect(limitOf(ROW, await refusal({ errorKind: "overloaded" }), NOW)).toBeNull();
    expect(limitOf(ROW, await refusal(undefined), NOW)).toBeNull();
    // The same data on a failure that was not a message's: a start that fails is not a limit.
    expect(limitOf(ROW, new AcpError(INTERNAL_ERROR, "session/new: Internal error", { errorKind: "rate_limit" }), NOW)).toBeNull();
    const { limit: _limit, ...plain } = ROW;
    expect(limitOf(plain as CliRow, await refusal({ errorKind: "rate_limit" }), NOW)).toBeNull();
  });
});

describe("the accounts an agent has", () => {
  test("its list in order, else its one profile, else the default", () => {
    expect(accountsOf(NIX.external)).toEqual(["rina", "work", "spare"]);
    expect(accountsOf(SOLO.external)).toEqual(["rina"]);
    expect(accountsOf({ cli: "claude-code" })).toEqual(["default"]);
  });
});

describe("a refused message", () => {
  test("marks the account for the model and says the move, to the next account in the agent's own order", async () => {
    const { turn, said, kept } = rotation();
    turn.started("nix", "rina");
    const note = turn.refused(ROW, NIX, await refusal({ errorKind: "rate_limit" }), "fable");
    expect(note).toBe("Account rina reached its limit for `fable`: it did not say until when. Nix goes on with work.");
    expect(kept()).toEqual({ "claude-code|rina|fable": { until: NOW + UNSAID_END_MS, known: false } });
    expect(said.map(([action]) => action)).toEqual(["cli_account_limited", "cli_account_moved"]);
    expect(said[1]![1]).toEqual({ cli: "claude-code", agent: "nix", from: "rina", to: "work", model: "fable" });
    // The turn that follows starts on the next account, and stays there.
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("work");
  });

  test("with an end the CLI named, says about how long; with no model named, the CLI's own", async () => {
    const { turn } = rotation();
    turn.started("nix", "rina");
    const until = (NOW + 5 * HOUR) / 1000;
    expect(turn.refused(ROW, NIX, await refusal({ errorKind: "rate_limit", rateLimit: { resetsAt: until } }), OWN_MODEL)).toBe("Account rina reached its limit: for about 5 hours more. Nix goes on with work.");
    // The turn that named no model is one on the CLI's own, and is moved as any other is.
    expect(turn.accountFor(ROW, NIX, OWN_MODEL)).toBe("work");
  });

  test("the failure as the runner throws it, the CLI's refusal its cause, is read the same", async () => {
    const { turn } = rotation();
    turn.started("nix", "rina");
    const thrown = new NourideError("external_agent", "Claude Code refused the message: …", "…", { cause: await refusal({ errorKind: "rate_limit" }) });
    expect(turn.refused(ROW, NIX, thrown, "fable")).toContain("Nix goes on with work.");
  });

  test("another failure marks nothing and moves nobody", async () => {
    const { turn, kept, said } = rotation();
    turn.started("nix", "rina");
    expect(turn.refused(ROW, NIX, await refusal({ errorKind: "overloaded" }), "fable")).toBeNull();
    expect(kept()).toEqual({});
    expect(said).toEqual([]);
  });

  test("an agent with the one account is marked and not moved: its failure says what it said", async () => {
    const { turn, kept } = rotation();
    turn.started("solo", "rina");
    expect(turn.refused(ROW, SOLO, await refusal({ errorKind: "rate_limit" }), "fable")).toBeNull();
    expect(Object.keys(kept())).toEqual(["claude-code|rina|fable"]);
  });

  test("an account that is not signed in is passed over; every account spent is said with each, and nothing is sent", async () => {
    const { turn } = rotation({ unusable: ["work"] });
    turn.started("nix", "rina");
    expect(turn.refused(ROW, NIX, await refusal({ errorKind: "rate_limit" }), "fable")).toContain("Nix goes on with spare.");
    turn.started("nix", "spare");
    const all = await refusal({ errorKind: "rate_limit" });
    const refusedLast = (() => {
      try {
        turn.refused(ROW, NIX, all, "fable");
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(refusedLast).toBe("Every account of Nix is at its limit for `fable`: rina (it did not say until when), work (not signed in), spare (it did not say until when).");
    // Known before a message is sent to be refused: the next turn on that model is not started at all, and says so.
    expect(() => turn.accountFor(ROW, NIX, "fable")).toThrow("spare (it did not say until when). Nothing was sent.");
    // Its own code: the agent is not one whose CLI cannot answer, and another model's turn goes on.
    const thrown = (() => {
      try {
        turn.accountFor(ROW, NIX, "fable");
      } catch (err) {
        return err as NourideError;
      }
    })();
    expect(thrown?.code).toBe(ACCOUNTS_SPENT);
    expect(turn.accountFor(ROW, NIX, "opus")).toBe("spare");
  });
});

describe("the account a turn starts on", () => {
  test("the first of its list, and the one it is on for as long as that is not at a limit for the turn's model", () => {
    const { turn } = rotation();
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("rina");
    turn.started("nix", "work");
    // On its second account and not limited there: it stays, though the first is free again.
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("work");
  });

  test("a limit is one model's: the same account goes on answering on another", async () => {
    const { turn } = rotation();
    turn.started("nix", "rina");
    turn.refused(ROW, NIX, await refusal({ errorKind: "rate_limit" }), "fable");
    expect(turn.accountFor(ROW, NIX, "opus")).toBe("rina");
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("work");
  });

  test("the mark is the account's, read by every agent on it; each agent moves by its own list", async () => {
    const { turn } = rotation();
    turn.started("nix", "rina");
    turn.started("nox", "rina");
    turn.refused(ROW, NIX, await refusal({ errorKind: "rate_limit" }), "fable");
    // Nox never failed: it starts its next turn on that model on its own next account, which is not Nix's.
    expect(turn.accountFor(ROW, NOX, "fable")).toBe("spare");
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("work");
    expect(turn.accountOf("nox")).toBe("rina");
  });

  test("a mark ends when its time comes, and is gone from what is kept", async () => {
    const { turn, kept, later } = rotation();
    turn.started("nix", "rina");
    turn.refused(ROW, NIX, await refusal({ errorKind: "rate_limit" }), "fable");
    turn.started("nix", "rina");
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("work");
    later(UNSAID_END_MS + 1);
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("rina");
    expect(kept()).toEqual({});
  });

  test("an account's marks in words, for where accounts are listed", async () => {
    const { turn } = rotation({ kept: { "claude-code|rina|fable": { until: NOW + 5 * 24 * HOUR, known: true }, "claude-code|rina|default": { until: NOW + HOUR, known: false } } });
    expect(turn.says("claude-code", "rina")).toEqual([
      "At its limit for `fable`: for about 5 days more.",
      // The CLI did not say until when: the hour is when it is tried again, said as that and not as its end.
      "At its limit: it did not say until when, and it is tried again within the hour.",
    ]);
    expect(turn.says("claude-code", "work")).toEqual([]);
  });

  test("marks are kept across a restart", () => {
    const { turn } = rotation({ kept: { "claude-code|rina|fable": { until: NOW + HOUR, known: true } } });
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("work");
    expect(turn.limitsOf("claude-code", "rina")).toEqual([{ model: "fable", until: NOW + HOUR, known: true }]);
    expect(turn.limitsOf("claude-code", "work")).toEqual([]);
  });

  test("a check that is not a turn, and an agent with the one account, stay where they are", async () => {
    const { turn } = rotation({ kept: { "claude-code|rina|fable": { until: NOW + HOUR, known: true } } });
    expect(turn.accountFor(ROW, NIX, undefined)).toBe("rina");
    expect(turn.accountFor(ROW, SOLO, "fable")).toBe("rina");
    // A check of an account that is not signed in is of that account: it is the check that says so, not passed over.
    expect(rotation({ unusable: ["rina"] }).turn.accountFor(ROW, NIX, undefined)).toBe("rina");
  });
});

describe("how much of an account's limits is used", () => {
  /** A count of the context as claude-agent-acp 0.107.0 sent one on the box, the windows' figures its own. */
  const update = (windows: unknown) => ({ sessionUpdate: "usage_update", used: 17_235, size: 1_000_000, _meta: { "_claude/rateLimit": { status: "allowed", resetsAt: 1794675000, rateLimitType: "five_hour", unifiedWindows: windows }, "_claude/model": "claude-sonnet-5-5" } });
  const USE = { use: { meta: "_claude/rateLimit", windows: "unifiedWindows", used: "utilization", resets: "resetsAt" } };
  const soon = (NOW + 3 * HOUR) / 1000;
  const later = (NOW + 5 * 24 * HOUR) / 1000;

  test("is read where the row says it is written: of the limits not started again yet, the fullest, with when it starts again", () => {
    const said = update({ five_hour: { utilization: 0.44, resetsAt: soon, status: "allowed" }, seven_day: { utilization: 0.52, resetsAt: later, status: "allowed" } });
    expect(useOf(USE, said, NOW)).toEqual({ used: 0.52, until: NOW + 5 * 24 * HOUR });
    expect(useOf(USE, update({ five_hour: { utilization: 0.91, resetsAt: soon }, seven_day: { utilization: 0.52, resetsAt: later } }), NOW)).toEqual({ used: 0.91, until: NOW + 3 * HOUR });
    // A limit that has started again since is no longer that full: the other one is what counts.
    expect(useOf(USE, update({ five_hour: { utilization: 0.99, resetsAt: (NOW - HOUR) / 1000 }, seven_day: { utilization: 0.2, resetsAt: later } }), NOW)).toEqual({ used: 0.2, until: NOW + 5 * 24 * HOUR });
  });

  test("is nothing where the update says none, the row names no place, or what is there is not a share and a time", () => {
    const good = { five_hour: { utilization: 0.95, resetsAt: soon } };
    expect(useOf({}, update(good), NOW)).toBeNull();
    expect(useOf(USE, { sessionUpdate: "usage_update", used: 1, size: 2 }, NOW)).toBeNull();
    expect(useOf(USE, { sessionUpdate: "usage_update", _meta: { "_claude/rateLimit": { status: "allowed" } } }, NOW)).toBeNull();
    expect(useOf(USE, update("full"), NOW)).toBeNull();
    expect(useOf(USE, update({ a: { utilization: "0.95", resetsAt: soon }, b: { utilization: 0.95 }, c: { utilization: -1, resetsAt: soon }, d: null, e: { utilization: Number.NaN, resetsAt: soon }, f: { utilization: 0.95, resetsAt: String(soon) } }), NOW)).toBeNull();
    expect(useOf(USE, null, NOW)).toBeNull();
  });
});

describe("near a limit, for an agent that asked to move on early", () => {
  const EARLY = { id: "nix", name: "Nix", external: { cli: "claude-code", profile: "rina", accounts: ["rina", "work", "spare"], moveAt: 90 } };
  const LATE = { id: "nox", name: "Nox", external: { cli: "claude-code", profile: "rina", accounts: ["rina", "spare"], moveAt: 97 } };
  const use = (used: number, hours = 3) => ({ used, until: NOW + hours * HOUR });

  test("at or past its mark the account is marked until that limit starts again, and its next turn starts on the next account, said first", () => {
    const { turn, said, kept } = rotation();
    turn.started("nix", "rina");
    turn.used(ROW, EARLY, use(0.89));
    expect(kept()).toEqual({});
    expect(turn.early(ROW, EARLY, "fable")).toBeNull();
    turn.used(ROW, EARLY, use(0.9));
    expect(kept()).toEqual({ "claude-code|rina|*": { until: NOW + 3 * HOUR, known: true, near: 0.9 } });
    // Whatever the model: the limit it is near is the account's.
    expect(turn.accountFor(ROW, EARLY, "opus")).toBe("work");
    expect(turn.early(ROW, EARLY, "fable")).toBe("Account rina has used 90% of a limit that starts again in about 3 hours. Nix goes on with work.");
    expect(said).toEqual([
      ["cli_account_near", { cli: "claude-code", account: "rina", used: 0.9, until: NOW + 3 * HOUR, agent: "nix" }],
      ["cli_account_moved", { cli: "claude-code", agent: "nix", from: "rina", to: "work", model: "fable", early: true }],
    ]);
    // On its next account nothing more is said, and what it is told of the first again changes the figure, not the log.
    turn.started("nix", "work");
    expect(turn.early(ROW, EARLY, "fable")).toBeNull();
    turn.started("nix", "rina");
    turn.used(ROW, EARLY, use(0.94));
    expect(said).toHaveLength(2);
    expect(turn.says("claude-code", "rina")).toEqual(["Near a limit, 94% of it used: it starts again in about 3 hours."]);
  });

  test("nothing is marked for an agent that did not ask, has the one account, or whose CLI said nothing or of a limit already over", () => {
    const { turn, kept } = rotation();
    turn.used(ROW, NIX, use(0.99));
    turn.used(ROW, { ...SOLO, external: { ...SOLO.external, moveAt: 50 } }, use(0.99));
    turn.used(ROW, EARLY, null);
    turn.used(ROW, EARLY, { used: 0.99, until: NOW - 1 });
    expect(kept()).toEqual({});
  });

  test("the mark is read by its own measure: an agent that did not ask stays, and one with a higher mark stays until its own", () => {
    const { turn } = rotation();
    for (const id of ["nix", "nox"]) turn.started(id, "rina");
    turn.used(ROW, EARLY, use(0.93));
    // Nix, with no mark of its own, and Nox, whose mark is 97: both stay on the account Nix's twin left.
    expect(turn.accountFor(ROW, NIX, "fable")).toBe("rina");
    expect(turn.accountFor(ROW, LATE, "fable")).toBe("rina");
    expect(turn.early(ROW, LATE, "fable")).toBeNull();
    turn.used(ROW, LATE, use(0.98));
    expect(turn.accountFor(ROW, LATE, "fable")).toBe("spare");
  });

  test("with every other account near a limit or at one, it stays where it is until the limit itself: near is not spent", async () => {
    const { turn } = rotation();
    turn.started("nix", "rina");
    turn.used(ROW, EARLY, use(0.95));
    turn.started("nix", "work");
    turn.used(ROW, EARLY, use(0.92));
    turn.started("nix", "spare");
    turn.used(ROW, EARLY, use(0.91));
    // All three near: it stays on the one it is on, and nothing is said of a move.
    expect(turn.accountFor(ROW, EARLY, "fable")).toBe("spare");
    expect(turn.early(ROW, EARLY, "fable")).toBeNull();
    // That one refused: it goes to the first that is merely near, which is not spent.
    expect(turn.refused(ROW, EARLY, await refusal({ errorKind: "rate_limit" }), "fable")).toBe("Account spare reached its limit for `fable`: it did not say until when. Nix goes on with rina.");
    // And a start with nothing chosen yet takes the first that is not at a limit, near or not.
    const fresh = rotation({ kept: { "claude-code|rina|*": { until: NOW + HOUR, known: true, near: 0.95 }, "claude-code|work|*": { until: NOW + HOUR, known: true, near: 0.95 }, "claude-code|spare|fable": { until: NOW + HOUR, known: true } } });
    expect(fresh.turn.accountFor(ROW, { ...EARLY, external: { ...EARLY.external, accounts: ["rina", "work"] } }, "fable")).toBe("rina");
  });

  test("a refused message moves it past an account that is near a limit, to one that is not", async () => {
    const { turn } = rotation({ kept: { "claude-code|work|*": { until: NOW + HOUR, known: true, near: 0.95 } } });
    turn.started("nix", "rina");
    expect(turn.refused(ROW, EARLY, await refusal({ errorKind: "rate_limit" }), "fable")).toContain("Nix goes on with spare.");
  });

  test("the mark ends when that limit starts again, and is kept across a restart with its share", async () => {
    const { turn, kept, later } = rotation();
    turn.started("nix", "rina");
    turn.used(ROW, EARLY, use(0.95, 1));
    later(HOUR + 1);
    expect(turn.accountFor(ROW, EARLY, "fable")).toBe("rina");
    expect(kept()).toEqual({});
    const { cliLimitsState } = await import("@/commons/daemon-state.ts");
    const { stateRows } = await import("../helpers.ts");
    const rows = stateRows();
    cliLimitsState(rows).save({ "claude-code|rina|*": { until: NOW + HOUR, known: true, near: 0.93 } });
    expect(cliLimitsState(rows).load()).toEqual({ "claude-code|rina|*": { until: NOW + HOUR, known: true, near: 0.93 } });
    const again = new AccountRotation({ file: cliLimitsState(rows), usable: () => true, now: () => NOW });
    expect(again.accountFor(ROW, EARLY, "fable")).toBe("work");
    // A share that is not a number is dropped, and the mark is then a refusal's.
    rows.set("cli-account-limits", JSON.stringify({ odd: { until: 9, known: true, near: "most" } }));
    expect(cliLimitsState(rows).load()).toEqual({ odd: { until: 9, known: true } });
  });
});

describe("the marks, where the daemon keeps its state", () => {
  test("kept across a restart; what is not a mark is left out, not taken for one", async () => {
    const { cliLimitsState } = await import("@/commons/daemon-state.ts");
    const { stateRows } = await import("../helpers.ts");
    const rows = stateRows();
    cliLimitsState(rows).save({ "claude-code|rina|fable": { until: NOW + HOUR, known: true } });
    // A daemon started again reads it, and an agent's next turn on that model starts on its next account.
    const again = new AccountRotation({ file: cliLimitsState(rows), usable: () => true, now: () => NOW });
    expect(again.accountFor(ROW, NIX, "fable")).toBe("work");
    // A row someone damaged: the entries that are not a time are dropped, and `known` is true only where it says so.
    rows.set("cli-account-limits", JSON.stringify({ good: { until: 5 }, bad: { until: "soon" }, worse: 7, loose: { until: 9, known: "yes" } }));
    expect(cliLimitsState(rows).load()).toEqual({ good: { until: 5, known: false }, loose: { until: 9, known: false } });
    expect(cliLimitsState(stateRows()).load()).toEqual({});
  });
});
