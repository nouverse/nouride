/**
 * "Documents about them" on a person in People (0.8.20): the documents of every collection whose
 * settings say it is about them. It says nothing of who may be answered from those documents, which is the
 * collection's own setting: being about somebody lets them read nothing.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { OpenDocument } from "./document.dialog";
import { listed } from "@/commons/lib/listed";

export function DocumentsAbout({ person, onOpen }: { person: string; onOpen: (at: OpenDocument) => void }) {
  const collections = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledge, retry: false });
  const about = (collections.data?.collections ?? []).filter((collection) => collection.about.includes(person));
  const documents = useQueries({
    queries: about.map((collection) => ({ queryKey: ["knowledge-documents", collection.id], queryFn: () => api.knowledgeDocuments(collection.id) })),
  });
  if (about.length === 0) return null;
  const rows = about.flatMap((collection, n) => (documents[n]?.data?.documents ?? []).map((document) => ({ collection, document })));
  return (
    <section className="space-y-1.5" aria-label="Documents about them">
      <h4 className="text-base-content/85 text-xs font-semibold uppercase tracking-wider font-mono">Documents about them</h4>
      {rows.length === 0 ? (
        <p className="text-base-content/65 text-sm">None yet in {listed(about.map((collection) => collection.name))}.</p>
      ) : (
        <ul className="-mx-2">
          {rows.map(({ collection, document }) => (
            <li key={`${collection.id}/${document.path}`}>
              <button
                type="button"
                className="hover:bg-base-200/70 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors"
                onClick={() => onOpen({ collection: collection.id, path: document.path })}
              >
                <FileText size={14} className="text-base-content/50 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{document.title}</span>
                <span className="text-base-content/65 shrink-0 text-xs">in {collection.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
