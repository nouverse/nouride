/**
 * Scheduled work — §8 SPEC, TD-011.
 *
 * The shape here is doing one job: keeping *three* questions apart that are constantly
 * conflated, and that produce wrong deliveries when they are merged.
 *
 * - **`target`** — which conversation the job is about. A `(gatewayId, chatId)` pair, the same
 *   address the whole engine already uses. A Discord channel, a WhatsApp group and a Telegram
 *   topic are all just a `chatId`; nothing here needs to know which.
 * - **`session`** — whose history the turn runs against. The chat's, or a private one.
 * - **`delivery`** — where the output goes. Usually the target, sometimes deliberately not:
 *   "watch this conversation, report to the ops channel" is a real request.
 *
 * A single "where" field would have to mean all three, and the first job that wants them to
 * differ then needs a new field anyway — with a migration and two years of rows that predate it.
 */

/**
 * A conversation, by instance id and chat id.
 *
 * `gatewayId` is the **instance** (`discord:main`), never the platform (`discord`). Sessions,
 * bindings and outbound messages are all keyed by instance, so a platform name here would pick
 * an arbitrary bot the moment a second one is configured — and the failure is silent: the
 * message goes somewhere, just not where it was meant to.
 */
export interface JobTarget {
  gatewayId: string;
  chatId: string;
}

export type JobTrigger =
  /**
   * One-shot, at an absolute instant.
   *
   * Epoch milliseconds rather than the ISO string §8 first specified. "Remind me in 2 hours"
   * has to become an instant *somewhere*, and doing it once at creation beats re-parsing a
   * string on every tick — and beats the ambiguity of an offset-less ISO string sitting in the
   * database for a week while the operator wonders which timezone read it.
   */
  | { kind: "at"; at: number }
  | { kind: "every"; everyMs: number }
  /** 5-field cron. `tz` is an IANA zone; absent means the daemon's configured timezone. */
  | { kind: "cron"; expr: string; tz?: string }
  /**
   * Never on the clock. Only when this job's endpoint is called.
   *
   * A trigger, not a schedule — and it lives in this union rather than in a subsystem of its own
   * because *when* a job fires is the only thing a webhook changes. `target`, `session`, `delivery`
   * and `payload` all mean exactly what they mean for a cron expression, and a parallel set of
   * them would be four types maintained twice, drifting the first time one of them grows a field.
   *
   * `nextRun` returns null for this, so `due()` never picks it up and the ticker never sees it.
   */
  | { kind: "webhook" }
  /**
   * Never on the clock and with no address: only when a person presses Run now, or an agent is asked to run it. A list
   * of steps somebody starts when they need it, where it had to be given a time it would never be wanted at.
   */
  | { kind: "manual" };

/**
 * What actually happens when a job is due.
 *
 * Four kinds and a list of them, and the split is about **cost**, not taste. A reminder that needs no thinking
 * should not cost a model call, and a script whose output needs interpreting should cost
 * exactly one — not a turn that spends its iterations discovering it has to run `exec` first.
 * Long work is a mission (0.8.0): it outlasts a turn, survives a restart and is checked.
 */
export type JobPayload =
  /** Text delivered as-is. No provider call at all — this works while the model is down. */
  | { kind: "systemEvent"; text: string }
  /** A full agent turn with tools. The expensive one; use it when the answer is not known yet. */
  | { kind: "agentTurn"; message: string; model?: string }
  /**
   * A command on the daemon host, run without a model.
   *
   * `then` decides what its output is worth: `"deliver"` posts stdout straight to the delivery
   * target for zero tokens, `"agentTurn"` opens one turn with the output already in hand.
   */
  | {
      kind: "command";
      argv: string[];
      cwd?: string;
      timeoutMs?: number;
      then: "deliver" | "agentTurn";
    }
  /**
   * Long work as a mission (0.8.0): every run starts one, as the person who turned the job on,
   * reporting to its chat — and ends at the reviewer, since that person accepted the work when they turned it on. One
   * run at a time; a webhook's body reaches the run's page as data.
   */
  | {
      kind: "mission";
      /** What each run is for: the mission's goal. */
      goal: string;
      /** Commands whose exit says the work is done. */
      checks?: string[];
      /** The reviewer's criteria in words; `false` for no review; absent: the goal itself. */
      review?: string | false;
    }
  /**
   * Several of the above, in order (`JobStep`): each step is handed what the one before said, and the last one's words
   * are the run's, delivered as the job says. A list a person reads top to bottom, with a branch where a step says
   * where the run goes next. No loop: an exit only ever points forward.
   */
  | { kind: "steps"; steps: JobStep[] };

/**
 * Where a run goes from a step: the step after it, the end of the run, or a later step by its id. Never an earlier one,
 * so a run always ends.
 */
export type StepGo = "next" | "end" | { to: string };

/** What every step has, whatever it does. */
interface StepCommon {
  /** Names the step within its job: what an exit points at and what a run's outcomes are kept by. */
  id: string;
  /** A person's name for it, shown on its card. */
  name?: string;
  /** Where the run goes when the step is done. Absent: the next step. */
  then?: StepGo;
  /**
   * Where it goes when the step failed. Absent: the run ends, failed, as a job of that one kind does. Going on hands
   * the failure to the step it goes to, so a step can be the one that tells somebody.
   */
  whenFailed?: StepGo;
  /**
   * Where it goes when the step had nothing to say: a command that printed nothing, an agent with nothing to report.
   * Absent: the run ends there, quietly, so a check that finds nothing wakes nobody.
   */
  whenEmpty?: StepGo;
}

/**
 * One step of a job that runs several. Each is what a job of one kind does, less what the list decides for it: a
 * command's `then` is the step after it.
 */
export type JobStep = StepCommon &
  (
    | /** Text sent as written to where the job reports. What the step before said goes on to the step after. */
    { kind: "systemEvent"; text: string }
    /** One turn, of the job's agent or of `agentId`: another agent reads what the step before said and starts fresh. */
    | { kind: "agentTurn"; message: string; model?: string; agentId?: string }
    /** A command with no model, in the job's agent's workspace. */
    | { kind: "command"; argv: string[]; cwd?: string; timeoutMs?: number }
    /**
     * A mission, started with what the step before said as its request. The run waits for it to end, however long that
     * is and across a restart, and hands its result on. One that failed or was stopped is a failed step.
     */
    | { kind: "mission"; goal: string; checks?: string[]; review?: string | false; agentId?: string }
    /**
     * A wait for a person: asked where the job reports and on the dashboard, with what the step before said. A yes hands
     * that on to the next step; a no, or no answer in `timeoutMs`, is the step's failed exit.
     */
    | { kind: "approval"; ask: string; timeoutMs?: number }
  );

/** How one step of a run went, kept on the run as it happens for whoever reads it. */
export interface StepOutcome {
  /** The step's id. */
  id: string;
  kind: JobStep["kind"];
  /**
   * `running` and `waiting` while the run is at it. `empty`: it had nothing to say. `declined` and `expired`: a person
   * said no, or nobody answered. `skipped` and `interrupted` as a run's own.
   */
  status: "running" | "waiting" | "done" | "failed" | "empty" | "declined" | "expired" | "skipped" | "interrupted";
  /** What it said, or why it failed, clipped. */
  said?: string;
  startedAt: number;
  /** How long it took, once it ended. */
  ms?: number;
  /** The mission it started. */
  missionId?: string;
  /** Who answered it, for a step that waited for a person. */
  by?: string;
}

/** What a run that waits is waiting for. */
export type RunWait =
  | { kind: "mission"; step: string; missionId: string; since: number }
  | { kind: "approval"; step: string; since: number; until: number; ask: string };

export type CronDeliveryMode = "announce" | "none" | "webhook";

export interface JobDelivery {
  mode: CronDeliveryMode;
  /** Both absent means "the job's target". Present overrides it — report elsewhere than you watch. */
  gatewayId?: string;
  chatId?: string;
  webhookUrl?: string;
}

/**
 * Whose conversation history the turn runs against.
 *
 * Three answers, and the difference between them is measured in tokens paid per run:
 *
 * - `"fresh"` — **no history at all.** The turn sees its own prompt and nothing else, and writes
 *   nothing back. A daily report does not benefit from remembering yesterday's report; it just pays
 *   to send it, and pays a second time to summarize it once the window fills. This is the default.
 * - `"isolated"` — a private history at `cron:<jobId>` on the same gateway, persisting across runs
 *   and never appearing in the human's transcript. For the job that genuinely builds on its last
 *   run: "carry on from where you left off". Subject to the same rollover policy as any other
 *   conversation, so it does not grow without end.
 * - `"chat"` — reads *and appends to* the target conversation. Contamination runs both ways: the job
 *   is prompted with whatever people were saying in that channel, and their next message carries the
 *   job's output. It was the default until it was measured on a live box — one Discord channel's
 *   session had reached 24k tokens of interleaved reports and conversation. Choose it deliberately,
 *   for a job that is genuinely part of the discussion.
 */
export type JobSessionMode = "chat" | "isolated" | "fresh";

export interface Job {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  trigger: JobTrigger;
  /**
   * The unguessable part of this job's webhook URL. Only present when `schedule.kind` is `webhook`.
   *
   * It *is* the credential — anyone holding it can fire the job — so it is generated, never chosen,
   * and rotatable without rebuilding the job. Kept on the job rather than in the secret store
   * because the dashboard has to be able to show the URL back: a webhook address nobody can read
   * after creation is one nobody can paste into GitHub.
   */
  webhookToken?: string;
  payload: JobPayload;
  delivery: JobDelivery;
  target: JobTarget;
  session: JobSessionMode;
  /**
   * Keep a one-shot job after it fires.
   *
   * Off by default: a `at` job that stays in the list after firing is a reminder that already
   * happened, and a list full of those is a list nobody reads.
   */
  keepAfterRun: boolean;
  /** A sender id, a dashboard actor, or `"cli"`. An audit trail that cannot name an actor is not one. */
  createdBy: string;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  failCount: number;
  /**
   * Failures since the last success.
   *
   * The safety backstop: a recurring job whose command was deleted fails forever, on trigger,
   * alerting every time. At the ceiling it disables itself and says why — an unattended thing
   * that cannot succeed should stop, not keep asking for attention.
   */
  failStreak: number;
  /** Set when the daemon disabled the job itself, so `enable` can tell that from an operator pause. */
  disabledReason?: string;
  /** A webhook's last test through its public address — what says whether it can arrive from the internet (0.8.0). */
  reachTest?: ReachTest;
  /** Proposed by an agent and not turned on yet (0.8.0): it stays off until a person turns it on from its card. */
  proposal?: JobProposal;
  /** Who turned it on from its card: whom its missions run as. */
  turnedOnBy?: string;
  /**
   * Whose it is: a person, as People writes an id (`web:<account id>`, `telegram:814…`). The account that made it, or
   * whoever turned its proposal on. Absent for one made from the command line or by the daemon, and for a proposal
   * nobody turned on yet: nobody's.
   */
  owner?: string;
  /**
   * What its runs may send out without being asked again (0.8.0): a person answered *always for this job* to an action
   * the guards held — a message to another chat, an MCP tool, a post to a host. Each names where, by key
   * (`chat:telegram:nouva:555`, `mcp:mail__send`, `host:hooks.slack.com`); anything else is still asked.
   */
  allowed?: JobAllowance[];
}

/** One standing yes on a job (0.8.0): where its runs may send, and who said so. */
export interface JobAllowance {
  /** Where, as `Tool.sendsOut` names it. A call passes when each of its destinations is allowed. */
  keys: string[];
  /** What was allowed, in words: "sends a message to the telegram one-to-one with Mira". */
  label: string;
  by: string;
  at: number;
}

/** An action a run's guards held with nobody there to ask (0.8.0) — on the run, for a person to allow always. */
export interface HeldAction {
  /** Where it would have sent, as an allowance names it — empty when that cannot be said, and then it cannot be allowed. */
  keys: string[];
  /** What it was, in words. */
  label: string;
  /** Why it was held — the guard's question. */
  reason: string;
}

/** A job an agent proposed (0.8.0, `modules/cron/proposals.ts`): who, where its card went, and for whom. */
export interface JobProposal {
  /** The agent that proposed it. */
  by: string;
  /** The chat its card was posted in, and the sender it was asked for: they or an admin may turn it on there. */
  gatewayId: string;
  chatId: string;
  for: string;
  at: number;
  /** The job it would change: turned on, that job takes this one's shape and keeps its history. */
  replaces?: string;
}

/**
 * One test of a webhook through the address it is handed out under (0.8.0): the daemon posts there, marked as a test,
 * and the route counts what arrives without running the job (`modules/web/hook-reach.ts`).
 */
export interface ReachTest {
  /** The address it was sent to. A test of another address — the token rotated, the public URL changed — says nothing. */
  url: string;
  at: number;
  /** Whether it reached this daemon. An answer from something else at that address is not arriving. */
  arrived: boolean;
  /** What a person reads: how long it took, or what happened instead. */
  detail: string;
}

export interface JobRun {
  id: string;
  jobId: string;
  startedAt: number;
  finishedAt?: number;
  /**
   * `interrupted`: cut off by a daemon restart — not a failure, and not reported as one. `running` while it is at work,
   * `waiting` while a step of it waits for a mission or a person: neither has a `finishedAt`.
   */
  status: "success" | "error" | "skipped" | "interrupted" | "running" | "waiting";
  result?: string;
  /** What its guards held with nobody there to ask (0.8.0): each can be allowed always for the job from its page. */
  held?: HeldAction[];
  /** How each step went, for a job of several: as many as were reached. */
  steps?: StepOutcome[];
  /** What it waits for, while it does. */
  waiting?: RunWait;
}
