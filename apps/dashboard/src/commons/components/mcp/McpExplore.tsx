/**
 * Servers from the official MCP registry, to add to this agent (0.7.19).
 *
 * Nouverse's catalog of the registry, through the daemon: before anyone types, its own list — what it pinned first —
 * and a search after. For each, who published it, how it would run on this machine — a remote endpoint, or a package
 * through npx, uvx or docker — and what it would ask for. Adding one opens the ordinary server form, filled in;
 * nothing is added until it is saved there.
 */

import { ListLoading, Spinner } from "@/commons/components/ui/Spinner";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SearchForm } from "@/commons/components/ui/SearchForm";
import { StickyTools } from "@/commons/components/ui/StickyBar";
import { ExternalLink, Globe, Package, Star } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { CatalogDraft, McpCatalogCard, McpCatalogPage } from "@nouride/wire";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ago } from "@/commons/lib/format";

/** How a result runs, said in a badge. */
export function runsLabel(card: Pick<McpCatalogCard, "runsVia" | "unsupported" | "blocked">): string {
  if (card.unsupported) return card.blocked?.label ?? "cannot run here";
  return card.runsVia === "remote" ? "remote" : card.runsVia ? `via ${card.runsVia}` : "";
}

/** The line under the search box: what the list is, and how fresh Nouverse's copy of the registry is. */
export function catalogLine(page: Pick<McpCatalogPage, "total" | "syncedAt"> | undefined, searched: boolean, now = Date.now()): string {
  if (!page) return "";
  const fresh = page.syncedAt ? `, updated ${ago(Date.parse(page.syncedAt), now)}` : "";
  const what = searched ? `${page.total.toLocaleString("en-US")} ${page.total === 1 ? "match" : "matches"} in` : "Nouverse's picks first, from";
  return `${what} the public catalog of connectors${fresh}.`;
}

export function McpExplore({
  admin,
  install,
  onPick,
}: {
  admin: boolean;
  /** A registry name to open at once — the link `mcp_search` gives. */
  install?: string;
  onPick: (draft: CatalogDraft) => void;
}) {
  const [query, setQuery] = useState("");
  // Asked when Search is pressed, as on Skills' Explore — not on every keystroke, which spent a request per letter.
  const [debounced, setDebounced] = useState("");

  const results = useQuery({ queryKey: ["mcp-catalog", debounced], queryFn: () => api.mcpCatalog(debounced), retry: false });
  const [picked, setPicked] = useState<string | null>(install ?? null);
  const entry = useQuery({ queryKey: ["mcp-catalog-entry", picked], queryFn: () => api.mcpCatalogEntry(picked!), enabled: Boolean(picked), retry: false });
  useEffect(() => {
    const result = entry.data?.result;
    if (result && "draft" in result) {
      onPick(result.draft);
      setPicked(null);
    }
  }, [entry.data, onPick]);

  const entries = results.data?.entries ?? [];
  const unsupported = entry.data?.result && "unsupported" in entry.data.result ? entry.data.result.unsupported : null;

  // Laid out as Skills' Explore is: the search in the row that stays at the top of the window, beside the tabs, and the
  // results as long as they are, part of the page. They were a box that scrolled inside the card, from when the page
  // was held to the window: once the page scrolled as a page the box no longer scrolled and still kept the wheel, so
  // with the pointer over the list nothing moved.
  return (
    <Card title="Find a connector" description="Search the public catalog of connectors. They are made by others and not checked: read what one does before adding it.">
      <StickyTools fill>
        <SearchForm value={query} onChange={setQuery} onSearch={setDebounced} placeholder="github, notion, postgres…" label="Search the catalog" busy={results.isFetching} allowEmpty />
      </StickyTools>
      <div data-catalog-results className="space-y-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">{debounced ? `Matching “${debounced}”` : "Nouverse's picks"}</p>
      <p className="text-xs text-base-content/65">{catalogLine(results.data, Boolean(debounced))}</p>
      <ErrorNote error={results.error ?? entry.error} />
      {unsupported ? <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-xl p-3 text-xs">{unsupported}</div> : null}

      {results.isFetching ? <ListLoading /> : null}

      {debounced && entries.length === 0 && !results.isFetching ? (
        <EmptyState pose="searching" title="Nothing matches" description={`No connector in the catalog matches “${debounced}”.`} />
      ) : null}

      <ul className={`grid grid-cols-1 gap-3 lg:grid-cols-2 ${results.isFetching ? "hidden" : ""}`}>
        {entries.map((card) => (
          <li key={card.name} className="rounded-2xl border border-base-content/[0.08] bg-base-100/80 p-4 shadow-xs space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-sm">{card.title ?? card.name}</p>
                <p className="truncate font-mono text-xs text-base-content/65">
                  {card.name} · v{card.version}
                </p>
              </div>
              <span className={`badge badge-sm shrink-0 font-mono gap-1 ${card.unsupported ? "badge-warning" : "badge-ghost"}`} title={card.unsupported ?? undefined}>
                {card.runsVia === "remote" ? <Globe size={11} aria-hidden="true" /> : <Package size={11} aria-hidden="true" />}
                {runsLabel(card)}
              </span>
            </div>
            <p className="text-xs text-base-content/75 line-clamp-3">{card.description || "No description."}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {card.pinned ? (
                <span className="badge badge-primary badge-soft badge-sm font-mono gap-1" title="Picked by Nouverse">
                  <Star size={11} aria-hidden="true" /> pick
                </span>
              ) : null}
              <span className="badge badge-ghost badge-sm font-mono" title="The name its maker proved they own">
                by {card.publisher}
              </span>
              {card.needs?.map((need) => (
                <span key={need} className="badge badge-outline badge-sm font-mono" title="Asks for this when added">
                  {need}
                </span>
              ))}
              {card.link ? (
                <a className="link link-hover inline-flex items-center gap-1 text-base-content/65" href={card.link} target="_blank" rel="noreferrer noopener">
                  <ExternalLink size={11} aria-hidden="true" /> site
                </a>
              ) : null}
              <span className="grow" />
              <button
                type="button"
                className="btn btn-primary btn-xs rounded-lg gap-1"
                disabled={!admin || Boolean(card.unsupported) || (entry.isFetching && picked === card.name)}
                title={card.unsupported ?? (admin ? "Open the form, filled in" : "Only an admin adds connectors")}
                onClick={() => setPicked(card.name)}
              >
                {entry.isFetching && picked === card.name ? <Spinner /> : null}
                Add
              </button>
            </div>
          </li>
        ))}
      </ul>
      </div>
    </Card>
  );
}
