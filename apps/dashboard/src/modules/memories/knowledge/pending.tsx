/**
 * Documents an agent saved from a chat into a collection that more people may be answered from than were in that chat
 * (0.8.20): kept aside until an admin says yes. Approved, it joins the collection and is read;
 * declined, it is deleted. Everyone sees what waits; an admin decides.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Hourglass, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { KnowledgeCollection, PendingDocument } from "@nouride/wire";
import { ago } from "@/commons/lib/format";
import { useToast } from "@/commons/components/ui/toast";
import { usePending } from "./collection-card";

function Waiting({ collection, document, admin }: { collection: KnowledgeCollection; document: PendingDocument; admin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const decide = useMutation({
    mutationFn: async (yes: boolean): Promise<unknown> => (yes ? await api.approvePending(collection.id, document.path) : await api.declinePending(collection.id, document.path)),
    onSuccess: async (_, yes) => {
      toast.success(yes ? `${document.title} added to ${collection.name}` : `${document.title} declined`, yes ? undefined : "It was deleted.");
      for (const key of [["knowledge-pending", collection.id], ["knowledge-documents", collection.id], ["knowledge"], ["memory-graph"]]) await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err, yes) => toast.error(yes ? "Could not add it" : "Could not decline it", err),
  });
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{document.title}</p>
        <p className="text-base-content/65 text-xs">
          From {document.from}, {ago(document.savedAt)}
        </p>
        {document.source ? (
          <a href={document.source} target="_blank" rel="noreferrer noopener" className="text-primary inline-flex max-w-full items-center gap-1 text-xs break-all hover:underline">
            {document.source} <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
          </a>
        ) : null}
      </div>
      {admin ? (
        <span className="flex gap-1.5">
          <button type="button" className="btn btn-primary btn-xs gap-1 rounded-lg" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            <Check size={12} aria-hidden="true" /> Approve
          </button>
          <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
            <X size={12} aria-hidden="true" /> Decline
          </button>
        </span>
      ) : null}
    </li>
  );
}

/** The list, when anything waits; nothing at all otherwise. */
export function PendingList({ collection, admin }: { collection: KnowledgeCollection; admin: boolean }) {
  const waiting = usePending(collection.id);
  if (waiting.length === 0) return null;
  return (
    <section className="border-warning/30 bg-warning/5 rounded-2xl border px-5 py-4" aria-label="Waiting for a yes">
      <h3 className="text-warning flex items-center gap-2 text-sm font-semibold">
        <Hourglass size={14} aria-hidden="true" /> {admin ? "Waiting for your yes" : "Waiting for an admin's yes"}
      </h3>
      <p className="text-base-content/65 mt-0.5 text-xs">
        An agent saved these from a chat. More people may be answered from {collection.name} than were in that chat, so each waits for an admin before it is added.
      </p>
      <ul className="divide-base-content/[0.06] mt-2 divide-y">
        {waiting.map((document) => (
          <Waiting key={document.path} collection={collection} document={document} admin={admin} />
        ))}
      </ul>
    </section>
  );
}
