/**
 * One exchange on screen: what was asked, what the agent did, what it answered.
 *
 * A turn is drawn from the daemon's record, so the finished form and the live form differ only in what
 * is not there yet. That is deliberate — the old view built the two from different data and they
 * disagreed the moment the page reloaded.
 */

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Pencil, Square } from "lucide-react";
import { Markdown } from "@/commons/components/ui/Markdown";
import type { ChatTurn, LiveTurn, TurnAttachment, TurnCause, TurnStep } from "@nouride/wire";
import { AttachmentList } from "./Attachments";
import { saidWhileWorking, splitThinking } from "@/commons/lib/steps";
import { answersAnEdit, saidAsDrawn, systemHeading } from "@/commons/lib/turn-display";
import { StepPill } from "@/commons/components/turns/Steps";
import { LiveStepLine } from "@/commons/components/turns/StepLine";
import { CopyButton } from "@/commons/components/ui/CopyButton";
import { PersonMessage } from "@/commons/components/chat/PersonMessage";
import { AgentReply } from "@/commons/components/chat/AgentReply";
import { sectionTitle } from "@/commons/components/floating-chat/page-open";
import { TaggedText } from "@/commons/components/chat/AgentTag";

export function UserBubble({
  text,
  attachments,
  sessionId,
  edited,
  motion = "",
}: {
  text: string;
  /** What was sent with it. Images are shown; anything else is a row that opens in a new tab. */
  attachments?: TurnAttachment[];
  sessionId?: string;
  /** The person edited it after sending, and what is shown — and was answered — is how it reads now (`answersAnEdit`). */
  edited?: boolean;
  /** How it arrives (`useMotionList`), growing from its own corner. */
  motion?: string;
}) {
  const inbound = (attachments ?? []).filter((file) => file.direction !== "out");

  return (
    <div className={`flex flex-col items-end space-y-1.5 origin-bottom-right ${motion}`}>
      {sessionId && inbound.length > 0 && (
        <AttachmentList sessionId={sessionId} files={inbound} align="end" />
      )}
      {text && (
        // Mist, not the brand blue: the blue is for signals and actions, and a message is neither (the Nouverse design rules).
        <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-tr-xs bg-secondary/20 text-base-content px-4 py-3 text-sm shadow-xs font-normal leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          <TaggedText text={text} />
        </div>
      )}
      {edited && <EditedMark />}
    </div>
  );
}

/**
 * Under a message the person edited: quiet, in the metadata voice, because it is a fact about the message and not
 * something to act on. The words say it; the pencil is decoration.
 */
function EditedMark() {
  return (
    <span
      className="inline-flex items-center gap-1 pr-1 font-mono text-[10px] uppercase tracking-wider text-base-content/65"
      title="Edited after it was sent; answered as it reads now"
    >
      <Pencil className="w-3 h-3" aria-hidden="true" />
      edited
      <span className="sr-only">: answered as it reads now</span>
    </span>
  );
}

/**
 * The copy button under a reply: smaller and quieter than the shared one's default. Shown on hover from a tablet's width
 * up, and always on a phone, which has no hover to show it — it was there and could not be seen (0.8.12). So is a
 * conversation's delete in the history drawer. Drawn back by its own padding, so its icon starts where the answer's
 * words do, in the column beside the agent's cat, rather than a step to the right of them.
 */
const COPY_CLASS = "btn btn-ghost btn-xs h-6 max-sm:h-8 px-2 -ml-2 rounded-lg gap-1 text-[11px] text-base-content/65 hover:text-base-content";

/**
 * A turn the daemon started, not a person.
 *
 * A finished background job wakes the agent by putting a message into the conversation. Drawn as a
 * user bubble — which is what happened before this — it reads as the operator asking about a job they
 * never mentioned. So it is marked as what it is, and the harness's own text is there to open if you
 * want to see exactly what the agent was told.
 */
function SystemNote({ text, cause }: { text: string; cause?: TurnCause | undefined }) {
  const [open, setOpen] = useState(false);
  // From why the daemon started it, never from its words — see `systemHeading`.
  const heading = systemHeading(cause);

  return (
    <div className="flex flex-col items-center w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-base-200/70 hover:bg-base-300/70 border border-base-content/[0.08] text-[10px] font-mono text-base-content/65 hover:text-base-content/80 transition-all"
      >
        <span>⚙</span>
        <span className="uppercase tracking-wider font-semibold font-mono">{heading}</span>
        <span className="text-base-content/65">woke the agent</span>
      </button>
      {open && (
        <pre className="mt-2 max-w-xl w-full whitespace-pre-wrap break-words text-[10px] leading-relaxed text-base-content/65 bg-base-200/40 border border-base-content/[0.06] rounded-xl p-3 font-mono max-h-64 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

/**
 * What was said while the turn worked: a message the person sent it, read at its next step rather than after
 * the answer, and what they were told back at once — "↪ Got it", then a line in the agent's own words.
 *
 * Under the steps and above the answer, because that is when it happened: the answer was written after the
 * message was read. In a room the message is a bubble of the room's own, drawn where it was said, so here it is
 * only quoted — enough to say what the lines under it answer, without drawing it twice.
 */
function SaidWhileWorking({ steps, quote }: { steps: TurnStep[]; quote: boolean }) {
  const said = saidWhileWorking(steps);
  if (said.length === 0) return null;
  return (
    <div className="w-full space-y-1.5 py-1">
      {said.map((step) => {
        const { text, edited } = saidAsDrawn(step);
        return step.kind === "steer_reply" ? (
          <p
            key={step.seq}
            className="w-fit max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-tl-xs border border-base-content/[0.06] bg-base-200/70 px-3.5 py-2 text-[13px] leading-relaxed text-base-content/75 whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            <TaggedText text={step.text} />
          </p>
        ) : quote ? (
          <p
            key={step.seq}
            className="max-w-[85%] sm:max-w-[75%] line-clamp-2 border-l-2 border-primary/40 pl-2.5 text-xs leading-relaxed text-base-content/65 [overflow-wrap:anywhere]"
          >
            {edited && <span className="font-mono text-[10px] uppercase tracking-wider">edited · </span>}
            <TaggedText text={text} />
          </p>
        ) : (
          <UserBubble key={step.seq} text={text} edited={edited} />
        );
      })}
    </div>
  );
}

/**
 * What a turn was asked: a wake-up as the daemon's note, a person on a chat app on the left under their name, and in the
 * dashboard's own conversation the reader's own bubble.
 */
function Asked({ turn, sessionId, asker }: { turn: ChatTurn; sessionId: string; asker: string | undefined }) {
  if (turn.system) return <SystemNote text={turn.prompt} cause={turn.cause} />;
  if (asker !== undefined) {
    const inbound = (turn.attachments ?? []).filter((file) => file.direction !== "out");
    return (
      <PersonMessage name={asker} text={turn.prompt} files={sessionId && inbound.length > 0 ? <AttachmentList sessionId={sessionId} files={inbound} /> : null}>
        {answersAnEdit(turn) ? <EditedMark /> : null}
      </PersonMessage>
    );
  }
  return (
    <UserBubble
      text={turn.prompt}
      sessionId={sessionId}
      edited={answersAnEdit(turn)}
      {...(turn.attachments?.length ? { attachments: turn.attachments } : {})}
    />
  );
}

/** A turn that is over. */
export function TurnView({
  turn,
  sessionId,
  showPrompt,
  asker,
  motion = "",
}: {
  turn: ChatTurn;
  /** In a conversation on a chat app: who asked, drawn on the left under their name rather than as the reader's own. */
  asker?: string | undefined;
  sessionId: string;
  /**
   * How its answer arrives (`useMotionList`). On the answer only: the question above it was drawn as it was sent, and
   * moving it again would read as sending it twice.
   */
  motion?: string;
  /**
   * False in a room, where the question is drawn from the room's own messages.
   *
   * A turn restating its prompt is right in a one-to-one chat, where the turn *is* the exchange. In
   * a room it draws the same message once per agent that answered it — two bubbles for one thing
   * somebody typed — and it cannot draw a message nobody answered at all.
   */
  showPrompt?: boolean;
}) {
  const { thinking, content } = splitThinking(turn.reply);
  // A turn can end with nothing to say — stopped, interrupted, refused — and the record knows which.
  // Silence with no explanation is the impression this daemon spent a session learning not to give.
  const fallback =
    turn.status === "running"
      ? "_working…_"
      : turn.status === "cancelled"
      ? "_stopped_"
      : turn.status === "interrupted"
        ? "_Nouride restarted while this answer was being written_"
        : turn.status === "failed"
          ? `_${turn.error ?? "the turn failed"}_`
          : "";

  return (
    <div className="space-y-3">
      {showPrompt === false ? null : <Asked turn={turn} sessionId={sessionId} asker={asker} />}
      {/* Whose answer this is, by its cat and its name, with its steps and its words in the column beside them. The
          agent is passed in rather than taken from a "current agent": in a room there is no such thing. */}
      <AgentReply agentId={turn.agentId} motion={motion}>
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
          {...(thinking ? { thinking } : {})}
          {...(turn.error ? { error: turn.error } : {})}
        />
        <SaidWhileWorking steps={turn.steps} quote={showPrompt === false} />
        <div className="w-full min-w-0 text-sm leading-relaxed text-base-content/90 [overflow-wrap:anywhere]">
          <Markdown source={content || fallback} />
        </div>
        {/* What the agent sent back with `send_file`. Under the answer, because that is where the
            sentence about it is. */}
        <AttachmentList
          sessionId={turn.sessionId ?? sessionId}
          files={(turn.attachments ?? []).filter((file) => file.direction === "out")}
        />
        <MadePages steps={turn.steps} />
        {content && (
          <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex items-center gap-2">
            <CopyButton text={content} className={COPY_CLASS} />
          </div>
        )}
      </AgentReply>
    </div>
  );
}

/**
 * What the turn made or changed that has a page of its own (`tool_done.page`: an automation proposed, a mission
 * started), one press away under the answer. The page is the daemon's word, not read out of the agent's: an agent
 * that forgot to say where it put something still leaves a way to it. In the chat that floats over a page the link
 * opens under the chat, which stays.
 */
function MadePages({ steps }: { steps: TurnStep[] }) {
  const pages = [...new Set(steps.flatMap((step) => (step.kind === "tool_done" && step.page ? [step.page] : [])))];
  if (pages.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {pages.map((page) => (
        // A path the daemon handed over, which no route's type knows.
        <Link key={page} to={page as "/"} className="btn btn-xs h-7 gap-1.5 rounded-full border-0 bg-secondary/10 text-secondary hover:bg-secondary/20">
          Open in {sectionTitle(page) || "the dashboard"}
          <ArrowRight size={12} aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}

/**
 * The answer, revealed at a readable pace.
 *
 * The daemon writes the reply into the record as the provider streams it — but a provider does not
 * stream evenly. Measured on the live box: a 3,300-character answer arrived as two lumps, 1,781
 * characters and then the rest, which on screen is not streaming at all. It is a page of text
 * appearing twice.
 *
 * So the text is paced here. It only ever *catches up* — a proportional chase, so a big lump is
 * absorbed in under a second and a trickle is followed immediately — and it snaps to the whole thing
 * the moment the turn is over. Nothing is ever withheld from a finished answer.
 */
function useTypewriter(target: string, live: boolean): string {
  const [shown, setShown] = useState(() => (live ? 0 : target.length));

  useEffect(() => {
    if (!live) {
      setShown(target.length);
      return;
    }
    if (shown >= target.length) {
      // A new turn, or a reply that was replaced by a shorter one (the empty-turn notice). Start over
      // rather than leaving the tail of the last answer on screen.
      if (shown > target.length) setShown(target.length);
      return;
    }
    const frame = setTimeout(() => {
      setShown((previous) => {
        const remaining = target.length - previous;
        // Proportional, with a floor: fast where there is a lot to say, still moving where there is not.
        return previous + Math.max(3, Math.ceil(remaining / 8));
      });
    }, 16);
    return () => clearTimeout(frame);
  }, [target, live, shown]);

  return target.slice(0, live ? shown : target.length);
}

/**
 * A turn that is happening.
 *
 * The steps as they arrive, and the answer as it is written — both read from the record, which is why
 * this survives a reload and why a second tab shows the same thing. The elapsed clock ticks locally
 * from the daemon's `startedAt`, so it is right even for a turn that started before this page opened.
 */
export function LiveTurnView({
  turn,
  sessionId,
  showPrompt,
  asker,
  onStop,
  motion = "",
}: {
  turn: LiveTurn;
  /** Who asked, on a chat app — see `TurnView`. */
  asker?: string | undefined;
  sessionId: string;
  /** How its answer arrives — see `TurnView`. */
  motion?: string;
  /** False in a room — see `TurnView`. */
  showPrompt?: boolean;
  /** Cancels this one agent. Absent where there is nothing to stop. */
  onStop?: (agentId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (turn.status !== "running") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn.status]);

  const { content } = splitThinking(turn.reply);
  const running = turn.status === "running";
  const revealed = useTypewriter(content, running);

  return (
    <div className="space-y-3">
      {showPrompt === false ? null : <Asked turn={turn} sessionId={sessionId} asker={asker} />}
      {/*
        Whose work this is, by its cat and its name above the steps, from before its first word: most of a turn's visible
        life is spent there, and in a room with two agents at work that is when the reader needs to know who is thinking.
      */}
      <AgentReply
        agentId={turn.agentId}
        motion={motion}
        aside={
          // Stopping *this* agent, from the card that is showing its work. A room can have several turns at once, so
          // the composer's single button had to mean "stop everything", which is rarely what somebody watching one
          // card wants.
          onStop && turn.status === "running" ? (
            <button
              type="button"
              onClick={() => onStop(turn.agentId)}
              className="btn btn-ghost btn-xs h-5 max-sm:h-8 min-h-0 gap-1 rounded-lg px-1.5 text-[10px] max-sm:text-xs text-base-content/65 hover:text-error"
              title={`Stop ${turn.agentId}`}
            >
              <Square size={9} className="fill-current" /> stop
            </button>
          ) : null
        }
      >
        <LiveStepLine
          steps={turn.steps}
          running={turn.status === "running"}
          // The daemon's own clock while it runs, and the recorded duration once it is over — so the
          // number stops moving at the value the record will keep.
          elapsedMs={
            turn.status === "running" ? Math.max(0, now - turn.startedAt) : (turn.durationMs ?? 0)
          }
        />
        <SaidWhileWorking steps={turn.steps} quote={showPrompt === false} />
        {revealed && (
          <>
            <div className="w-full min-w-0 text-sm leading-relaxed text-base-content/90 [overflow-wrap:anywhere]">
              <Markdown source={revealed} />
              {running && (
                <span className="inline-block w-1.5 h-4 bg-primary rounded-xs ml-1 animate-pulse align-middle" />
              )}
            </div>
            <AttachmentList
              sessionId={turn.sessionId ?? sessionId}
              files={(turn.attachments ?? []).filter((file) => file.direction === "out")}
            />
          </>
        )}
        {/* As soon as the call that made it is done, before the answer says so. */}
        <MadePages steps={turn.steps} />
      </AgentReply>
    </div>
  );
}

/** An exchange older than the oldest kept turn: text, and whatever the messages implied. */
export function EarlierMessage({
  message,
}: {
  message: { role: "user" | "assistant"; content: string; steps?: { text: string }[] };
}) {
  if (message.role === "user") return <UserBubble text={message.content} />;
  // No face and no name: these predate turn records, which is where the agent id lives. Drawing one would mean
  // guessing, and a room's transcript is the one place a wrong name matters most. The column keeps its place.
  return (
    <AgentReply>
      <div className="w-full min-w-0 text-sm leading-relaxed text-base-content/90 [overflow-wrap:anywhere]">
        <Markdown source={message.content} />
      </div>
      <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex items-center gap-2">
        <CopyButton text={message.content} className={COPY_CLASS} />
      </div>
    </AgentReply>
  );
}
