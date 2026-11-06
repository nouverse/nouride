/**
 * The graph's side panel: what one dot is and what it links to, a click on each. A conversation is read from here, a
 * person, tag or agent narrows the graph to itself, and with the knowledge layer (0.8.20) a document is opened and a
 * collection lists the documents shown of it. Out of `graph.page.tsx` when the layer grew it.
 */

import { Bot, FileText, Filter, Hash, Library, MessageCircle, User, X } from "lucide-react";
import { useMemo } from "react";
import type { Facet, GraphNode, GraphNodeKind, MemoryGraph } from "@/commons/lib/api.memory";
import { stars } from "../episode-view";
import { MergeTag } from "./merge-tag";
import { KIND_LABEL, usePalette } from "./palette";

const KIND_ICON: Record<GraphNodeKind, typeof User> = { episode: MessageCircle, person: User, tag: Hash, agent: Bot, collection: Library, document: FileText };
const PANEL_LIST = 40;

/** The id without its kind: `p:gading` → `gading`, which is what a filter names. */
export const keyOf = (id: string) => id.slice(2);

/** A document's node read back as the document: `d:<collection>/<path>`, a collection's id holding no `/`. */
export function documentAt(id: string): { collection: string; path: string } {
  const key = keyOf(id);
  const at = key.indexOf("/");
  return { collection: key.slice(0, at), path: key.slice(at + 1) };
}

/** Which kinds narrow the graph to themselves: a filter names them. */
const NARROWS: readonly GraphNodeKind[] = ["person", "tag", "agent"];

function Linked({ title, nodes, more, onSelect }: { title: string; nodes: readonly GraphNode[]; more?: string; onSelect: (id: string) => void }) {
  if (nodes.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-base-content/65 text-[11px] font-semibold tracking-wide uppercase font-mono">{title}</p>
      <ul className="-mx-2">
        {nodes.slice(0, PANEL_LIST).map((other) => (
          <li key={other.id}>
            <button type="button" onClick={() => onSelect(other.id)} className="hover:bg-base-200/70 w-full rounded-lg px-2 py-1.5 text-left transition-colors">
              {other.day ? <span className="text-base-content/65 block text-[11px] tabular-nums">{other.day}</span> : null}
              <span className="line-clamp-2 text-xs leading-snug">{other.label}</span>
            </button>
          </li>
        ))}
      </ul>
      {nodes.length > PANEL_LIST ? (
        <p className="text-base-content/65 px-0.5 text-xs">
          and {nodes.length - PANEL_LIST} more.{more ? ` ${more}` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function Panel({
  node,
  graph,
  byId,
  tags,
  onSelect,
  onRead,
  onOpenDocument,
  onNarrow,
  onClose,
}: {
  node: GraphNode;
  graph: MemoryGraph;
  byId: ReadonlyMap<string, GraphNode>;
  tags: readonly Facet[];
  onSelect: (id: string) => void;
  onRead: (episode: string) => void;
  onOpenDocument: (id: string) => void;
  onNarrow: (node: GraphNode) => void;
  onClose: () => void;
}) {
  const palette = usePalette();
  const Icon = KIND_ICON[node.kind];
  const linked = useMemo(() => {
    const out: GraphNode[] = [];
    for (const link of graph.links) {
      const other = link.source === node.id ? link.target : link.target === node.id ? link.source : null;
      const found = other ? byId.get(other) : undefined;
      if (found && !out.includes(found)) out.push(found);
    }
    return out;
  }, [graph, byId, node.id]);

  const conversations = linked.filter((other) => other.kind === "episode").sort((a, b) => (b.day ?? "").localeCompare(a.day ?? ""));
  const documents = linked.filter((other) => other.kind === "document").sort((a, b) => a.label.localeCompare(b.label));
  const hubs = linked.filter((other) => other.kind !== "episode" && other.kind !== "document");

  return (
    <aside className="border-base-content/[0.08] bg-base-100/92 absolute inset-x-3 bottom-3 max-h-[55%] overflow-y-auto rounded-2xl border shadow-lg backdrop-blur sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-auto sm:max-h-[calc(100%-1.5rem)] sm:w-80">
      <div className="bg-base-100/95 sticky top-0 flex items-start gap-3 border-b border-base-content/[0.06] p-4 backdrop-blur">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl" style={{ background: `${palette.kinds[node.kind]}22`, color: palette.kinds[node.kind] }}>
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base-content/65 text-[11px] font-semibold tracking-wide uppercase font-mono">
            {node.kind === "episode" ? node.day : KIND_LABEL[node.kind].replace(/s$/, "")}
            {node.importance ? <span className="ml-2 tracking-normal normal-case">{stars(node.importance)}</span> : null}
          </p>
          <h3 className={`font-semibold leading-snug ${node.kind === "episode" ? "text-sm" : "text-base"}`}>{node.kind === "tag" ? `#${node.label}` : node.label}</h3>
        </div>
        <button type="button" className="btn btn-ghost btn-xs btn-square rounded-lg" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {node.kind === "episode" ? (
          <button type="button" className="btn btn-primary btn-sm w-full rounded-xl" onClick={() => onRead(keyOf(node.id))}>
            <MessageCircle size={14} /> Read conversation
          </button>
        ) : node.kind === "document" ? (
          <button type="button" className="btn btn-primary btn-sm w-full rounded-xl" onClick={() => onOpenDocument(node.id)}>
            <FileText size={14} /> Open document
          </button>
        ) : node.kind === "collection" ? (
          <span className="text-base-content/65 text-xs">
            Holds <b className="text-base-content">{documents.length}</b> shown document{documents.length === 1 ? "" : "s"}
          </span>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-base-content/65 text-xs">
              In <b className="text-base-content">{conversations.length}</b> shown conversation{conversations.length === 1 ? "" : "s"}
            </span>
            {NARROWS.includes(node.kind) ? (
              <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" onClick={() => onNarrow(node)}>
                <Filter size={12} /> Only this
              </button>
            ) : null}
          </div>
        )}

        {node.kind === "tag" ? <MergeTag key={node.id} tag={node.label} tags={tags} onMerged={onClose} /> : null}

        {hubs.length ? (
          <div className="flex flex-wrap gap-1.5">
            {hubs.map((hub) => (
              <button
                key={hub.id}
                type="button"
                onClick={() => onSelect(hub.id)}
                className="hover:bg-base-200 inline-flex items-center gap-1.5 rounded-lg border border-base-content/[0.08] px-2 py-0.5 text-xs transition-colors"
              >
                <span className="size-2 rounded-full" style={{ background: palette.kinds[hub.kind] }} />
                {hub.kind === "tag" ? `#${hub.label}` : hub.label}
              </button>
            ))}
          </div>
        ) : null}

        <Linked
          title={node.kind === "episode" ? "Related" : "Conversations"}
          nodes={conversations}
          {...(NARROWS.includes(node.kind) ? { more: '"Only this" shows them all.' } : {})}
          onSelect={onSelect}
        />
        <Linked title={node.kind === "document" ? "Linked documents" : "Documents"} nodes={documents} onSelect={onSelect} />
      </div>
    </aside>
  );
}
