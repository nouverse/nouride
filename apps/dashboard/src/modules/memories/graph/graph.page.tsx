/**
 * Memory as a graph: every conversation a dot, joined to the people in it, its tags and the agent it
 * was with — and to the conversations the nightly pass found related. What the list tabs show one row
 * at a time, this shows as a shape: who comes up together, which subjects keep returning.
 *
 * Documents, a switch away (0.8.20): the knowledge base laid over it, each collection
 * and its documents, the links between them, the people they are about, and documents close in meaning.
 *
 * Kept cheap at both ends. The daemon answers with ids and one-line labels, bounded by the filter and
 * cached until the vault changes (`graph-view.ts` in the engine); a conversation is read whole only
 * when someone opens it. The browser does the layout, and stops once it settles.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, FileText, Filter, Hash, Loader2, Search, User, Waypoints, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/commons/lib/api";
import type { GraphNode, GraphNodeKind, MemoryGraph } from "@nouride/wire";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { canWrite, useMe } from "@/commons/lib/session";
import { EpisodeView } from "../episode-view";
import { DocumentDialog, type OpenDocument } from "../knowledge/document.dialog";
import { useNames } from "../names";
import { GraphCanvas } from "./graph-canvas";
import { MultiSelect } from "./multi-select";
import { KIND_LABEL, usePalette } from "./palette";
import { documentAt, keyOf, Panel } from "./panel";
import { DEFAULT_LIMIT, DEFAULT_RANGE, LIMITS, RANGES, toFilter, type GraphSearch } from "./search";
import { Leaving } from "@/commons/components/ui/OverPage";

const KINDS: GraphNodeKind[] = ["episode", "person", "tag", "agent", "collection", "document"];
/** The knowledge layer's kinds: in the legend while it is on. */
const KNOWLEDGE_KINDS: readonly GraphNodeKind[] = ["collection", "document"];
const HIDDEN_KEY = "nouride-memory-graph-hidden";

function readHidden(): Set<GraphNodeKind> {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((kind): kind is GraphNodeKind => KINDS.includes(kind)) : []);
  } catch {
    return new Set();
  }
}

export default function MemoryGraphPage({ search, onSearch }: { search: GraphSearch; onSearch: (next: GraphSearch) => void }) {
  const me = useMe();
  const operator = canWrite(me.data ?? null);
  const filter = toFilter(search);
  const graph = useQuery({
    queryKey: ["memory-graph", filter],
    queryFn: () => api.memoryGraph(filter),
    enabled: operator,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const agents = useQuery({ queryKey: ["memory-agent-notes"], queryFn: api.agentNotes, enabled: operator });
  // The whole vault's, not the shown graph's: ticking one tag must not take the others off the list.
  const facets = useQuery({ queryKey: ["memory-facets"], queryFn: api.memoryFacets, enabled: operator, staleTime: 5 * 60_000 });
  const nameOf = useNames();

  const [hidden, setHidden] = useState<Set<GraphNodeKind>>(readHidden);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenDocument | null>(null);

  const toggleKind = (kind: GraphNodeKind) => {
    const next = new Set(hidden);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    // Conversations are what everything joins; hiding them leaves dots with nothing between.
    if (next.has("episode")) next.delete("episode");
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    } catch {
      // Then it is not remembered.
    }
  };

  const data = graph.data;
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.id, node])), [data]);
  const counts = useMemo(() => {
    const out: Record<GraphNodeKind, number> = { episode: 0, person: 0, tag: 0, agent: 0, collection: 0, document: 0 };
    for (const node of data?.nodes ?? []) out[node.kind] += 1;
    return out;
  }, [data]);

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase();
    if (words.length < 2 || !data) return new Set<string>();
    return new Set(data.nodes.filter((node) => !hidden.has(node.kind) && node.label.toLowerCase().includes(words)).map((node) => node.id));
  }, [data, query, hidden]);

  const choices = useMemo(() => {
    const agentName = new Map((agents.data?.agents ?? []).map((agent) => [agent.id, agent.name || agent.id]));
    return {
      agents: (facets.data?.agents ?? []).map((facet) => ({ ...facet, label: agentName.get(facet.value) ?? facet.value })),
      people: facets.data?.people ?? [],
      tags: (facets.data?.tags ?? []).map((facet) => ({ ...facet, label: `#${facet.value}` })),
    };
  }, [agents.data, facets.data]);

  // A selection the new data no longer has is let go of.
  useEffect(() => {
    if (selected && data && !byId.has(selected)) setSelected(null);
  }, [byId, data, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !reading && !opened) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, opened]);

  const set = (patch: Partial<GraphSearch>) => {
    const next = { ...search, ...patch };
    for (const key of Object.keys(next) as (keyof GraphSearch)[]) {
      const value = next[key];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key];
    }
    onSearch(next);
  };

  /** "Only this": that one alone, in place of whatever of its kind was ticked. */
  const narrowTo = (node: GraphNode) => {
    if (node.kind === "person") set({ people: [keyOf(node.id)] });
    if (node.kind === "tag") set({ tags: [keyOf(node.id)] });
    if (node.kind === "agent") set({ agents: [keyOf(node.id)] });
  };

  const filtered = Boolean(search.agents?.length || search.people?.length || search.tags?.length || (search.range && search.range !== DEFAULT_RANGE));
  const shownKinds = search.knowledge ? KINDS : KINDS.filter((kind) => !KNOWLEDGE_KINDS.includes(kind));

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Link to="/memories" className="text-base-content/65 hover:text-primary inline-flex items-center gap-1.5 text-xs font-semibold transition-colors">
          <ArrowLeft size={14} /> Knowledge & Memory
        </Link>
        <PageHeader
          title="Memory graph"
          description="Every conversation your agents remember, joined to the people in it, its tags and the agent it was with."
          actions={data ? <Stats graph={data} fetching={graph.isFetching} /> : null}
        />
      </div>

      {!operator && me.data ? <EmptyState pose="security" title="Operators only" description="Memory holds what agents know about people, so only an operator can open it." /> : null}

      {operator ? (
        <>
          <Toolbar>
            {/* A row of its own on a phone: beside the filters it was two letters wide ("Find i"). */}
            <label className="input input-sm bg-base-100 min-w-0 flex-1 rounded-xl max-sm:basis-full sm:max-w-64">
              <Search size={14} className="opacity-50" />
              <input
                type="search"
                placeholder="Find in the graph"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && matches.size) setSelected([...matches][0]!);
                }}
              />
              {query.trim().length >= 2 ? <span className="text-base-content/65 text-xs tabular-nums">{matches.size}</span> : null}
            </label>

            <MultiSelect label="Agents" none="All agents" icon={<Bot size={13} className="opacity-50" />} choices={choices.agents} selected={search.agents ?? []} onChange={(agents) => set({ agents })} />
            <MultiSelect label="People" none="Everyone" icon={<User size={13} className="opacity-50" />} choices={choices.people} selected={search.people ?? []} onChange={(people) => set({ people })} />
            <MultiSelect label="Tags" none="Any tag" icon={<Hash size={13} className="opacity-50" />} choices={choices.tags} selected={search.tags ?? []} onChange={(tags) => set({ tags })} />

            <Select label="Range" value={search.range ?? DEFAULT_RANGE} onChange={(range) => set({ range: range === DEFAULT_RANGE ? undefined : (range as GraphSearch["range"]) })}>
              {RANGES.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </Select>

            <Select label="Conversations shown" value={String(search.limit ?? DEFAULT_LIMIT)} onChange={(limit) => set({ limit: Number(limit) === DEFAULT_LIMIT ? undefined : Number(limit) })}>
              {LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  Newest {limit}
                </option>
              ))}
            </Select>

            {/* The knowledge base over the conversations: asked of the daemon, so a switch here rather than in the legend. */}
            <button
              type="button"
              aria-pressed={Boolean(search.knowledge)}
              title={search.knowledge ? "Hide the documents you keep" : "Show the documents you keep, with the conversations"}
              className={`btn btn-sm gap-1.5 rounded-xl ${search.knowledge ? "btn-primary btn-soft" : "btn-ghost border border-base-content/10"}`}
              onClick={() => set({ knowledge: search.knowledge ? undefined : true })}
            >
              <FileText size={14} /> Documents
            </button>

            {filtered ? (
              <button type="button" className="btn btn-ghost btn-sm gap-1 rounded-xl" onClick={() => onSearch({ ...(search.limit ? { limit: search.limit } : {}), ...(search.knowledge ? { knowledge: true } : {}) })}>
                <X size={14} /> Clear
              </button>
            ) : null}
          </Toolbar>

          {graph.error ? <ErrorNote error={graph.error} /> : null}

          <section className="border-base-content/[0.08] bg-base-200/60 relative h-[calc(100dvh-17rem)] min-h-[460px] overflow-hidden rounded-2xl border shadow-xs">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-60"
              style={{ backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--color-base-content) 9%, transparent) 1px, transparent 0)", backgroundSize: "22px 22px" }}
            />
            {data && data.nodes.length > 0 ? (
              <GraphCanvas graph={data} hidden={hidden} selected={selected} matches={matches} onSelect={setSelected} />
            ) : null}

            {data && data.nodes.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center p-6">
                <EmptyState
                  pose={filtered ? "searching" : "sleeping"}
                  title={filtered ? "Nothing matches" : "Nothing remembered yet"}
                  description={filtered ? "No conversation fits this filter. Clear it to see everything." : "Conversations show here once the nightly pass has filed them."}
                />
              </div>
            ) : null}

            {!data && graph.isLoading ? (
              <div className="text-base-content/65 absolute inset-0 grid place-items-center text-sm">
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" /> Gathering memory…
                </span>
              </div>
            ) : null}

            {data && data.nodes.length > 0 ? <Legend kinds={shownKinds} counts={counts} hidden={hidden} onToggle={toggleKind} /> : null}

            {selected && byId.get(selected) && data ? (
              <Panel
                node={byId.get(selected)!}
                graph={data}
                byId={byId}
                tags={facets.data?.tags ?? []}
                onSelect={setSelected}
                onRead={setReading}
                onOpenDocument={(id) => setOpened(documentAt(id))}
                onNarrow={narrowTo}
                onClose={() => setSelected(null)}
              />
            ) : null}
          </section>

          <p className="text-base-content/65 text-xs">
            Drag to move, scroll to zoom, click a dot for what it links to. A tag only one shown conversation has is left out.
            {data?.knowledge ? <KnowledgeNote graph={data} /> : null}
          </p>
        </>
      ) : null}

      <Leaving value={reading}>{(id) => <EpisodeView id={id} editable={operator} nameOf={nameOf} onOpen={setReading} onClose={() => setReading(null)} />}</Leaving>
      <Leaving value={opened}>{(at) => <DocumentDialog at={at} onOpen={setOpened} onClose={() => setOpened(null)} />}</Leaving>
    </div>
  );
}

/** What the documents shown are, and what their dashed lines need. */
function KnowledgeNote({ graph }: { graph: MemoryGraph }) {
  const knowledge = graph.knowledge!;
  const shown = knowledge.total > knowledge.documents ? ` The ${knowledge.documents} most linked and newest of ${knowledge.total} documents are shown.` : "";
  const meaning = knowledge.byMeaning ? " A dashed line joins documents close in meaning." : " Lines between documents close in meaning show once search by meaning is on.";
  return (
    <>
      {shown}
      {meaning}
    </>
  );
}

function Stats({ graph, fetching }: { graph: MemoryGraph; fetching: boolean }) {
  return (
    <div className="border-base-content/[0.08] bg-base-100 flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-xs shadow-xs">
      {fetching ? <Loader2 size={13} className="text-primary animate-spin" /> : <Waypoints size={13} className="text-primary" />}
      <span className="tabular-nums">
        <b className="font-semibold">{graph.episodes.toLocaleString()}</b>
        <span className="text-base-content/65">
          {graph.total > graph.episodes ? ` of ${graph.total.toLocaleString()}` : ""} conversations
          {graph.knowledge ? ` · ${graph.knowledge.documents.toLocaleString()} documents` : ""} · {graph.links.length.toLocaleString()} links
        </span>
      </span>
    </div>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="border-base-content/[0.08] bg-base-100 flex flex-wrap items-center gap-2 rounded-2xl border p-2 shadow-xs">
      <Filter size={14} className="text-base-content/40 ml-1.5 hidden sm:block" />
      {children}
    </div>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select aria-label={label} title={label} className="select select-sm bg-base-100 w-auto max-w-44 rounded-xl" value={value} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  );
}

function Legend({ kinds, counts, hidden, onToggle }: { kinds: readonly GraphNodeKind[]; counts: Record<GraphNodeKind, number>; hidden: ReadonlySet<GraphNodeKind>; onToggle: (kind: GraphNodeKind) => void }) {
  const palette = usePalette();
  return (
    <div className="border-base-content/[0.08] bg-base-100/85 absolute top-3 left-3 flex flex-wrap gap-1 rounded-xl border p-1 shadow-sm backdrop-blur">
      {kinds.map((kind) => {
        const off = hidden.has(kind);
        return (
          <button
            key={kind}
            type="button"
            disabled={kind === "episode"}
            aria-pressed={!off}
            title={kind === "episode" ? "Conversations are always shown" : off ? `Show ${KIND_LABEL[kind].toLowerCase()}` : `Hide ${KIND_LABEL[kind].toLowerCase()}`}
            onClick={() => onToggle(kind)}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-all enabled:hover:bg-base-200 ${off ? "opacity-40" : ""} disabled:cursor-default`}
          >
            <span className="size-2.5 rounded-full" style={{ background: off ? "transparent" : palette.kinds[kind], boxShadow: `0 0 0 1.5px ${palette.kinds[kind]}` }} />
            {KIND_LABEL[kind]}
            <span className="text-base-content/65 tabular-nums">{counts[kind]}</span>
          </button>
        );
      })}
    </div>
  );
}
