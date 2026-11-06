/**
 * One job in the list, drawn as a mission's row is: its status and kind, its agent and when, what it was asked to do,
 * and one line that says the most useful thing about it now. The whole row opens its page.
 */

import { Link } from "@tanstack/react-router";
import { Bot, ChevronRight, MessagesSquare, Terminal } from "lucide-react";
import type { BackgroundJob } from "@/commons/lib/api";
import { ago } from "@/commons/lib/format";
import { formatDuration } from "@/commons/lib/steps";
import { jobTitle, kindOf, ranFor, rowLine, statusWord } from "../lib/job";

const KIND = {
  helper: { icon: Bot, label: "helper" },
  command: { icon: Terminal, label: "command" },
  ask: { icon: MessagesSquare, label: "ask" },
} as const;

export function KindBadge({ job }: { job: BackgroundJob }) {
  const kind = KIND[kindOf(job)];
  return (
    <span className="badge badge-sm badge-ghost gap-1 font-mono text-[10px]">
      <kind.icon size={10} aria-hidden="true" /> {kind.label}
    </span>
  );
}

export function StatusBadge({ job }: { job: BackgroundJob }) {
  const { word, tone } = statusWord(job);
  return <span className={`badge badge-sm font-semibold ${tone}`}>{word}</span>;
}

export function JobRow({ job }: { job: BackgroundJob }) {
  const line = rowLine(job);
  return (
    <Link
      to="/jobs/$jobId"
      params={{ jobId: job.id }}
      className="group block rounded-2xl border border-base-content/[0.08] bg-base-100/80 p-4 shadow-xs backdrop-blur-xl transition-all duration-150 hover:border-base-content/20 active:scale-[0.99] sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <StatusBadge job={job} />
          <KindBadge job={job} />
        </span>
        <span className="font-mono text-[11px] text-base-content/65">
          {job.agentId} · {ago(job.startedAt)} · {job.status === "running" ? "running " : "ran "}
          {formatDuration(ranFor(job))}
        </span>
      </div>

      <div className="mt-2.5 flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold leading-snug tracking-tight text-base-content line-clamp-2 [overflow-wrap:anywhere]" title={jobTitle(job)}>
          {jobTitle(job)}
        </p>
        <ChevronRight size={16} className="mt-0.5 shrink-0 text-base-content/35 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </div>

      {line && (
        <p className="mt-2 text-xs leading-relaxed text-base-content/75 line-clamp-2 [overflow-wrap:anywhere]">
          <span className="mr-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">{line.label}</span>
          {line.text}
        </p>
      )}
    </Link>
  );
}
