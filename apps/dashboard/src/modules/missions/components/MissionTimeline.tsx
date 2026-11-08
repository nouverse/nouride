/**
 * The mission's turns as a timeline, newest first (0.8.8): each a point on one line, marked by what started it and
 * coloured by how it went — why in a person's words (`lib/timeline.ts`), the wait before it, its steps folded in the
 * pill the chat draws (which opens onto the turn's record), and what the agent wrote, three lines until asked for the
 * rest. The turn at work now is drawn with the chat's live feed, from the same conversation. It was a list of headings
 * and paragraphs, where a turn a model woke for a job's end read "[System event — not a message from a person…]".
 */

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Flag,
  Hourglass,
  Loader2,
  MessageSquarePlus,
  MessageSquareReply,
  Power,
  RotateCw,
  ShieldCheck,
  StepForward,
  Terminal,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ChatTurn, LiveTurn, TurnStatus } from "@nouride/wire";
import { Markdown } from "@/commons/components/ui/Markdown";
import { StepFeed, StepPill } from "@/commons/components/turns/Steps";
import { formatDuration, splitThinking } from "@/commons/lib/steps";
import { cn } from "@/commons/lib/utils";
import { reasonOf, timelineOf, type ReasonKind, type TimelineEntry } from "../lib/timeline";

const REASON_ICON: Record<ReasonKind, LucideIcon> = {
  start: Flag,
  // Forward, not down: the newest turn is at the top, and an arrow down read as pointing at the turn before.
  next: StepForward,
  person: User,
  told: MessageSquarePlus,
  answer: MessageSquareReply,
  job: Terminal,
  approval: ShieldCheck,
  working: Hourglass,
  retry: RotateCw,
  restart: Power,
  other: Circle,
};

/** What each reason means, on hovering its chip — "the next step" with an arrow left the owner asking what it meant. */
const REASON_SAID: Record<ReasonKind, string> = {
  start: "The mission's first turn: it writes its checklist, then begins.",
  next: "The turn before ended with work left, so the mission went on with its checklist.",
  person: "A person told it to go on, or answered its question.",
  told: "Its checks passed while a person had told it something it had not read yet, so it went one more turn to read it.",
  answer: "Another agent it asked answered, and this turn read the answer.",
  job: "A command or a helper it left running in the background ended.",
  approval: "A person answered a call it had asked them about.",
  working: "An agent it asked is still at work; this turn was told how long it has run.",
  retry: "Its model could not answer last time, so it tried again.",
  restart: "Nouride restarted while it worked, and it carried on from where it was.",
  other: "Nouride started this turn for a reason of its own.",
};

/** A point's colour is how its turn went: blue only for the one at work now, the rest are states (the design rules). */
const TONE: Record<TurnStatus, string> = {
  running: "bg-primary/15 text-primary ring-primary/35",
  done: "bg-success/12 text-success ring-success/30",
  failed: "bg-error/12 text-error ring-error/30",
  cancelled: "bg-base-content/[0.06] text-base-content/70 ring-base-content/15",
  interrupted: "bg-base-content/[0.06] text-base-content/70 ring-base-content/15",
};

const SAID: Record<TurnStatus, string> = { running: "working now", done: "ended", failed: "failed", cancelled: "stopped", interrupted: "cut off by a restart" };

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/** A turn's point: on the rail from `sm` up, and small at the start of its head on a phone (`inline`). */
function Point({ status, icon: Icon, inline = false }: { status: TurnStatus; icon: LucideIcon; inline?: boolean }) {
  const mark = (
    <span className={cn("grid place-items-center rounded-full ring-1", inline ? "size-5" : "size-7", TONE[status])}>
      {status === "running" ? <Loader2 size={inline ? 11 : 14} className="animate-spin" aria-hidden="true" /> : <Icon size={inline ? 11 : 14} aria-hidden="true" />}
      <span className="sr-only">{SAID[status]}</span>
    </span>
  );
  return inline ? <span className="shrink-0 sm:hidden">{mark}</span> : <div className="timeline-middle max-sm:hidden">{mark}</div>;
}

/** What a turn's point is: how it went, and what started it. */
type Mark = { status: TurnStatus; icon: LucideIcon };

/**
 * One point's line, with the lines to its neighbours: none above the newest, none below the oldest. Its point at the top
 * of the turn, not halfway down a long one: `--timeline-row-start`, the variable daisyUI's `timeline-snap-icon` sets —
 * the modifier itself is not combined with `timeline-compact`, whose one column it undoes.
 *
 * From `sm` up. On a phone the rail and its column took a seventh of the width inside the Turns card, beside the turn's
 * own border, before a step's command had any (0.8.12): there a turn is a block the card's width, its point at the start
 * of its head (`Head`).
 */
function Item({ first, last, status, icon, children }: Mark & { first: boolean; last: boolean; children: React.ReactNode }) {
  return (
    <li className="[--timeline-row-start:0.875rem]! max-sm:block">
      {!first && <hr className={cn("max-sm:hidden", status === "running" ? "bg-primary/40" : "bg-base-content/20")} />}
      <Point status={status} icon={icon} />
      <div className="timeline-end mb-4 w-full min-w-0 rounded-2xl border border-base-content/[0.08] bg-base-200/40 px-3 py-3 max-sm:m-0 max-sm:mb-3 sm:px-4">{children}</div>
      {!last && <hr className="bg-base-content/20 max-sm:hidden" />}
    </li>
  );
}

function Head({ mark, title, reason, icon: Icon, said, at, until }: { mark: Mark; title: string; reason: string; icon: LucideIcon; said: string; at: number; until?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Point status={mark.status} icon={mark.icon} inline />
      <span className="text-sm font-semibold tracking-tight text-base-content">{title}</span>
      <span className="tooltip tooltip-bottom max-w-full" data-tip={said}>
        <span className="badge badge-ghost badge-sm max-w-full gap-1 font-mono text-[11px] text-base-content/80">
          <Icon size={11} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{reason}</span>
          <span className="sr-only">: {said}</span>
        </span>
      </span>
      <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className="ml-auto font-mono text-[11px] tabular-nums text-base-content/65">
        {clock(at)}
        {until !== undefined && until !== at ? `–${clock(until)}` : ""}
      </time>
    </div>
  );
}

function Waited({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  return <p className="mt-1 font-mono text-[11px] text-base-content/65">{formatDuration(ms)} after the turn before</p>;
}

/** What the agent wrote, three lines until asked for the rest — a mission's turns are many, and most are read in passing. */
function Reply({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { content } = splitThinking(text);
  if (!content.trim()) return null;
  const long = content.length > 280 || content.split("\n").length > 3;
  return (
    <div className="mt-2 space-y-1">
      <div className={cn("text-sm leading-relaxed text-base-content/85 [overflow-wrap:anywhere]", long && !open && "line-clamp-3")}>
        <Markdown source={content} />
      </div>
      {long && (
        <button type="button" className="btn btn-ghost btn-xs h-6 max-sm:h-8 min-h-0 gap-1 rounded-lg px-1.5 text-[11px] text-base-content/65" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
          {open ? "Less" : "All of it"}
        </button>
      )}
    </div>
  );
}

function Pill({ turn }: { turn: ChatTurn }) {
  return (
    <div className="mt-2">
      <StepPill
        turnId={turn.id}
        status={turn.status}
        steps={turn.steps}
        {...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs })}
        toolCalls={turn.toolCalls}
        {...(turn.iterations === undefined ? {} : { iterations: turn.iterations })}
        {...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens })}
        {...(turn.outputTokens === undefined ? {} : { outputTokens: turn.outputTokens })}
        {...(turn.model ? { model: turn.model } : {})}
        {...(turn.error ? { error: turn.error } : {})}
      />
    </div>
  );
}

function Failure({ error }: { error: string | undefined }) {
  if (!error) return null;
  return <p className="mt-2 rounded-lg bg-error/[0.08] px-2.5 py-1.5 text-xs leading-relaxed text-error [overflow-wrap:anywhere]">{error}</p>;
}

function Entry({ entry, first, last }: { entry: TimelineEntry; first: boolean; last: boolean }) {
  if (entry.kind === "repeat") {
    const newest = entry.turns.at(-1)!;
    return (
      <Item first={first} last={last} status="failed" icon={X}>
        <Head mark={{ status: "failed", icon: X }} title={`Turns ${entry.from}–${entry.to}`} reason={`failed ${entry.turns.length} times`} icon={RotateCw} said="The same error ended each of these turns, so they are shown once." at={entry.turns[0]!.startedAt} until={newest.startedAt} />
        <Waited ms={entry.waitedMs} />
        <Failure error={entry.error} />
      </Item>
    );
  }
  const { turn, reason } = entry;
  return (
    <Item first={first} last={last} status={turn.status} icon={REASON_ICON[reason.kind]}>
      <Head mark={{ status: turn.status, icon: REASON_ICON[reason.kind] }} title={`Turn ${entry.number}`} reason={reason.text} icon={REASON_ICON[reason.kind]} said={REASON_SAID[reason.kind]} at={turn.startedAt} />
      <Waited ms={entry.waitedMs} />
      <Pill turn={turn} />
      {turn.status === "failed" && <Failure error={turn.error} />}
      <Reply text={turn.reply} />
    </Item>
  );
}

export function MissionTimeline({ turns, live }: { turns: ChatTurn[]; live: LiveTurn | undefined }) {
  if (turns.length === 0 && !live) return <p className="text-sm text-base-content/65">No turn yet. The first starts as soon as it has a slot.</p>;
  const entries = timelineOf(turns);
  const reason = live ? reasonOf(live) : null;
  return (
    <ul className="timeline timeline-vertical timeline-compact">
      {live && reason && (
        <Item first last={entries.length === 0} status={live.status} icon={REASON_ICON[reason.kind]}>
          <Head mark={{ status: live.status, icon: REASON_ICON[reason.kind] }} title={`Turn ${turns.length + 1}`} reason={reason.text} icon={REASON_ICON[reason.kind]} said={REASON_SAID[reason.kind]} at={live.startedAt} />
          <div className="mt-2">
            <StepFeed steps={live.steps} running={live.status === "running"} elapsedMs={live.status === "running" ? Math.max(0, Date.now() - live.startedAt) : (live.durationMs ?? 0)} />
          </div>
        </Item>
      )}
      {entries.map((entry, index) => (
        <Entry key={entry.kind === "turn" ? entry.turn.id : `repeat-${entry.from}`} entry={entry} first={!live && index === 0} last={index === entries.length - 1} />
      ))}
    </ul>
  );
}
