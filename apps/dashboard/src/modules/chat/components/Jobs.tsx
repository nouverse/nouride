/**
 * Background work, while it runs.
 *
 * `exec background: true` answers immediately: the turn that started a ten-minute build is over in
 * four seconds, and the conversation then looks idle until the job wakes the agent with a report out
 * of nowhere. This is the only thing on screen during that gap, and it is the honest one — the daemon
 * is asked what is still running in *this* conversation, so it is also true after a reload, in a
 * second tab, and for a job started from Telegram.
 */

import { useEffect, useState } from "react";
import { Bot, Loader2, MessagesSquare, Terminal } from "lucide-react";
import type { RunningJob } from "@nouride/wire";
import { formatDuration } from "@/commons/lib/steps";

export function JobStrip({ jobs }: { jobs: RunningJob[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (jobs.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [jobs.length]);

  if (jobs.length === 0) return null;

  return (
    <div className="w-full max-w-xl space-y-1.5">
      <span className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
        <Loader2 size={11} className="animate-spin text-primary" />
        {jobs.length} background {jobs.length === 1 ? "job" : "jobs"} running
      </span>
      {jobs.map((job) => (
        <div
          key={job.id}
          className="p-2 rounded-lg bg-base-100/80 border border-base-content/[0.05] text-[11px] font-mono flex items-start gap-2 text-base-content/80"
        >
          {job.kind === "helper" ? (
            <Bot size={13} className="shrink-0 mt-0.5 text-base-content/40" aria-label="helper" />
          ) : job.kind === "ask" ? (
            <MessagesSquare size={13} className="shrink-0 mt-0.5 text-base-content/40" aria-label="another agent, asked" />
          ) : (
            <Terminal size={13} className="shrink-0 mt-0.5 text-base-content/40" />
          )}
          <span className="min-w-0 flex-1 break-all leading-relaxed">{job.command}</span>
          <span className="shrink-0 text-[10px] text-base-content/65 mt-0.5">
            {formatDuration(Math.max(0, now - job.startedAt))}
          </span>
        </div>
      ))}
    </div>
  );
}
