/**
 * What the record says about a finished turn beyond its steps (0.7.26), under its pill: each model call — what it was
 * for, its tokens, and why it ended, a reply cut at the output limit marked — what each request carried, and the work
 * it handed to the background, each of those a turn of its own that opens here.
 *
 * Read from `/turns/:id` once the pill is opened, never before: a transcript of a hundred turns asks for none of it.
 * A daemon from before 0.7.26 answers without the newer parts, and those sections are simply not drawn.
 */

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { HandedOffTurn, TurnContextLine, TurnModelCall, TurnRecordDetail } from "@nouride/wire";
import { statusMark } from "@/commons/lib/steps";

/** Why a call ended, in words — `max_tokens` and `error` stand out; no reason given, no words. */
const STOPPED: Record<NonNullable<TurnModelCall["stopReason"]>, { said: string; tone: string }> = {
  stop: { said: "finished", tone: "" },
  tool_calls: { said: "asked for tools", tone: "" },
  max_tokens: { said: "cut at the output limit", tone: "text-warning" },
  error: { said: "failed", tone: "text-error" },
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });
const count = (n: number) => n.toLocaleString();

/** The record of one turn, fetched when it is shown. */
export function TurnRecord({ turnId }: { turnId: string }) {
  const found = useQuery({ queryKey: ["turn-record", turnId], queryFn: () => api.turnRecord(turnId), retry: false, staleTime: 15_000 });
  if (found.isPending) return <Loader2 size={12} className="animate-spin text-primary/60" aria-label="Loading the turn's record" />;
  // A daemon without the route, or a turn swept since: the pill already says what it can.
  if (!found.data) return null;
  return <TurnRecordView record={found.data} />;
}

export function TurnRecordView({ record }: { record: TurnRecordDetail }) {
  const { turn, calls, contexts = [], delegated = [] } = record;
  return (
    <div className="space-y-2">
      {calls.length > 0 && (
        <Section title={`Model calls (${calls.length})`}>
          {calls.map((call, i) => (
            <CallLine key={`${call.at}-${i}`} call={call} ownAgent={turn.agentId} />
          ))}
        </Section>
      )}
      {contexts.length > 0 && (
        <Section title="What each request carried">
          {contexts.map((line, i) => (
            <ContextRow key={`${line.request}-${line.by ?? ""}-${i}`} line={line} />
          ))}
        </Section>
      )}
      {delegated.length > 0 && (
        <Section title="Handed to the background">
          {delegated.map((handed) => (
            <HandedOff key={handed.id} handed={handed} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-base-content/65 font-mono">{title}</p>
      {children}
    </div>
  );
}

function CallLine({ call, ownAgent }: { call: TurnModelCall; ownAgent: string }) {
  const stopped = call.stopReason ? STOPPED[call.stopReason] : undefined;
  return (
    <p className="[overflow-wrap:anywhere]">
      {clock(call.at)} {call.purpose && call.purpose !== "turn" ? `${call.purpose.replace("_", " ")} · ` : ""}
      {call.agentId !== ownAgent ? `${call.agentId} · ` : ""}
      {call.model} · {count(call.inputTokens)} in / {count(call.outputTokens)} out
      {stopped && <span className={stopped.tone}> · {stopped.said}</span>}
    </p>
  );
}

function ContextRow({ line }: { line: TurnContextLine }) {
  return (
    <div>
      <p>
        {line.by ? `${line.by} · ` : ""}#{line.request} · ~{count(line.estimatedTokens)} tokens {/* plain-words-ok: tokens, the unit a model's use is counted and billed in */}
        {line.cleared > 0 ? ` · ${line.cleared} earlier ${line.cleared === 1 ? "result" : "results"} cleared` : ""}
        {line.summary ? " · with a summary of earlier turns" : ""}
      </p>
      {(line.keptAt ?? []).map((path) => (
        <p key={path} className="pl-3 break-all text-base-content/65">
          {`kept at ${path}`}
        </p>
      ))}
    </div>
  );
}

/** A delegate's own turn, one line — opened, its steps and what it handed back. */
function HandedOff({ handed }: { handed: HandedOffTurn }) {
  const [open, setOpen] = useState(false);
  const { mark, tone } = statusMark(handed.status);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-start gap-1 text-left hover:text-base-content">
        {open ? <ChevronDown size={11} className="mt-0.5 shrink-0" /> : <ChevronRight size={11} className="mt-0.5 shrink-0" />}
        <span>
          <span className={tone}>{mark}</span> {handed.cause?.via === "ask_agent" ? `asked ${handed.agentId}` : "helper"} · {handed.status}:{" "}
          {handed.prompt.replace(/\s+/g, " ").slice(0, 120)}
        </span>
      </button>
      {open && <HandedOffRecord turnId={handed.id} />}
    </div>
  );
}

function HandedOffRecord({ turnId }: { turnId: string }) {
  const found = useQuery({ queryKey: ["turn-record", turnId], queryFn: () => api.turnRecord(turnId), retry: false });
  if (found.isPending) return <Loader2 size={12} className="ml-4 animate-spin text-primary/60" aria-label="Loading its record" />;
  if (!found.data) return null;
  const { turn, steps, contexts = [] } = found.data;
  return (
    <div className="ml-4 mt-1 space-y-0.5 border-l border-base-content/10 pl-2">
      {steps.map((step) => (
        <p key={step.seq} className="break-all">
          <span className="text-base-content/65">{step.kind}</span> {step.text}
        </p>
      ))}
      {contexts.map((line, i) => (
        <ContextRow key={`${line.request}-${i}`} line={line} />
      ))}
      {turn.reply && <p className="whitespace-pre-wrap break-words text-base-content/80">{turn.reply}</p>}
    </div>
  );
}
