/**
 * The step breakdown, in the two places it appears.
 *
 * `StepPill` is the finished form — `✓ 11 steps · 3m 44s`, collapsed until asked. `StepFeed` is the
 * live one, open while the turn runs. Both render the same rows from the same daemon-supplied data,
 * which is the point: what you watched happen is what you can still read afterwards.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { TurnStep, TurnStatus } from "@/commons/lib/api";
import { TurnRecord } from "@/commons/components/turns/TurnRecord";
import {
  countedSteps,
  formatDuration,
  formatElapsed,
  reasoningText,
  statusMark,
  stepIcon,
  stepRows,
  turnTokens,
  workSteps,
  type StepRowModel,
} from "@/commons/lib/steps";

/**
 * The tool calls, in a box that scrolls rather than grows: a turn of forty calls used to push the
 * answer and the composer off the screen. Pinned to the newest row while the turn runs, unless the
 * reader has scrolled up to look at an earlier one.
 */
function StepList({ follow, children }: { follow?: unknown; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const box = ref.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [follow]);
  return (
    <div
      ref={ref}
      onScroll={(event) => {
        const box = event.currentTarget;
        pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      }}
      className="max-h-72 space-y-1.5 overflow-y-auto overscroll-contain pr-1"
    >
      {children}
    </div>
  );
}

/**
 * One tool call, on one line.
 *
 * The call on the left, and on the right what the daemon said about it — `exit 1 · 3ms` — where the
 * duration used to sit. `stepRows` explains why the two rows became one; what matters here is the
 * colour: a non-zero exit is *muted*, because `which` exits 1 to say "not installed" and three rows
 * of red on a screen where nothing was wrong is what made a working turn look broken.
 */
function StepRow({ row, active }: { row: StepRowModel; active?: boolean }) {
  const isThought = row.kind === "reasoning";
  const spinning = active || row.running;
  const said = Boolean(row.outcome) || row.waitedMs !== undefined;
  return (
    <div
      className={`p-2 rounded-lg border text-[11px] flex flex-wrap items-start gap-x-2 gap-y-1 sm:flex-nowrap ${
        spinning
          ? "bg-primary/5 border-primary/20"
          : "bg-base-100/80 border-base-content/[0.05]"
      } ${isThought ? "text-base-content/65 italic" : "text-base-content/85"}`}
    >
      <span className="shrink-0 text-sm mt-0.5">
        {spinning ? (
          <Loader2 size={13} className="animate-spin text-primary" />
        ) : (
          stepIcon(row)
        )}
      </span>
      {/* A width of its own: a long outcome on the right squeezed the call's name to a letter a line (0.8.1). On a
          phone that width was still a column of twelve letters — a command broken every few characters beside
          "Bash ok: …" (0.8.12) — so there the outcome is the row's first line and the call is the whole width under it. */}
      <div className={`min-w-20 flex-1 break-all leading-relaxed ${said ? "max-sm:order-last max-sm:basis-full" : ""}`}>{row.text}</div>
      <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[10px] mt-0.5 max-sm:flex-1 sm:max-w-[45%]">
        {row.waitedMs !== undefined && (
          // The model deciding what to call, which is most of a slow turn and was previously shown in
          // the duration column as though the call itself had taken that long.
          <span className="shrink-0 text-base-content/65" title="the model was deciding for this long first">
            +{formatDuration(row.waitedMs)}
          </span>
        )}
        {/* A coding CLI's says what its call returned, a line long: cut here, whole on hover — two lines on a phone,
            which has no hover. */}
        <span className={`min-w-0 max-sm:line-clamp-2 max-sm:[overflow-wrap:anywhere] sm:truncate ${row.failed ? "text-error/70" : "text-base-content/65"}`} title={row.outcome}>
          {row.outcome ?? ""}
        </span>
      </span>
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  return (
    <div className="space-y-1 border-b border-base-content/[0.06] pb-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-primary font-mono">
        Its reasoning
      </span>
      <p className="text-[11px] text-base-content/75 whitespace-pre-wrap bg-base-100/60 p-2.5 rounded-lg leading-relaxed max-h-64 overflow-y-auto">
        {text}
      </p>
    </div>
  );
}

/** What a turn is made of, plus the model's working. Shared by both forms. */
function Breakdown({
  steps,
  thinking,
  activeSeq,
}: {
  steps: TurnStep[];
  thinking?: string;
  activeSeq?: number;
}) {
  const reasoning = thinking?.trim() || reasoningText(steps);
  const visible = stepRows(steps);

  return (
    <div className="mt-2 p-2 sm:p-3 rounded-2xl bg-base-200/50 border border-base-content/[0.08] text-xs font-mono space-y-2 max-w-xl">
      {/* Why, then what: the reasoning reads as the plan the calls below carried out. */}
      {reasoning ? <Reasoning text={reasoning} /> : null}

      <p className="text-[10px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
        Steps ({visible.length})
      </p>

      {visible.length === 0 ? (
        <div className="p-2 rounded-lg bg-base-100/60 text-[11px] text-base-content/75 flex items-center gap-2">
          <span>🧠</span>
          <span>Answered without using a tool</span>
        </div>
      ) : (
        <StepList>
          {visible.map((row) => (
            <StepRow key={row.seq} row={row} active={row.seq === activeSeq} />
          ))}
        </StepList>
      )}
    </div>
  );
}

/**
 * The finished pill.
 *
 * `11 steps · 3m 44s` where the duration is the daemon's, not a stopwatch the page started — which is
 * why it still says `3m 44s` after a reload instead of `1s`.
 */
export function StepPill({
  turnId,
  status,
  steps,
  durationMs,
  toolCalls,
  iterations,
  inputTokens,
  outputTokens,
  model,
  thinking,
  error,
}: {
  /** Whose record to read once opened: each model call, what each request carried, what it handed off (0.7.26). */
  turnId?: string;
  status: TurnStatus;
  steps: TurnStep[];
  durationMs?: number;
  toolCalls: number;
  iterations?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  thinking?: string;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const counted = countedSteps(steps).length || toolCalls;
  const tokens = turnTokens(inputTokens, outputTokens);
  const { mark, tone, label } = statusMark(status);

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-base-200/80 hover:bg-base-300/80 border border-base-content/[0.08] text-[11px] font-mono text-base-content/70 hover:text-base-content transition-all active:scale-95 shadow-2xs group"
      >
        <span className={`font-bold ${tone}`}>{mark}</span>
        <span className="font-semibold text-base-content/85">
          {counted} {counted === 1 ? "step" : "steps"}
        </span>
        {durationMs !== undefined && (
          <>
            <span aria-hidden="true" className="text-base-content/40">·</span>
            <span>{formatDuration(durationMs)}</span>
          </>
        )}
        {label && (
          <>
            <span aria-hidden="true" className="text-base-content/40">·</span>
            <span className={tone}>{label}</span>
          </>
        )}
        {open ? (
          <ChevronDown size={12} className="text-base-content/50 ml-0.5" />
        ) : (
          <ChevronRight size={12} className="text-base-content/40 group-hover:text-base-content/70 ml-0.5" />
        )}
      </button>

      {open && (
        <>
          <Breakdown steps={steps} {...(thinking ? { thinking } : {})} />
          {(model || error || iterations !== undefined) && (
            // Meta lines are prose: they wrap between words and break a word only when one is wider than the line —
            // `break-all` cut "20 out" into "20 o / ut" on a phone (0.8.12). It is kept for a step's command and a path.
            <div className="mt-1.5 max-w-xl text-[10px] font-mono text-base-content/65 space-y-1 [overflow-wrap:anywhere]">
              {model && <p>model: {model}</p>}
              {/*
                What the turn cost, in the two numbers that decide it.

                Round trips first, because that is the lever: each one re-sends the whole conversation,
                so `5 calls · 1 round trip` and `5 calls · 5 round trips` are the same work at 2.4x the
                price. Shown here rather than in the pill so it is available without being noise.
              */}
              {iterations !== undefined && (
                <p>
                  {toolCalls} tool {toolCalls === 1 ? "call" : "calls"} · {iterations} model{" "}
                  {iterations === 1 ? "round trip" : "round trips"}
                  {toolCalls > 0 && iterations > 0
                    ? ` (${(toolCalls / iterations).toFixed(1)} per trip)`
                    : ""}
                </p>
              )}
              {tokens && <p>{tokens}</p>}
              {error && <p className="text-error/80">{error}</p>}
            </div>
          )}
          {/* Read only once opened: a transcript of a hundred turns asks the daemon for none of it. */}
          {turnId && (
            <div className="mt-1.5 max-w-xl text-[10px] font-mono text-base-content/65 [overflow-wrap:anywhere]">
              <TurnRecord turnId={turnId} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The live feed.
 *
 * Open by default and pinned to the newest row, because this is the thing a person watches for four
 * minutes. The old view showed one truncated line here and threw the rest away.
 */
export function StepFeed({
  steps,
  elapsedMs,
  running,
}: {
  steps: TurnStep[];
  elapsedMs: number;
  /** False for the moment between a turn ending and the history catching up — nothing is working then. */
  running: boolean;
}) {
  const acted = stepRows(steps);
  const thought = reasoningText(steps);
  const counted = countedSteps(steps).length;

  /**
   * Whether the agent is between steps rather than inside one.
   *
   * A trailing `tool` with no `tool_done` is a call still running, and it has its own spinner. Anything
   * else — a closed call, or no calls yet — means the model is generating, which is invisible without
   * a row of its own. Read from what the turn did: a message sent to it mid-call is not the call ending.
   */
  const done = workSteps(steps);
  const last = done[done.length - 1];
  const waiting = running && (!last || last.kind !== "tool");
  /** The newest thought, if it came after the last thing that was done. */
  const thinkingNow =
    last?.kind === "reasoning" ? last.text.slice(0, 400) : undefined;

  return (
    <div className="w-full max-w-xl rounded-2xl bg-base-200/50 border border-base-content/[0.08] p-2 sm:p-3 space-y-1.5 font-mono text-xs">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
          <span
            className={`size-1.5 rounded-full ${running ? "bg-primary animate-pulse" : "bg-success"}`}
          />
          {running ? "Working" : "Finished"} · {counted} {counted === 1 ? "step" : "steps"} ·{" "}
          {formatElapsed(elapsedMs)}
        </span>
      </div>

      {/* Reasoning first — the plan — then the calls that carry it out. */}
      {thought && (
        <details className="mb-1.5">
          <summary className="w-fit rounded px-1 -mx-1 text-[10px] uppercase tracking-wider text-primary/80 cursor-pointer font-mono outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
            Reasoning
          </summary>
          <p className="mt-1 text-[11px] text-base-content/70 whitespace-pre-wrap bg-base-100/60 p-2.5 rounded-lg leading-relaxed max-h-48 overflow-y-auto">
            {thought}
          </p>
        </details>
      )}

      {acted.length > 0 && (
        <StepList follow={acted.length}>
          {acted.map((row) => (
            // A call with nothing closing it yet carries `running` from `stepRows`, so the spinner no
            // longer depends on the row happening to be last — which was wrong the moment a second
            // call started in the same round trip.
            <StepRow key={row.seq} row={row} />
          ))}
        </StepList>
      )}

      {/*
        The gap between steps, which is most of a turn.
        
        A seven-second wait while the model decides what to call next used to show nothing moving at
        all — the last row was a finished `tool_done`, so no spinner, and the only thing changing was
        the clock in the header. This row is what is actually happening: the model is writing. When it
        has said what it is working out, that line is shown instead of the word "Thinking".
      */}
      {waiting && (
        <div className="p-2 rounded-lg bg-base-100/60 border border-base-content/[0.05] text-[11px] text-base-content/70 flex items-start gap-2">
          <Loader2 size={13} className="animate-spin text-primary shrink-0 mt-0.5" />
          <span className={`min-w-0 flex-1 break-all leading-relaxed ${thinkingNow ? "italic" : ""}`}>
            {thinkingNow ?? "Thinking…"}
          </span>
        </div>
      )}

    </div>
  );
}
