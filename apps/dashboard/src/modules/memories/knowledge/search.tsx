/**
 * Searching the collections (0.8.20): the sections search finds for some words, by words and, when
 * it is on, by meaning — what an agent looking in them would find. Asked on the button, never on each key pressed.
 */

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { X } from "lucide-react";
import { SearchForm } from "@/commons/components/ui/SearchForm";
import { StickyTools } from "@/commons/components/ui/StickyBar";
import { api } from "@/commons/lib/api";
import { ErrorNote } from "@/commons/components/ui/ui";
import type { OpenDocument } from "./document.dialog";
import { pagesLine } from "./words";
import { Expandable } from "@/commons/components/ui/ListCard";

/** How much of a section's words a hit shows: enough to see why it was found. */
const EXCERPT = 240;

export function KnowledgeSearch({ onOpen }: { onOpen: (at: OpenDocument) => void }) {
  const [words, setWords] = useState("");
  const search = useMutation({ mutationFn: (query: string) => api.searchKnowledge(query) });
  const hits = search.data?.hits ?? [];

  return (
    <div className="space-y-3">
      {/* In the row that stays at the top of the window, beside Memory's tabs. */}
      <StickyTools fill>
        <SearchForm
          value={words}
          onChange={setWords}
          onSearch={(query) => search.mutate(query)}
          placeholder="Search your documents: hotel allowance, router password…"
          label="Search your documents"
          busy={search.isPending}
          after={
            search.data ? (
              <button type="button" className="btn btn-ghost btn-sm rounded-xl gap-1" onClick={() => search.reset()}>
                <X size={14} aria-hidden="true" /> Clear
              </button>
            ) : null
          }
        />
      </StickyTools>
      <ErrorNote error={search.error} />
      {search.data ? (
        <section className="border-base-content/[0.08] bg-base-100/80 rounded-2xl border px-5 py-4" aria-label="What search found">
          <p className="text-base-content/65 text-xs">
            {hits.length === 0 ? "Nothing found. Try other words." : `${hits.length === 1 ? "1 section" : `${hits.length} sections`} found, best first: what your agents would find.`}
          </p>
          <Expandable maxHeight="max-h-[28rem]" className="mt-2">
            <ul className="divide-base-content/[0.06] divide-y">
              {hits.map((hit) => {
                const pages = pagesLine(hit);
                return (
                  <li key={hit.item}>
                    <button type="button" className="hover:bg-base-200/60 w-full rounded-lg px-2 py-2.5 text-left transition-colors" onClick={() => onOpen({ collection: hit.collection, path: hit.path })}>
                      <span className="text-base-content/65 block text-[11px] font-mono">
                        {hit.collectionName} · {hit.trail}
                        {pages ? ` · ${pages}` : ""}
                      </span>
                      <span className="mt-0.5 line-clamp-3 block text-sm">{hit.text.length > EXCERPT ? `${hit.text.slice(0, EXCERPT).trimEnd()}…` : hit.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Expandable>
        </section>
      ) : null}
    </div>
  );
}
