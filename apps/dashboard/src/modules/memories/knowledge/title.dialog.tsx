/**
 * A document's title, set on its row (0.8.23): the words search finds it by, kept beside its file's name, which does not
 * change. Emptied and saved, the title the document gives itself comes back.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Save, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { KnowledgeCollection, KnowledgeDocument } from "@/commons/lib/api.knowledge";
import { overPage } from "@/commons/components/ui/OverPage";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import { TITLE_HINT } from "./words";

export function TitleDialog({ collection, document, onClose }: { collection: KnowledgeCollection; document: KnowledgeDocument; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(document.title);

  const save = useMutation({
    mutationFn: () => api.setDocumentTitle(collection.id, document.path, title.trim() || null),
    onSuccess: async ({ document: saved }) => {
      toast.success(title.trim() ? `Title saved: ${saved?.title ?? title.trim()}` : `${saved?.title ?? document.path} has its own title again`);
      for (const key of [["knowledge-documents", collection.id], ["knowledge"], ["memory-graph"]]) await queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
  });

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={`The title of ${document.title}`}>
      <form
        className="modal-box flex max-w-lg flex-col gap-3 rounded-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <h3 className="font-semibold">Title</h3>
            <p className="text-base-content/65 break-all text-xs">{document.path} keeps its name.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <Field label="Title" hint={TITLE_HINT}>
          <input className="input w-full rounded-xl text-sm" value={title} maxLength={200} aria-label="Title" onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm gap-1.5 rounded-xl" disabled={save.isPending}>
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : <Save size={14} aria-hidden="true" />} Save
          </button>
        </div>
      </form>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>,
  );
}
