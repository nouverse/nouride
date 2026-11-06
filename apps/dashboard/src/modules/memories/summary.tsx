/**
 * Memory in one line, above the tabs: is it running, when it last ran and what that did, when it runs next, and does
 * anything wait on a person. The answer to "is this working?" without opening a tab — and when it is not (the pass is
 * off), what to do about it.
 *
 * Times are the daemon's clock (`[daemon] timezone`), which is when the pass runs, whatever the browser's zone. While a
 * pass runs the line says so and asks again every few seconds: what waits shrinks as it files.
 */

import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck } from "lucide-react";
import { api } from "@/commons/lib/api";

/**
 * `Thu 23 Oct, 01:05`, on the daemon's clock. Put together from its parts: a whole format joins them as ICU sees fit —
 * "Thu 23 Oct, 01:05" in one engine, "Thu 23 Oct at 01:05" in another.
 */
function when(at: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/** `in 3 h 20 min`, `in 12 min`. */
function fromNow(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `in ${minutes} min`;
}

/** `took 4 min`, `took under a minute`. */
function took(startedAt: number | undefined, finishedAt: number): string | null {
  if (startedAt === undefined) return null;
  const minutes = Math.round((finishedAt - startedAt) / 60_000);
  return minutes < 1 ? "took under a minute" : `took ${minutes} min`;
}

export function MemorySummary({ waiting }: { waiting: number }) {
  const settings = useQuery({ queryKey: ["memory-settings"], queryFn: api.memorySettings });
  const status = useQuery({ queryKey: ["memory-status"], queryFn: api.memoryStatus, refetchInterval: (query) => (query.state.data?.pass?.running ? 5_000 : 30_000) });
  const current = settings.data;
  if (!current) return null;

  const pass = status.data?.pass;
  const problem = current.pass ? null : "The nightly pass is off, so nothing new is saved. Turn it on in Settings.";

  if (problem) {
    return (
      <div role="status" className="border-warning/30 bg-warning/10 flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm">
        <CircleAlert size={16} className="text-warning shrink-0" /> {problem}
      </div>
    );
  }

  const left = status.data?.waiting ?? 0;
  if (pass?.running) {
    return (
      <div role="status" aria-live="polite" className="border-primary/30 bg-primary/10 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border px-4 py-3 text-sm">
        <span className="loading loading-spinner loading-xs text-primary shrink-0" aria-hidden="true" />
        <span className="font-medium">The nightly pass is running</span>
        {pass.runningSince ? <span className="text-base-content/65">· since {when(pass.runningSince, pass.timeZone)}</span> : null}
        <span className="text-base-content/65">· {left} conversation(s) left to file</span>
      </div>
    );
  }

  const last = pass?.lastRun;
  const next = pass?.next;
  const parts = [
    last
      ? `last pass ${when(last.finishedAt, pass!.timeZone)}${took(last.startedAt, last.finishedAt) ? ` (${took(last.startedAt, last.finishedAt)})` : ""}: ${last.filed} filed${last.failed ? `, ${last.failed} failed` : ""}${last.scheduled === false ? ", run by hand" : ""}`
      : "no pass yet",
    next ? (next.due ? "next pass due now; it waits for the turns running to end" : `next pass ${when(next.at, pass!.timeZone)} (${fromNow(next.at, Date.now())})`) : pass ? `next pass ${pass.at} (${pass.timeZone})` : `next pass ${current.passAt}`,
    ...(left > 0 ? [`${left} conversation(s) waiting for it`] : []),
    current.semantic.enabled ? "semantic search on" : "semantic search off",
    ...(waiting > 0 ? [`${waiting} in Proposals`] : []),
    ...(status.data?.failed ? [`${status.data.failed} could not be filed`] : []),
  ];
  return (
    <div role="status" className="border-base-content/[0.08] bg-base-100/80 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border px-4 py-3 text-sm">
      <CircleCheck size={16} className="text-success shrink-0" />
      <span className="font-medium">Memory is on</span>
      {parts.map((part) => (
        <span key={part} className="text-base-content/65">
          · {part}
        </span>
      ))}
    </div>
  );
}
