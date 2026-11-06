/**
 * Searching the collections (0.8.20, KNOWLEDGE_BASE §11): the sections search finds for some words, by words and, when
 * it is on, by meaning — what an agent looking in them would find. Asked on the button, never on each key pressed.
 */

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Search, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import { ErrorNote } from "@/commons/components/ui/ui";
import type { OpenDocument } from "./document.dialog";
import { pagesLine } from "./words";

/** How much of a section's words a hit shows: enough to see why it was found. */
const EXCERPT = 240;

export function KnowledgeSearch({ onOpen }: { onOpen: (at: OpenDocument) => void }) {
  const [words, setWords] = useState("");
  const search = useMutation({ mutationFn: (query: string) => api.searchKnowledge(query) });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (words.trim()) search.mutate(words.trim());
  };
  const hits = search.data?.hits ?? [];

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <label className="input flex min-w-0 flex-1 items-center gap-2 rounded-xl">
          <Search size={15} className="opacity-50" aria-hidden="true" />
          <input
            type="search"
            value={words}
            onChange={(event) => setWords(event.target.value)}
            placeholder="Search your documents: hotel allowance, router password…"
            className="min-w-0 flex-1 bg-transparent outline-none"
            aria-label="Search your documents"
          />
        </label>
        <button type="submit" className="btn btn-primary rounded-xl gap-2" disabled={!words.trim() || search.isPending}>
          {search.isPending ? <span className="loading loading-spinner loading-xs" /> : <Search size={15} aria-hidden="true" />} Search
        </button>
        {search.data ? (
          <button type="button" className="btn btn-ghost rounded-xl gap-1" onClick={() => search.reset()}>
            <X size={14} aria-hidden="true" /> Clear
          </button>
        ) : null}
      </form>
      <ErrorNote error={search.error} />
      {search.data ? (
        <section className="border-base-content/[0.08] bg-base-100/80 rounded-2xl border px-5 py-4" aria-label="What search found">
          <p className="text-base-content/65 text-xs">
            {hits.length === 0 ? "Nothing found. Try other words." : `${hits.length === 1 ? "1 section" : `${hits.length} sections`} found, best first: what your agents would find.`}
          </p>
          <ul className="divide-base-content/[0.06] mt-2 max-h-[28rem] divide-y overflow-y-auto overscroll-contain">
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
        </section>
      ) : null}
    </div>
  );
}
