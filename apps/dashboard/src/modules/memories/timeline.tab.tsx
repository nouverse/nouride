/**
 * Every conversation, newest first — what the nightly pass filed, and what still waits for it.
 *
 * The operator's view, unfiltered by audience, which is why it is an operator's tab; inside a chat an
 * agent only ever reads what that chat may see. The pass's own state sits on top: when it runs next,
 * what the last run did, and the conversations it could not file — and below it how long the
 * transcripts listed here stay readable (`[memory] transcript_days`, `archive`).
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CalendarDays, ChevronDown, RotateCcw, Search } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { EpisodeFilter, EpisodeStatus } from "@/commons/lib/api.memory";
import { useToast } from "@/commons/components/ui/toast";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { EpisodeView, stars } from "./episode-view";
import { useNames } from "./names";
import {
  completeRange,
  diffInDays,
  getDefaultRange,
  latestUntil,
  MAX_RANGE_DAYS,
  onSinceChosen,
  onUntilChosen,
  parseLocalDate,
  toLocalDateString,
} from "./timeline-date";
import { PassCard } from "./pass.card";
import { TranscriptsCard } from "./transcripts.card";

const LABEL = "text-base-content/85 text-xs font-semibold uppercase tracking-wider font-mono";

/** Newest day first, and the newest conversation first within it. */
function byDay<T extends { day: string; startedAt: number }>(episodes: T[]): [string, T[]][] {
  const days = new Map<string, T[]>();
  for (const episode of [...episodes].sort((a, b) => b.startedAt - a.startedAt)) days.set(episode.day, [...(days.get(episode.day) ?? []), episode]);
  return [...days.entries()];
}

export function TimelineTab({ editable }: { editable: boolean }) {
  const nameOf = useNames();
  const toast = useToast();
  const defaultRange = getDefaultRange();
  const [draft, setDraft] = useState<EpisodeFilter>(() => ({ ...defaultRange }));
  const [filter, setFilter] = useState<EpisodeFilter>(() => ({ ...defaultRange }));
  const [open, setOpen] = useState<string | null>(null);
  const episodes = useQuery({ queryKey: ["memory-episodes", filter], queryFn: () => api.memoryEpisodes(filter) });
  const set = (patch: EpisodeFilter) => setDraft((before) => ({ ...before, ...patch }));

  const todayStr = toLocalDateString(new Date());
  const maxUntilStr = latestUntil(draft.since, todayStr);

  const onSinceChange = (val: string) => set(val ? onSinceChosen(val, todayStr) : { since: undefined });
  const onUntilChange = (val: string) => set({ until: val ? onUntilChosen(val, draft.since, todayStr) : undefined });

  const apply = () => {
    const { since, until } = completeRange(draft.since, draft.until, parseLocalDate(todayStr));

    if (since > todayStr) {
      toast.error("Invalid date", "'From' date cannot be in the future.");
      return;
    }

    const diff = diffInDays(since, until);
    if (diff < 0) {
      toast.error("Invalid date range", "'From' date must be before or equal to 'To' date.");
      return;
    }
    if (diff > MAX_RANGE_DAYS) {
      toast.error("Date range too long", `Date range cannot exceed ${MAX_RANGE_DAYS} days from 'From' date.`);
      return;
    }

    const nextDraft = { ...draft, since, until };
    setDraft(nextDraft);
    setFilter({
      ...nextDraft,
      ...(nextDraft.q ? { q: nextDraft.q.trim() } : {}),
    });
  };

  const reset = () => {
    const fresh = getDefaultRange();
    setDraft({ ...fresh });
    setFilter({ ...fresh });
  };

  const hasActiveFilters = Boolean(
    filter.q ||
    filter.person ||
    filter.tag ||
    filter.status ||
    filter.since !== defaultRange.since ||
    filter.until !== defaultRange.until ||
    draft.q ||
    draft.person ||
    draft.tag ||
    draft.status ||
    draft.since !== defaultRange.since ||
    draft.until !== defaultRange.until
  );

  const list = episodes.data?.episodes ?? [];
  const filtered = Boolean(
    filter.q ||
    filter.person ||
    filter.tag ||
    filter.status ||
    filter.since !== defaultRange.since ||
    filter.until !== defaultRange.until
  );
  // The same query the pass card above reads, so this is its cached answer, not a second request.
  const pass = useQuery({ queryKey: ["memory-status"], queryFn: api.memoryStatus, refetchInterval: 15_000 }).data?.pass;
  const waitingFor = pass?.enabled ? `Waiting for the nightly pass at ${pass.at}.` : "Waiting for the nightly pass, which is off. Turn it on in Settings.";

  return (
    <div className="space-y-4">
      <PassCard editable={editable} />
      <TranscriptsCard editable={editable} />

      <Card>
        {/* A grid, every field full width in its cell: in a wrapping row the date fields were cut to
            "29/09/202" and the words box was narrower than what people type into it. */}
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Words</span>
            <input className="input input-sm w-full rounded-xl" placeholder="Search" value={draft.q ?? ""} onChange={(event) => set({ q: event.target.value })} onKeyDown={(event) => event.key === "Enter" && apply()} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Person</span>
            <input className="input input-sm w-full rounded-xl" placeholder="Anyone" value={draft.person ?? ""} onChange={(event) => set({ person: event.target.value.trim() || undefined })} onKeyDown={(event) => event.key === "Enter" && apply()} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Tag</span>
            <input className="input input-sm w-full rounded-xl" placeholder="Any" value={draft.tag ?? ""} onChange={(event) => set({ tag: event.target.value.trim() || undefined })} onKeyDown={(event) => event.key === "Enter" && apply()} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>From</span>
            <input
              type="date"
              className="input input-sm w-full rounded-xl"
              value={draft.since ?? ""}
              max={todayStr}
              onChange={(event) => onSinceChange(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && apply()}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>To <span className="font-normal normal-case text-base-content/65">(max 31d from From)</span></span>
            <input
              type="date"
              className="input input-sm w-full rounded-xl"
              value={draft.until ?? ""}
              min={draft.since}
              max={maxUntilStr}
              onChange={(event) => onUntilChange(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && apply()}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Status</span>
            <select className="select select-sm w-full rounded-xl" value={draft.status ?? ""} onChange={(event) => set({ status: (event.target.value || undefined) as EpisodeStatus | undefined })}>
              <option value="">Any</option>
              <option value="raw">Waiting for the nightly pass</option>
              <option value="summarized">Filed</option>
              <option value="compacted">Archived</option>
            </select>
          </label>
          <div className="flex items-center justify-end gap-1.5 sm:col-span-2 lg:col-span-3">
            <button type="button" className="btn btn-sm btn-primary gap-1 rounded-xl" onClick={apply}>
              <Search size={14} /> Filter
            </button>
            {hasActiveFilters ? (
              <button type="button" className="btn btn-ghost btn-sm gap-1 rounded-xl" title="Reset to default 7 days" onClick={reset}>
                <RotateCcw size={14} /> Reset
              </button>
            ) : null}
          </div>
        </div>
      </Card>

      {episodes.error ? <ErrorNote error={episodes.error} /> : null}
      {!episodes.isLoading && list.length === 0 ? (
        <EmptyState icon={CalendarDays} title="No conversations" description="Each conversation shows up here after /new, /reset, or the nightly pass." />
      ) : null}

      {list.length > 0 ? (
        <ScrollCard title={`${list.length} conversation(s)`} description="Newest first. Open a day to see its conversations.">
          {/* Its own scroll, so the page stays put and a long history is a list of days, not a wall. */}
          <div className="-mx-2 max-h-[65vh] space-y-1 overflow-y-auto px-2">
            {byDay(list).map(([day, dayEpisodes]) => (
              // Closed by default; a filter's results open, so what was searched for is in sight.
              <details key={`${day}:${filtered}`} open={filtered} className="group rounded-xl border border-base-content/[0.06]">
                <summary className="hover:bg-base-200/50 flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2.5">
                  <span className="text-sm font-semibold">{new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
                  <span className="text-base-content/65 flex items-center gap-2 text-xs">
                    {dayEpisodes.length} conversation(s)
                    {dayEpisodes.some((episode) => !episode.summary) ? <span className="badge badge-ghost badge-xs font-mono">{dayEpisodes.filter((episode) => !episode.summary).length} waiting</span> : null}
                    <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
                  </span>
                </summary>
                <div className="px-1 pb-2">
              <ul className="divide-base-content/[0.06] divide-y">
                {dayEpisodes.map((episode) => (
                  <li key={episode.id}>
                    <button type="button" className="hover:bg-base-200/50 w-full space-y-1 rounded-lg px-2 py-2.5 text-left" onClick={() => setOpen(episode.id)}>
                      {episode.summary ? (
                        <p className="text-sm leading-relaxed">{episode.summary}</p>
                      ) : (
                        <div className="space-y-0.5">
                          {episode.preview ? <p className="text-base-content/80 line-clamp-2 text-sm leading-relaxed">“{episode.preview}”</p> : null}
                          <p className="text-base-content/65 text-xs">{waitingFor}</p>
                        </div>
                      )}
                      <p className="text-base-content/65 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        {episode.kind === "archive" ? null : <span className="font-mono">{new Date(episode.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
                        <span>{episode.agents.join(", ") || "archive"}</span>
                        <span>with {episode.participants.map(nameOf).join(", ") || "nobody named"}</span>
                        {episode.kind === "group" ? <span>group</span> : null}
                        {episode.importance ? <span title="importance">{stars(episode.importance)}</span> : null}
                        {episode.tags.map((tag) => (
                          <span key={tag} className="badge badge-ghost badge-xs font-mono">
                            #{tag}
                          </span>
                        ))}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
                </div>
              </details>
            ))}
          </div>
        </ScrollCard>
      ) : null}

      {open ? <EpisodeView id={open} editable={editable} nameOf={nameOf} onOpen={setOpen} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
