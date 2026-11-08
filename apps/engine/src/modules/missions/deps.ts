/**
 * What the missions need from the daemon (`missions.ts`): their store and settings, the agents, the pipeline's queue,
 * the chat a mission reports to, and the helpers that check and review its work — each handed in at boot
 * (`boot/missions.ts`), so a mission is tested without a daemon.
 */

import type { ApprovalStatus, MessageButton, MessageEnvelope } from "@nouride/shared";
import type { NotesPort } from "@/modules/notes/store.ts";
import type { Review } from "./checking.ts";
import type { CheckResult } from "./checks.ts";
import type { MissionsPort } from "./missions.store.ts";
import type { Parked } from "./page.ts";
import type { MissionsInForce } from "./slots.ts";
import type { SteerOutcome } from "./tell.ts";
import type { Mission, Told } from "./types.ts";

export interface MissionsDeps {
  store: MissionsPort;
  /** `[missions]`, read when it matters — a change from the dashboard reaches the next decision — the slots resolved. */
  settings: () => MissionsInForce;
  /** The agents: whether one exists, whether it is asleep, and its own folder. */
  agents: { exists(agentId: string): boolean; asleep(agentId: string): boolean; privateDir(agentId: string): string };
  /** The conversations' work notes: a mission's checklist, and the chat task it was started from (`carry.ts`). */
  notes?: NotesPort;
  /** A mission's running jobs — its commands and helpers report to its conversation — and stopping one. */
  jobs?: { running(agentId: string): { id: string; gatewayId: string; chatId: string }[]; kill(id: string, why: string): boolean };
  /** The approvals a mission has parked and nobody has answered yet. */
  parked: (mission: Mission) => Parked[];
  /** How its approvals settled since a moment: answered by a person — approved or denied — or expired unanswered. */
  settled?: (mission: Mission, since: number) => readonly ApprovalStatus[];
  /**
   * Withdraw them, when it ends: a stopped mission's question was kept across a restart on the live box and asked
   * again in the chat, where answering it would only have woken nothing.
   */
  withdraw?: (mission: Mission) => void;
  /**
   * An external agent's CLI session for the mission let go when it ends: kept, it was in the sessions file for good and
   * open in the CLI until the CLI stopped — a session a mission long, for every mission (0.8.1).
   */
  letGoCli?: (mission: Mission) => void;
  /**
   * Say something in the chat a mission reports to, as its agent — with buttons under it where the chat carries them
   * (a question's options, 0.8.7). Never throws.
   */
  tell: (mission: Mission, text: string, buttons?: MessageButton[]) => Promise<void>;
  /**
   * A progress line (0.8.7): where the chat can edit what it was sent, the mission's one progress message is rewritten
   * rather than a new one sent each time. Absent: `tell`.
   */
  progress?: (mission: Mission, text: string) => Promise<void>;
  /** A turn of a mission's conversation, into the pipeline's queue. False when it could not be queued. */
  queueTurn: (envelope: MessageEnvelope) => boolean;
  /** Stop a mission's turn that is running now. */
  stopTurn: (mission: Mission) => void;
  /**
   * A person's words (`tell`, 0.8.10) into the mission's turn at work, read before its next step — or why not: no turn
   * at work, past what one turn reads, past its last step. Absent: kept for the next turn.
   */
  steerTurn?: (mission: Mission, told: Told) => SteerOutcome;
  /**
   * Why a start's `branch` cannot be its worktree's in the repository `workdir` is in, as its agent's git says — or
   * null (`worktree.ts` `branchRefusal`).
   */
  branchRefusal: (request: { agentId: string; workdir: string; branch: string }) => Promise<string | null>;
  /** Make a mission's folder, as its agent — and, where it moved into a worktree of its own, where it now works. */
  prepare: (mission: Mission) => Promise<string | void>;
  /** Run a mission's checks in its folder, as its agent. */
  check: (mission: Mission) => Promise<CheckResult>;
  /** Why a check would not run unattended, as the gate answers for its agent — or null. Asked at the start (`start.ts`). */
  checkRefusal?: (request: { agentId: string; workdir?: string }, command: string) => string | null;
  /** A brief file's text as the daemon reads it, for the English check at start (0.8.8); null where it cannot. */
  readBrief?: (path: string) => string | null;
  /** A mission changed status — the event stream's row (`mission`). */
  changed?: (mission: Mission) => void;
  /** What lasts of a mission that ended, filed once as an episode of its agent's memory, from its report. */
  remember?: (mission: Mission) => Promise<void>;
  /**
   * Remove an ended mission's own folder, past `KEEP_MS` — only ever the folder the daemon made for it. `keepUnsaved`:
   * not where a worktree in it holds work nobody committed — those worktrees are named, and nothing is removed.
   */
  remove?: (mission: Mission, how?: { keepUnsaved: boolean }) => Promise<string[]>;
  /**
   * The free megabytes where missions work, when they are below the daemon's disk warning — null when there is room or
   * it cannot be read. Low, an ended mission's folder goes an hour after it ended instead of a week.
   */
  diskLow?: () => number | null;
  /**
   * When it ends (0.8.7): the worktrees it made itself inside its folder removed — not the daemon's own, which stay
   * with its branch. What holds uncommitted work is kept and named.
   */
  tidy?: (mission: Mission) => Promise<{ removed: string[]; kept: string[] }>;
  /** Whether an agent's turns are a coding CLI's (0.8.7): its missions are held to time and tokens, not turns. */
  runsOnCli?: (agentId: string) => boolean;
  /** Whether nothing asks before the agent deletes (0.8.8): a coding CLI in the `folder` preset. Its page says so. */
  freeToDelete?: (agentId: string) => boolean;
  /** Tokens the mission's helpers spent since a moment, metered under its conversation (0.8.7). */
  helperTokens?: (mission: Mission, since: number) => number;
  /**
   * What its coding CLI's turn running now has spent so far, estimated from what the CLI says of its context (0.8.8) —
   * 0 where none runs. Counted at the turn's end as the CLI reports it; until then, what its token limit reads.
   */
  runningTokens?: (mission: Mission) => number;
  /**
   * What the person it runs for last wrote in the chat it reports to (0.8.8) — its page quotes it, so what reaches them
   * is in their language. Null where they wrote nothing there: a webhook's, a job's.
   */
  personSaid?: (mission: Mission) => string | null;
  /** When a turn started — the chat's turn that started a mission, whose work alone moves into it (`carry.ts`). */
  turnStartedAt?: (turnId: string) => number | null;
  /** The repository a folder's work belongs to, a worktree followed to its source (`decide.ts` `sourceRepositoryOf`). */
  sourceRepository?: (workdir: string) => string;
  /**
   * The result files of a mission that is done, sent to its chat as files; the names of those that could not be. What
   * git tracks in its worktree stays on its branch (0.8.11).
   */
  deliver?: (mission: Mission) => Promise<string[]>;
  /**
   * A draft's folder made as its agent, and its brief written there as `BRIEF.md` when one is given (0.8.11,
   * `drafts.ts`): whether the brief is there now. Its worktree waits for the start, as before.
   */
  draftFolder?: (mission: Mission, brief?: string) => Promise<boolean>;
  /** Its `BRIEF.md`, where there is one: the path a turn's page names, and the dashboard shows (0.8.11). */
  briefOf?: (mission: Mission) => string | null;
  /** A brief its goal names, inside its agent's own folder — the dashboard's, where it has no `BRIEF.md` (`goalBrief`). */
  goalBriefOf?: (mission: Mission) => string | null;
  /** Its page's link for the chat it reports to, or null where none goes there (`web/links.ts`, 0.8.11). */
  pageOf?: (mission: Mission) => string | null;
  /** Its report sent to its chat as `report.md` (0.8.11): null once sent, else why it was not. */
  sendReport?: (mission: Mission) => Promise<string | null>;
  /** What a person allowed a job's runs to send without asking again (`Job.allowed`'s keys) — a job's mission reads it each turn. */
  jobAllowed?: (jobId: string) => readonly string[];
  /** The reviewer: a fresh context on the agent's high tier, holding only the tools that read (`checking.ts`); `earlier`, the notes of a pass that ran out of time. */
  review?: (mission: Mission, earlier?: string) => Promise<Review>;
  now?: () => number;
}
