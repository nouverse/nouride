/**
 * What the Missions pages decide about a mission, apart from drawing it: what a person sees it as, what they can say to
 * it now, how far it is against each limit, and why each of its turns started. Pure, so each decision is tested on its
 * own (`tests/missions-lib.test.ts`) — the daemon refuses a verb that does not apply with a 409, and a button offered
 * for one is a press that only ever fails.
 */

import type { ChatTurn, MissionSeen, MissionView, MissionWaitKind } from "@nouride/wire";
import { systemHeading } from "@/commons/lib/turn-display";

/** What a person sees, in their words. */
const SEEN_LABEL: Record<MissionSeen, string> = {
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
  ended: "Ended",
};

/** What a waiting mission needs from a person — the second half of "Needs you · …". */
const NEEDS: Record<MissionWaitKind, string> = {
  approval: "approval",
  input: "a question",
  stuck: "stuck",
  unknown_outcome: "unknown outcome",
  limit: "a limit",
  accept: "accept",
  retry: "paused, retrying",
};

/** The badge's tone: blue is something working, the rest are states (the Nouverse design rules). */
export const SEEN_TONE: Record<MissionSeen, string> = {
  working: "bg-primary/10 text-primary border-primary/25",
  needs_you: "bg-warning/15 text-warning border-warning/30",
  done: "bg-success/10 text-success border-success/25",
  ended: "bg-base-content/[0.06] text-base-content/70 border-base-content/15",
};

/**
 * The words on a mission's badge: "Needs you · a question", "Working", "Ended · failed". A mission waiting in the queue is
 * working as a person sees it, and says it is queued; one running its checks says so. A draft (0.8.11) waits on an accept
 * that starts it, and says "draft": "Needs you · accept" read as a result to sign off, the chat's notice and the page's
 * buttons saying Draft, Start it and Drop it.
 */
export function seenAs(mission: Pick<MissionView, "seen" | "status" | "waitKind" | "startedAt">): string {
  if (mission.seen === "needs_you" && mission.waitKind === "accept" && mission.startedAt === null) return `${SEEN_LABEL.needs_you} · draft`;
  if (mission.seen === "needs_you") return mission.waitKind ? `${SEEN_LABEL.needs_you} · ${NEEDS[mission.waitKind]}` : SEEN_LABEL.needs_you;
  if (mission.seen === "ended") return `${SEEN_LABEL.ended} · ${mission.status === "failed" ? "failed" : "stopped"}`;
  if (mission.status === "queued") return `${SEEN_LABEL.working} · queued`;
  if (mission.status === "checking") return `${SEEN_LABEL.working} · checking`;
  return SEEN_LABEL[mission.seen];
}

export type MissionAction = "stop" | "continue" | "accept" | "acceptAsIs" | "answer" | "delete";

/** Continue lets it go on past what stopped it — never past a question, which takes an answer. */
const CONTINUES: readonly MissionWaitKind[] = ["limit", "stuck", "unknown_outcome", "accept", "retry"];

/**
 * What a person can say to a mission now, in the order the page offers them. Each only when the daemon would take it:
 * Stop until it has ended; Continue while it waits on a limit, a loop, a call whose outcome a restart lost, or an
 * accept; Accept while it waits for one; Answer while it waits on its question; and, waiting on anything else, Accept as
 * it is — closed as done without its checks passing (0.8.7), the way out of a mission stuck on a check it can never pass.
 */
export function actionsFor(mission: Pick<MissionView, "status" | "waitKind">): MissionAction[] {
  const actions: MissionAction[] = [];
  const waiting = mission.status === "waiting" ? mission.waitKind : null;
  if (waiting === "input") actions.push("answer");
  if (waiting === "accept") actions.push("accept");
  if (waiting && CONTINUES.includes(waiting)) actions.push("continue");
  if (waiting && waiting !== "accept") actions.push("acceptAsIs");
  if (mission.status !== "done" && mission.status !== "failed" && mission.status !== "stopped") actions.push("stop");
  // Only once it has ended (0.8.13): the daemon refuses one still open, and Stop is the step before.
  else actions.push("delete");
  return actions;
}

export interface Meter {
  label: string;
  /** How much is used, as written: "2 of 5", "1h 12m of 8h". */
  said: string;
  /** 0–1, for the bar; null when there is nothing to measure against yet. */
  share: number | null;
  /** At or past the share the daemon warns at (`WARN_AT`, 80%). */
  near: boolean;
  /** No bar at all: no limit holds, or the count is not known — an empty bar read as none used. */
  bar?: false;
}

/** At this share of a limit the daemon tells the chat, once — and the meter turns. */
const WARN_AT = 0.8;

function share(used: number, limit: number): number | null {
  return limit > 0 ? Math.min(1, Math.max(0, used / limit)) : null;
}

/** `1h 05m`, `12m`, `0m` — whole minutes; hours of work are not read to the second. */
function hoursWorked(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/** `8h`, `1h 30m`, `45m` — a limit in hours and minutes: one raised from where a mission stood is no long float (0.8.8). */
function hoursLimit(hours: number): string {
  const minutes = Math.round(hours * 60);
  return minutes % 60 === 0 ? `${minutes / 60}h` : hoursWorked(minutes * 60_000);
}

/** `50M`, `1.2M`, `350k` — tokens at the scale a mission spends them. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * The four meters a mission's page shows: its checklist, and each limit it stops at — turns, hours worked, tokens. The
 * checklist counts a skipped step as settled, as the daemon's progress line does. Turns say the steps they took: a turn
 * is a whole round of work, and "2 of 100" alone read as two actions (0.8.0).
 *
 * A coding CLI's mission is held to no turn limit, so its turns are a count with no bar — "2 turns · 215 steps", where
 * msn_53b16d read "2 of 100" — and its tokens are unknown where the CLI reports none, at least a count where it reported
 * for some turns only (0.8.8).
 */
export function meters(
  mission: Pick<MissionView, "turnsUsed" | "tokensUsed" | "workedMs" | "limits" | "shown">,
  plan: { steps: { state: string }[] } | null,
  steps?: number,
): Meter[] {
  const total = plan?.steps.length ?? 0;
  const settled = plan?.steps.filter((step) => step.state === "done" || step.state === "skipped").length ?? 0;
  const turns = share(mission.turnsUsed, mission.limits.turns);
  const hours = share(mission.workedMs, mission.limits.hours * 3_600_000);
  const spent = share(mission.tokensUsed, mission.limits.tokens);
  const stepsSaid = steps ? ` · ${steps} step${steps === 1 ? "" : "s"}` : "";
  return [
    { label: "Checklist", said: total > 0 ? `${settled} of ${total}` : "no checklist yet", share: total > 0 ? settled / total : null, near: false },
    mission.shown.turns
      ? { label: "Turns", said: `${mission.turnsUsed} of ${mission.limits.turns}${stepsSaid}`, share: turns, near: (turns ?? 0) >= WARN_AT }
      : { label: "Turns", said: `${mission.turnsUsed} turn${mission.turnsUsed === 1 ? "" : "s"}${stepsSaid}`, share: null, near: false, bar: false },
    { label: "Hours", said: `${hoursWorked(mission.workedMs)} of ${hoursLimit(mission.limits.hours)}`, share: hours, near: (hours ?? 0) >= WARN_AT },
    mission.shown.tokens === "unknown"
      ? { label: "Tokens", said: `unknown of ${tokens(mission.limits.tokens)} (its coding CLI reports none)`, share: null, near: false, bar: false } // plain-words-ok: tokens, the unit a model's use is billed in
      : {
          label: "Tokens", // plain-words-ok: tokens, the unit a model's use is billed in
          said: `${mission.shown.tokens === "partial" ? "at least " : ""}${tokens(mission.tokensUsed)} of ${tokens(mission.limits.tokens)}`,
          share: spent,
          near: (spent ?? 0) >= WARN_AT,
        },
  ];
}

/**
 * Why a turn of a mission started. Each starts from the mission's page, whose `Why this turn:` line the daemon writes
 * from what woke it — the start, a *continue*, an answer, a failed check, a restart. A turn a job's end woke says so in
 * its cause, as a chat's would; and the page's line is read before it, being the more exact.
 */
export function whyStarted(turn: Pick<ChatTurn, "prompt" | "cause" | "system">): string {
  const line = /^Why this turn: (.+)$/m.exec(turn.prompt)?.[1]?.trim();
  // The page writes for the model, with tool names in backticks; a person reads them as words.
  if (line) return line.replace(/\.$/, "").replace(/`([^`]+)`/g, "$1");
  if (turn.cause && turn.cause.via !== "mission") return systemHeading(turn.cause);
  return "Nouride started this turn";
}

/** The mission's id as people read it, and as `nouride mission` and `/mission` take it — `msn_3f2a91…`. */
export function shortId(id: string): string {
  return id.slice(0, 10);
}

/**
 * The list's tabs: every mission, the two a person acts on, and the three ways one finishes — done, failed, stopped
 * (0.8.0). One Finished tab held all three, and finding why the stopped ones stopped meant reading every row.
 */
export type MissionTab = "all" | "needs_you" | "working" | "done" | "failed" | "stopped";

/** Which tab a mission is under: needs you, working, or how it finished. */
export function tabOf(mission: Pick<MissionView, "seen" | "status">): Exclude<MissionTab, "all"> {
  if (mission.seen === "needs_you" || mission.seen === "working") return mission.seen;
  return mission.status === "failed" ? "failed" : mission.status === "stopped" ? "stopped" : "done";
}

/** How long a mission's name may be before it is cut at a word. */
const TITLE_MAX = 90;

/**
 * A mission's name, from its goal (0.8.0): its first sentence, cut at a word near 90 characters. A goal is often a
 * paragraph — a job's run, an agent's own — and drawn whole as the page's title it was a wall of large type. The goal
 * itself is still on the page, and still what the search looks in.
 */
export function missionTitle(goal: string): string {
  const flat = goal.replace(/\s+/g, " ").trim();
  const first = /^.+?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  if (first.length <= TITLE_MAX) return first;
  const cut = first.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Needs you, then working, then the rest — the daemon's order, kept as three groups to draw under their headings. */
export function grouped(missions: readonly MissionView[]): { needsYou: MissionView[]; working: MissionView[]; finished: MissionView[] } {
  return {
    needsYou: missions.filter((m) => tabOf(m) === "needs_you"),
    working: missions.filter((m) => tabOf(m) === "working"),
    finished: missions.filter((m) => m.seen === "done" || m.seen === "ended"),
  };
}

/**
 * What the list's search looks in: the goal, the agent, the id as a chat names it (`msn_7ae26b`), and the line its row
 * shows — so the words of a report, of why it ended or of the question it waits on find it too.
 */
export function searchedIn(mission: MissionView): (string | null | undefined)[] {
  return [mission.goal, mission.agentId, mission.id, rowLine(mission)?.text];
}

/** Whether anything here can still change — what decides how often the page asks again. */
export function anyOpen(missions: readonly Pick<MissionView, "seen">[]): boolean {
  return missions.some((m) => m.seen === "working" || m.seen === "needs_you");
}

/**
 * The list row's last line: the step it is on while it works, what it waits for while it needs you, its report or why
 * it ended once it has — or null when there is nothing worth a line.
 */
export function rowLine(mission: MissionView): { label: string; text: string } | null {
  if (mission.seen === "needs_you") return { label: "Needs you", text: needsYouSaid(mission) };
  if (mission.seen === "working") {
    if (mission.status === "queued") return { label: "Queued", text: mission.reason ?? "waits for a free slot" };
    if (mission.status === "checking") return { label: "Now", text: "running its checks" };
    const active = mission.checklist?.active;
    return { label: "Now", text: active ?? (mission.checklist ? "between steps" : "writing its checklist") };
  }
  if (mission.seen === "done") return mission.report ? { label: "Report", text: mission.report } : null;
  return mission.reason ? { label: "Why", text: mission.reason } : null;
}

/**
 * What a waiting mission needs from a person, in a sentence — the words its chat notice uses (`notices.ts` in the
 * engine), with the page's buttons where the chat names commands. `reason` is what the wait is about: the question,
 * the limit, the calls parked, the report.
 */
export function needsYouSaid(mission: Pick<MissionView, "waitKind" | "reason" | "startedAt" | "byAgent" | "agentId" | "checks">): string {
  const about = mission.reason?.trim() ?? "";
  switch (mission.waitKind) {
    case "input":
      return about ? `It asks: ${about}` : "It asked a question.";
    case "approval":
      return `Nothing else can move until you answer ${about || "the calls it parked"}.`;
    case "limit":
      return `It reached ${about || "a limit"}. Continue raises that limit by what Limits sets for it; Stop ends it.`;
    case "accept":
      if (mission.startedAt === null) return `A draft by ${mission.byAgent ?? mission.agentId}: nothing runs until you Start it. Drop it removes it, with its folder.`;
      return `Its work is done${mission.checks.length > 0 ? " and its checks passed" : ""}. Accept the result, or Continue with what is missing.`;
    case "unknown_outcome":
      return `A restart cut it off in the middle of ${about || "a call"}, and whether that ran is unknown. Check, then Continue or Stop.`;
    case "stuck":
      return `It is stuck: ${about || "no step moved"}. Continue to try again, Stop to end it.`;
    case "retry":
      return `Its model could not answer${about ? `: ${about}` : ""}. It tries again by itself, further apart each time, for about a day. Continue tries now.`;
    default:
      return about || "It waits for a person.";
  }
}

/** A result file as people read it: where it is in the mission's folder, not the whole path. */
export function inFolder(file: string, workdir: string): string {
  const folder = `${workdir.replace(/\/+$/, "")}/`;
  return file.startsWith(folder) ? file.slice(folder.length) : file;
}

/**
 * The Brief card's file and where it is (0.8.11): its own folder's `BRIEF.md`, or a file its goal names — the owner asked
 * to open a brief as a report is, by its file's name.
 */
export function briefShown(path: string | null | undefined, missionId: string): { name: string; said: string } {
  const own = !path || path.endsWith(`/missions/${missionId}/BRIEF.md`);
  const name = path?.split("/").pop() || "BRIEF.md";
  return own ? { name, said: "Kept in its folder: each turn starts from it, beside the goal." } : { name, said: `Named in its goal: ${path}` };
}
