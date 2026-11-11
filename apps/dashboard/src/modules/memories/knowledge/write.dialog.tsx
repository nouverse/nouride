/**
 * A document written on the page (0.8.20): a title and its text in Markdown, with the Files tab's
 * Edit and Preview, saved into the collection under its title. Closing with something written asks first.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Save, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { KnowledgeCollection } from "@nouride/wire";
import { useConfirm } from "@/commons/components/ui/confirm";
import { EditPreviewSwitch, MarkdownArea, type MarkdownMode } from "@/commons/components/ui/MarkdownEditor";
import { overPage } from "@/commons/components/ui/OverPage";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import { TITLE_HINT } from "./words";

export function WriteDialog({ collection, onClose }: { collection: KnowledgeCollection; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<MarkdownMode>("edit");

  const save = useMutation({
    mutationFn: () => api.writeDocument(collection.id, title.trim(), text),
    onSuccess: async ({ saved }) => {
      const first = saved[0];
      if (first && first.status !== "indexed") toast.warning(`${title.trim()} saved, not searched`, first.reason);
      else toast.success(`${title.trim()} saved to ${collection.name}`);
      for (const key of [["knowledge-documents", collection.id], ["knowledge"], ["memory-graph"]]) await queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
  });

  const close = async () => {
    if (title.trim() || text.trim()) {
      const discard = await confirm.ask({ title: "Discard this document?", body: "What you wrote has not been saved.", confirmLabel: "Discard" });
      if (!discard) return;
    }
    onClose();
  };

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={`Write a document in ${collection.name}`}>
      <form
        className="modal-box flex max-h-[90dvh] max-w-3xl flex-col gap-3 rounded-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() && text.trim()) save.mutate();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <h3 className="font-semibold">Write a document</h3>
            <p className="text-base-content/65 text-xs">In {collection.name}. Headings split it into the sections search finds.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={() => void close()}>
            <X size={16} />
          </button>
        </div>
        <Field label="Title" hint={TITLE_HINT}>
          <input className="input w-full rounded-xl text-sm" value={title} maxLength={100} placeholder="How to reset the router" onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <span className="text-base-content/65 text-xs">Markdown</span>
          <EditPreviewSwitch mode={mode} onChange={setMode} />
        </div>
        <MarkdownArea
          mode={mode}
          className="h-[45dvh] min-h-48 overflow-auto"
          value={text}
          label="The document"
          placeholder={"## Steps\n1. …"}
          onChange={setText}
        />
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={() => void close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm gap-1.5 rounded-xl" disabled={!title.trim() || !text.trim() || save.isPending}>
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : <Save size={14} aria-hidden="true" />} Save
          </button>
        </div>
      </form>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={() => void close()} />
      {/* Beside the form, not in it: the question carries a form of its own, and a form holds no other. */}
      {confirm.dialog}
    </div>,
  );
}
