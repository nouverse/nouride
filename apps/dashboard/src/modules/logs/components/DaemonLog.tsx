/** Logs → Daemon: every line the process printed, filtered and paged from the stored log. */

import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Info, Loader2, RefreshCw, ScrollText, Search, TriangleAlert, X } from "lucide-react";
import { api, type StoredLogEntry } from "@/commons/lib/api";
import { Card, EmptyState } from "@/commons/components/ui/ui";
import { useDebounced } from "@/commons/hooks/use-debounced";
import { Panel } from "./Panel";
import { ListLoading } from "@/commons/components/ui/Spinner";

const PAGE = 200;

const LEVEL_STYLE: Record<StoredLogEntry["level"], { badge: string; icon: typeof Info }> = {
  info: { badge: "text-base-content/65", icon: Info },
  warn: { badge: "text-warning", icon: TriangleAlert },
  error: { badge: "text-error", icon: AlertTriangle },
};

export function DaemonLog() {
  const [level, setLevel] = useState("");
  const [component, setComponent] = useState("");
  const [search, setSearch] = useState("");
  const searchTerm = useDebounced(search, 250);

  const logs = useInfiniteQuery({
    queryKey: ["logs", level, component, searchTerm],
    queryFn: ({ pageParam }) =>
      api.storedLogs({
        limit: PAGE,
        ...(level ? { level } : {}),
        ...(component ? { component } : {}),
        ...(searchTerm ? { q: searchTerm } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    // Live enough to watch something happen, cheap enough to leave on: one indexed query per tick,
    // and only the pages already loaded are refreshed.
    refetchInterval: 5_000,
    retry: false,
  });

  const pages = logs.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.entries);
  const head = pages[0];

  if (logs.error) {
    return (
      <Card className="shrink-0">
        <EmptyState
          icon={ScrollText}
          title="Log storage is not enabled"
          description="This daemon keeps its log in memory only. Upgrade it, or read the journal on the host."
        />
      </Card>
    );
  }

  return (
    <Panel
      title="Daemon log"
      retention="log"
      description={
        head
          ? `${head.total.toLocaleString()} entries kept${
              head.span.oldest ? `, back to ${new Date(head.span.oldest).toLocaleString()}` : ""
            }. Debug lines are not stored; they still go to the journal.`
          : "Reading…"
      }
      toolbar={
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base-content/35 pointer-events-none"
              />
              <input
                className="input input-sm w-full rounded-xl pl-7 pr-7 text-xs"
                placeholder="Search the message and its fields…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-circle size-5 max-sm:size-7 min-h-0 text-base-content/65"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <select
              className="select select-sm rounded-xl text-xs"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="">All levels</option>
              <option value="info">Info and above</option>
              <option value="warn">Warnings and errors</option>
              <option value="error">Errors only</option>
            </select>

            <select
              className="select select-sm rounded-xl font-mono text-xs max-w-[220px] max-sm:min-w-0 max-sm:flex-1"
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            >
              <option value="">All components</option>
              {(head?.components ?? []).map((entry) => (
                <option key={entry.component} value={entry.component}>
                  {entry.component} ({entry.entries})
                </option>
              ))}
            </select>

            <button
              type="button"
              className="btn btn-ghost btn-sm rounded-xl gap-1.5"
              onClick={() => void logs.refetch()}
              title="Refresh now"
              aria-label="Refresh the log now"
            >
              <RefreshCw size={14} className={logs.isFetching ? "animate-spin" : ""} />
            </button>
          </div>

        </div>
      }
    >
      {logs.isPending ? (
        <ListLoading count={5} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Nothing matches"
          description={search || level || component ? "Loosen the filters." : "The daemon has logged nothing yet."}
        />
      ) : (
        <div className="space-y-0.5">
          {entries.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))}
          {logs.hasNextPage && (
            <button
              type="button"
              className="btn btn-ghost btn-xs w-full rounded-xl text-[11px] mt-2"
              onClick={() => void logs.fetchNextPage()}
              disabled={logs.isFetchingNextPage}
            >
              {logs.isFetchingNextPage ? <Loader2 size={12} className="animate-spin" /> : null}
              Load older lines
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

function LogRow({ entry }: { entry: StoredLogEntry }) {
  const [open, setOpen] = useState(false);
  const style = LEVEL_STYLE[entry.level] ?? LEVEL_STYLE.info;
  const Icon = style.icon;
  const fields = entry.data ? Object.entries(entry.data) : [];

  return (
    <div
      className={`rounded-lg px-2 py-1.5 hover:bg-base-200/50 transition-colors ${
        entry.level === "error" ? "bg-error/[0.04]" : entry.level === "warn" ? "bg-warning/[0.04]" : ""
      }`}
    >
      {/*
        A row of columns from a tablet's width up. On a phone those columns left the message three letters wide
        ("poll / ing / sta / rte", 0.8.12): there the time, the level and the component are the first line, and the
        message is the whole width under it, its fields under that when opened.
      */}
      <button
        type="button"
        className="flex w-full flex-wrap items-start gap-x-2 gap-y-0.5 text-left sm:flex-nowrap"
        // Only when there is something folded away. A row that expands to nothing teaches people
        // that expanding is pointless.
        onClick={() => fields.length > 0 && setOpen((v) => !v)}
      >
        <Icon size={13} className={`mt-0.5 shrink-0 ${style.badge}`} aria-label={entry.level} />
        <span className="font-mono text-[10px] text-base-content/65 shrink-0 tabular-nums sm:w-[128px]">
          {new Date(entry.ts).toLocaleString([], { hour12: false })}
        </span>
        <span className="font-mono text-[10px] text-primary/70 min-w-0 flex-1 truncate sm:max-w-[150px] sm:flex-none sm:shrink-0">
          {entry.component}
        </span>
        <span className="min-w-0 basis-full pl-[21px] text-sm text-base-content/85 break-words max-sm:order-last sm:basis-0 sm:flex-1 sm:pl-0 sm:text-xs">
          {entry.message}
          {fields.length > 0 && !open && (
            <span className="ml-1.5 whitespace-nowrap text-[10px] font-mono text-base-content/65">
              {fields.length} field{fields.length === 1 ? "" : "s"}
            </span>
          )}
        </span>
        {fields.length > 0 && (
          <ChevronDown
            size={12}
            className={`mt-0.5 shrink-0 text-base-content/30 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open && fields.length > 0 && (
        <dl className="mt-1.5 ml-[21px] grid grid-cols-1 gap-x-3 gap-y-0.5 text-[11px] font-mono sm:ml-[150px] sm:grid-cols-[auto_1fr]">
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-base-content/65">{key}</dt>
              <dd className="text-base-content/80 break-all">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
