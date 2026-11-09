/**
 * Memory's nightly pass, on a clock — `docs/SPEC.md` §12.2.
 *
 * `modules/memory` knows how to cut and file conversations and nothing about providers; this file is
 * the other half. It decides **when** (once a day at `[memory] pass_at` in the daemon's time zone,
 * and only while no turn is running), **with what** (each episode's agent's own provider and model,
 * unless `[memory]` names others), and **whether it may spend** (today's `[llm.limits]`, and the
 * night's own `[memory] pass_max_tokens`, checked before each episode — a night over budget stops,
 * and is never counted as a failed attempt, so an episode is not given up on because the money ran out).
 *
 * And **whether the box has room** (0.8.0): the scheduled night waits while the machine is busy
 * (`commons/box-load.ts`) — its start, each conversation, and each batch of the embedding after it — for
 * `NIGHT_ROOM_MS` in all at most. A pass somebody asked for by hand is theirs, and never waits.
 *
 * Every call is recorded in the usage table like any request, so the pass shows up where spend is
 * read and counts toward the same ceilings.
 */

import { contained, createLogger, helperModel, type GlobalConfig, type SystemBlock } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { SqliteDb } from "@nouride/runtime";
import { todaysVerdict } from "@/modules/llm/budget.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import { meter, metered } from "@/modules/llm/metered.ts";
import { orOwnModel } from "@/modules/llm/helper-model.ts";
import { PASS_CALL_FAILED } from "@/modules/llm/helper-trouble.ts";
import { atLocal, localTime, startOfLocalDay } from "@/commons/clock.ts";
import type { BoxBusy } from "@/commons/box-load.ts";
import { RoomWait } from "@/commons/room-wait.ts";
import type { Memory } from "@/modules/memory/index.ts";
import type { PassReport } from "@/modules/memory/run.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";

const log = createLogger("memory.pass");

/** How often the clock is looked at. The pass itself runs once a day. */
const TICK_MS = 60_000;
/** Enough for a summary, a few tags and a handful of facts; a longer answer is a model rambling. */
const MAX_OUTPUT_TOKENS = 1_500;
/**
 * The most a scheduled night waits for room on the box, in all — a design constant, not a measurement. Two hours gives
 * a night's backup or build room to finish, and from the default `pass_at` (01:00) the pass still runs that night,
 * hours before the day's conversations. A box busy for longer is busy as a rule, and a day not filed is worse than a
 * slower night.
 */
const NIGHT_ROOM_MS = 2 * 3_600_000;

export interface MemoryPassDeps {
  config: GlobalConfig;
  registry: Pick<AgentRegistry, "enabled">;
  providers: Pick<ProviderRegistry, "get">;
  usage?: Pick<UsagePort, "record" | "since">;
  turns?: Pick<TurnsPort, "runningSessions">;
  memory: Pick<Memory, "passing" | "pass" | "embedCatchUp" | "passRuns" | "backlog" | "releaseVectors">;
  /** The database, for the one thing the night is the right time for — see `settleWal`. */
  db?: Pick<SqliteDb, "checkpoint">;
  /** Whether the machine is busy, for the scheduled night to wait while it is. Absent, it never waits. */
  load?: BoxBusy;
  /** How often a night waiting in the middle of its work looks again (`room-wait.ts`). Lowered in tests. */
  roomCheckMs?: number;
  now?: () => number;
}

/**
 * What a run's own model calls used, in tokens, in and out — as each call reported them, `estimated` when a provider
 * reported none and the count is this daemon's own. Its embeddings are not in it: they are the semantic provider's.
 */
export interface PassSpend {
  tokens: number;
  estimated: boolean;
}

/**
 * `why` a run was refused, for words of another reader (0.8.20): the dashboard's are worded at its route from it, while
 * `refused` stays the CLI's.
 */
export type RunResult = { report: PassReport & { spent: PassSpend } } | { refused: string; why: "off" | "running" | "spend" };

/** What the dashboard shows about the pass, from its record in the database — a restart keeps it. */
export interface PassStatus {
  enabled: boolean;
  at: string;
  timeZone: string;
  running: boolean;
  /** When the run going on now started. */
  runningSince?: number;
  /** The day the scheduled pass last started, in the daemon's time zone. */
  lastDay: string | null;
  /** `spent` is absent from a run recorded before 0.7.12. `scheduled`: the night's, not one asked for by hand. */
  lastRun: ({ startedAt: number; finishedAt: number; scheduled: boolean } & Omit<PassReport, "failed"> & { failed: number; spent?: PassSpend }) | null;
  /** When the scheduled pass runs next; null while it is off. */
  next: NextRun | null;
}

/** The next scheduled run: its time, and whether that time has come and the pass waits for running turns to end. */
export interface NextRun {
  at: number;
  due: boolean;
}

export interface MemoryPass {
  timer: ReturnType<typeof setInterval>;
  /** Run now — `nouride memory pass`, the dashboard's Run now. */
  run(): Promise<RunResult>;
  /** A model call on the pass's terms, for work outside the pass that needs one — forgetting someone, the tags' groups. */
  ask(prompt: { system: string; user: string }, maxTokens?: number): Promise<string | null>;
  status(): PassStatus;
}

/**
 * Whether a run has used the tokens `[memory] pass_max_tokens` gives a night — the reason it stops before the next
 * conversation, or null to go on. `0` sets no limit. Pure.
 */
function nightSpent(spent: PassSpend, cap: number): string | null {
  if (cap <= 0 || spent.tokens < cap) return null;
  const used = `${spent.tokens.toLocaleString("en-US")}${spent.estimated ? ", estimated where a provider reported none" : ""}`;
  return `tonight's ${cap.toLocaleString("en-US")} tokens for the pass are used (${used}). The rest wait for the next night; [memory] pass_max_tokens sets it`;
}

/** Whether the pass should start on this tick: not yet today, at or past `at`, and nothing running. Pure. */
export function isDue(input: { now: number; timeZone: string; at: string; lastDay: string | null; running: number }): string | null {
  const clock = localTime(input.now, input.timeZone);
  if (clock.day === input.lastDay || clock.time < input.at || input.running > 0) return null;
  return clock.day;
}

/**
 * When the scheduled pass runs next: today at `at` while today has not had it — `due` once that time has passed and it
 * waits for the turns running to end — else tomorrow at `at`. Pure.
 */
export function nextRun(input: { now: number; timeZone: string; at: string; lastDay: string | null }): NextRun {
  const today = localTime(input.now, input.timeZone).day;
  if (input.lastDay !== today) {
    const at = atLocal(today, input.at, input.timeZone);
    return { at, due: at <= input.now };
  }
  // A day and a half past midnight is tomorrow whatever the clock does in between, a DST change included.
  const tomorrow = localTime(startOfLocalDay(input.now, input.timeZone) + 36 * 3_600_000, input.timeZone).day;
  return { at: atLocal(tomorrow, input.at, input.timeZone), due: false };
}

export function startMemoryPass(deps: MemoryPassDeps): MemoryPass {
  const now = deps.now ?? Date.now;
  const { config } = deps;
  let running = false;
  let runningSince: number | null = null;

  function budgetRefusal(): string | null {
    const verdict = todaysVerdict(deps.usage, config, now());
    return verdict.action === "refuse" ? verdict.message : null;
  }

  /**
   * The episode's agent's provider and model, unless `[memory]` names both — and the agent's again when those cannot
   * answer; any enabled agent's for an episode whose agent is gone. What the call used goes into `spent` too, when a run
   * is counting.
   */
  async function ask(agentId: string, prompt: { system: string | SystemBlock[]; user: string }, maxTokens = MAX_OUTPUT_TOKENS, spent?: PassSpend): Promise<string | null> {
    const agents = deps.registry.enabled();
    const agent = agents.find((candidate) => candidate.config.id === agentId) ?? agents[0];
    if (!agent) return null;
    const own = { profile: agent.config.llm.provider, model: agent.config.llm.model };
    // A tier (0.8.0) is this agent's own model of it, on its own provider — `pass_provider` is never beside one.
    const tier = config.memory.passProvider ? "" : helperModel(config.memory.passModel, agent.config.llm, config.llm.defaults);
    const route = config.memory.passProvider ? { profile: config.memory.passProvider, model: config.memory.passModel } : tier ? { ...own, model: tier } : own;
    // Asked of a pass, and of a person's forget or tag suggestion alike — none of them past a cap.
    const refused = budgetRefusal();
    if (refused) {
      log.warn("memory call skipped: over today's cap", { agent_id: agent.config.id, reason: refused });
      return null;
    }
    try {
      const client = (profile: string) => metered(deps.providers.get(profile), meter(deps.usage, { agentId: agent.config.id, provider: profile, purpose: "memory" }));
      // A pass model that cannot answer is asked of the agent's own instead (`helper-model.ts`): while one was gone, every
      // conversation the pass tried to file failed, and waited for a night that would fail the same way.
      const provider = orOwnModel({ ...route, provider: client(route.profile) }, { ...own, provider: () => client(own.profile) }, "memory pass");
      const response = await provider.chat({
        model: route.model,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        maxTokens,
        temperature: 0,
      });
      if (spent) {
        spent.tokens += response.usage.inputTokens + response.usage.outputTokens;
        spent.estimated ||= response.usage.estimated === true;
      }
      return response.text;
    } catch (err) {
      // Read back by `/health` and doctor (`helper-trouble.ts`), with the model it was asked of.
      log.warn(PASS_CALL_FAILED, { agent_id: agent.config.id, provider: route.profile, model: route.model, error: String(err) });
      return null;
    }
  }

  /**
   * The write-ahead log emptied, once a pass's writing is done — `TRUNCATE`, after the pass and the
   * embedding that follows it.
   *
   * SQLite's autocheckpoint keeps the log bounded while the day runs; the nightly pass is the one moment
   * that is reliably idle, and so the one where waiting for readers costs nobody anything. Skipped when a
   * turn is running, which is the case the pass's own idle check exists for — and the reason a pass
   * asked for by hand can take the same step. Never a reason for a pass to fail: the log stays bounded
   * by `journal_size_limit` either way.
   */
  function settleWal(): void {
    if (!deps.db || (deps.turns?.runningSessions().size ?? 0) > 0) return;
    try {
      const result = deps.db.checkpoint("TRUNCATE");
      if (result.busy) log.warn("the write-ahead log could not be emptied: a reader held it", { ...result });
      else log.info("write-ahead log emptied", { frames: result.log });
    } catch (err) {
      log.warn("could not empty the write-ahead log", { error: String(err) });
    }
  }

  /**
   * Said in the journal after a night that leaves what waits more than a week's filing at the count set (`backlog.ts`):
   * the operator who reads only the log learns it the morning it starts, with the count that would.
   */
  function warnIfBehind(): void {
    try {
      const backlog = deps.memory.backlog();
      if (backlog.enough === null) return;
      log.warn("the nightly pass is not keeping up", {
        waiting: backlog.waiting,
        oldest: backlog.oldest,
        pass_per_night: backlog.perNight,
        per_day: Object.fromEntries(backlog.agents.map((row) => [row.agent || "(no agent)", row.perDay])),
        days: backlog.days,
        enough: backlog.enough,
      });
    } catch (err) {
      log.warn("could not tell whether the nightly pass keeps up", { error: String(err) });
    }
  }

  /** The night's wait for room on the box: one a scheduled day, so its ceiling counts the whole night's waiting. */
  let night: { day: string; room: RoomWait } | null = null;
  function roomFor(day: string): RoomWait | null {
    if (!deps.load) return null;
    if (night?.day !== day) {
      const room = new RoomWait(deps.load, { what: "the nightly memory pass", ceilingMs: NIGHT_ROOM_MS, now, ...(deps.roomCheckMs ? { everyMs: deps.roomCheckMs } : {}) });
      night = { day, room };
    }
    return night.room;
  }

  /** A run: the nightly one, with its wait for room, or one asked for by hand (`nouride memory pass`, Run now). */
  async function run(scheduled = false, room: RoomWait | null = null): Promise<RunResult> {
    if (!deps.memory.passing()) return { refused: "the nightly pass is off ([memory] pass is false)", why: "off" };
    if (running) return { refused: "a pass is already running", why: "running" };
    const refusal = budgetRefusal();
    if (refusal) return { refused: refusal, why: "spend" };
    running = true;
    const startedAt = now();
    runningSince = startedAt;
    // Written before any work, so a restart halfway through does not start the same night over.
    const runId = deps.memory.passRuns.started({ startedAt, day: localTime(startedAt, config.daemon.timezone).day, scheduled });
    // The night's own budget, beside the day's: counted from this run's calls, read before each conversation — the
    // count still bounds a night per agent, and this bounds what a raised count may spend.
    const spent: PassSpend = { tokens: 0, estimated: false };
    // Before each conversation, and each batch of the embedding after them, while the box is busy.
    const roomed = room ? () => room.wait() : undefined;
    try {
      const filed = await deps.memory.pass(
        (agentId, prompt) => ask(agentId, prompt, MAX_OUTPUT_TOKENS, spent),
        () => budgetRefusal() ?? nightSpent(spent, config.memory.passMaxTokens),
        roomed,
      );
      const report = { ...filed, spent: { ...spent } };
      log.info("memory pass done", { cut: report.cut, filed: report.filed, failed: report.failed.length, applied: report.applied, proposed: report.proposed, tidied: report.tidied, compacted: report.compacted, restored: report.restored, waiting: report.waiting, tags: report.tags, problems: report.problems.length, tokens: report.spent.tokens, ...(report.spent.estimated ? { estimated: true } : {}), ...(report.stopped ? { stopped: report.stopped } : {}) });
      warnIfBehind();
      // Drift, said where an operator reads: a night coining a tag for more than a third of what it filed.
      if (report.filed >= 3 && report.tags.created * 3 > report.filed) log.warn("the pass coined many new tags tonight: a changed model or prompt, or a vault to tidy", { created: report.tags.created, filed: report.filed, tags: report.newTags.map((entry) => entry.tag) });
      for (const failure of report.failed) log.warn("memory could not file a conversation", failure);
      deps.memory.passRuns.finished(runId, { ...report, failed: report.failed.length });
      // Last, and never a reason for the pass to fail or to keep its caller waiting: what was just filed
      // gets its vectors in the background. After a tag tidy that is every conversation it retagged —
      // hundreds, minutes of embedding — and `nouride memory pass` timed out on an answer it already had.
      void deps.memory
        .embedCatchUp(roomed)
        .then((embedded) => {
          if (embedded && (embedded.embedded || embedded.pruned)) log.info("memory embedded", { ...embedded });
        })
        // Said where it happened (`embedCatchUp`), for this caller and the routes alike.
        .catch(() => null)
        .finally(settleWal);
      return { report };
    } finally {
      running = false;
      runningSince = null;
    }
  }

  /**
   * A daemon with no record of any night — a fresh install, or the first boot of the version that
   * began keeping one — counts from the next night when today's pass time has already gone by. Not a
   * surprise pass minutes after an upgrade, paid for by whoever just restarted it; "Run now" is there
   * for anyone who wants one.
   */
  if (!deps.memory.passRuns.hasScheduledRun()) {
    const clock = localTime(now(), config.daemon.timezone);
    if (clock.time >= config.memory.passAt) deps.memory.passRuns.skipped({ at: now(), day: clock.day });
  }

  // A minute whose look fails — the pass's record or the turn table unreadable — is logged, and the next looks again.
  const timer = setInterval(contained(log, "could not look at whether the nightly pass is due", () => {
    // Memory's one look a minute: what search by meaning holds and has not read for a while is let go here, with no
    // timer of its own — pass or no pass.
    deps.memory.releaseVectors();
    if (!deps.memory.passing()) return;
    const day = isDue({
      now: now(),
      timeZone: config.daemon.timezone,
      at: config.memory.passAt,
      lastDay: deps.memory.passRuns.lastScheduledDay(),
      // Idle means no turn anywhere: a pass competes with a person for the same provider, and loses
      // nothing by waiting a minute.
      running: deps.turns?.runningSessions().size ?? 0,
    });
    if (!day) return;
    // A busy box skips the minute, as a running turn does — until the night has waited the most it waits.
    const room = roomFor(day);
    if (room && !room.ready()) return;
    void run(true, room).catch((err) => log.error("memory pass failed", { error: String(err) }));
  }), TICK_MS);

  return {
    timer,
    run: () => run(false),
    ask: (prompt, maxTokens) => ask(deps.registry.enabled()[0]?.config.id ?? "", prompt, maxTokens),
    status: () => {
      const last = deps.memory.passRuns.lastFinished();
      const lastDay = deps.memory.passRuns.lastScheduledDay();
      const enabled = deps.memory.passing();
      return {
        enabled,
        at: config.memory.passAt,
        timeZone: config.daemon.timezone,
        running,
        ...(runningSince !== null ? { runningSince } : {}),
        lastDay,
        lastRun: last?.finishedAt
          ? { startedAt: last.startedAt, finishedAt: last.finishedAt, scheduled: last.scheduled, ...(last.report as Omit<PassReport, "failed"> & { failed: number }) }
          : null,
        next: enabled ? nextRun({ now: now(), timeZone: config.daemon.timezone, at: config.memory.passAt, lastDay }) : null,
      };
    },
  };
}
