/**
 * A document opened (0.8.20, KNOWLEDGE_BASE §11): its sections as search sees them, each under the headings it sits in
 * and with its pages, and its **Related documents**, the nearest by meaning, each one a click away.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { FileText, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import { overPage } from "@/commons/components/ui/OverPage";
import { ErrorNote } from "@/commons/components/ui/ui";
import { pagesLine, statusOf } from "./words";

/** A document by its collection and its path in it. */
export interface OpenDocument {
  collection: string;
  path: string;
}

function Related({ at, onOpen }: { at: OpenDocument; onOpen: (next: OpenDocument) => void }) {
  const related = useQuery({ queryKey: ["knowledge-related", at.collection, at.path], queryFn: () => api.relatedDocuments(at.collection, at.path), retry: false });
  const list = related.data?.related ?? [];
  return (
    <section className="space-y-1.5">
      <h4 className="text-base-content/85 text-xs font-semibold uppercase tracking-wider font-mono">Related documents</h4>
      {related.isPending ? <span className="loading loading-spinner loading-xs opacity-60" /> : null}
      {related.data && !related.data.byMeaning ? (
        <p className="text-base-content/65 text-xs">Shown when search by meaning is on. It is set in the Settings tab.</p>
      ) : null}
      {related.data?.byMeaning && list.length === 0 ? <p className="text-base-content/65 text-xs">Nothing else here is close to it in meaning yet.</p> : null}
      {list.length ? (
        <ul className="-mx-2">
          {list.map((document) => (
            <li key={`${document.collection}/${document.path}`}>
              <button
                type="button"
                className="hover:bg-base-200/70 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors"
                onClick={() => onOpen({ collection: document.collection, path: document.path })}
              >
                <FileText size={14} className="text-base-content/50 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{document.title}</span>
                <span className="text-base-content/65 shrink-0 text-xs">in {document.collectionName}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function DocumentDialog({ at, onOpen, onClose }: { at: OpenDocument; onOpen: (next: OpenDocument) => void; onClose: () => void }) {
  const opened = useQuery({ queryKey: ["knowledge-document", at.collection, at.path], queryFn: () => api.knowledgeDocument(at.collection, at.path) });
  const collections = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledge });
  const collection = collections.data?.collections.find((candidate) => candidate.id === at.collection);
  const document = opened.data?.document;
  const sections = opened.data?.sections ?? [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={document?.title ?? "Document"}>
      <div className="modal-box flex max-h-[90vh] max-w-3xl flex-col gap-4 rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="font-semibold">{document?.title ?? at.path}</h3>
            {document ? (
              <p className="text-base-content/65 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                <span>In {collection?.name ?? at.collection}</span>
                <span>{statusOf(document).label}</span>
                <span>{sections.length === 1 ? "1 section" : `${sections.length} sections`}</span>
              </p>
            ) : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <ErrorNote error={opened.error} />
        {document?.reason ? <p className="text-base-content/70 text-sm">{document.reason}</p> : null}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
          {opened.isPending ? (
            <div className="flex justify-center py-10">
              <span className="loading loading-spinner loading-md opacity-60" />
            </div>
          ) : null}
          {document && sections.length === 0 ? <p className="text-base-content/65 text-sm">Nothing in it is searched.</p> : null}
          {sections.length ? (
            <section className="space-y-1.5">
              <h4 className="text-base-content/85 text-xs font-semibold uppercase tracking-wider font-mono">As search sees it</h4>
              <ol className="space-y-2">
                {sections.map((section) => {
                  const pages = pagesLine(section);
                  return (
                    <li key={section.n} className="border-base-content/[0.06] bg-base-200/40 rounded-xl border px-4 py-3">
                      <p className="text-base-content/65 mb-1 text-[11px] font-mono">
                        {section.trail}
                        {pages ? ` · ${pages}` : ""}
                      </p>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{section.text}</p>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
          {document ? <Related at={at} onOpen={onOpen} /> : null}
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>,
  );
}
