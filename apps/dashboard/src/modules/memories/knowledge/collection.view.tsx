/**
 * One collection, opened (0.8.20, KNOWLEDGE_BASE §11): its settings in sentences and what can be done with it, the
 * documents waiting for an admin's yes, and its documents, each with how it reads. Files are added by dropping them on
 * the list or picking them; a document is written on the page.
 *
 * Who may do what follows the routes: an operator adds and removes documents, changes the settings and archives; who
 * may be answered beyond the person who made it, and deleting, are an admin's.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowLeft, FilePlus2, PenLine, Settings2, Trash2, Upload } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { KnowledgeCollection } from "@/commons/lib/api.knowledge";
import { useConfirm } from "@/commons/components/ui/confirm";
import { DropOverlay, useFileDrop } from "@/commons/components/ui/FileDrop";
import { useToast } from "@/commons/components/ui/toast";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { SettingLines, SettingsProblem } from "./collection-card";
import { CollectionForm } from "./collection-form";
import type { OpenDocument } from "./document.dialog";
import { DocumentList } from "./documents";
import type { KnowledgeNames } from "./names";
import { PendingList } from "./pending";
import { countsLine } from "./words";
import { WriteDialog } from "./write.dialog";
import { Leaving } from "@/commons/components/ui/OverPage";
import { ListLoading } from "@/commons/components/ui/Spinner";

export function CollectionView({
  collection,
  names,
  editable,
  admin,
  reading,
  onFiles,
  onBack,
  onOpen,
}: {
  collection: KnowledgeCollection;
  names: KnowledgeNames;
  editable: boolean;
  admin: boolean;
  reading: readonly string[];
  onFiles: (files: File[]) => void;
  onBack: () => void;
  onOpen: (at: OpenDocument) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const picker = useRef<HTMLInputElement>(null);
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState(false);
  const documents = useQuery({ queryKey: ["knowledge-documents", collection.id], queryFn: () => api.knowledgeDocuments(collection.id) });
  const { dragging, handlers } = useFileDrop({ onFiles, disabled: !editable });

  const refresh = async () => {
    for (const key of [["knowledge"], ["memory-graph"]]) await queryClient.invalidateQueries({ queryKey: key });
  };
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.updateCollection(collection.id, { archived }),
    onSuccess: async (_, archived) => {
      toast.success(archived ? `${collection.name} archived` : `${collection.name} brought back`, archived ? "Kept, and your agents no longer look in it." : "Your agents look in it again.");
      await refresh();
    },
    onError: (err) => toast.error("Could not change it", err),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCollection(collection.id),
    onSuccess: async () => {
      toast.success(`${collection.name} deleted`);
      await refresh();
      onBack();
    },
    onError: (err) => toast.error(`Could not delete ${collection.name}`, err),
  });
  const askDelete = async () => {
    const count = collection.documents === 1 ? "Its document goes with it." : `Its ${collection.documents} documents go with it.`;
    const yes = await confirm.ask({
      title: `Delete ${collection.name}?`,
      body: `${collection.documents ? count : "It holds no documents."} The backups made before now keep a copy until they are replaced. This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (yes) remove.mutate();
  };

  const list = documents.data?.documents ?? [];
  return (
    <div className="space-y-4">
      <button type="button" className="text-base-content/65 hover:text-primary inline-flex items-center gap-1.5 text-xs font-semibold transition-colors" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" /> All collections
      </button>

      <Card
        title={collection.name}
        {...(collection.description ? { description: collection.description } : {})}
        actions={
          editable ? (
            <>
              <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-xl" onClick={() => setEditing(true)}>
                <Settings2 size={14} aria-hidden="true" /> Settings
              </button>
              <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-xl" disabled={archive.isPending} onClick={() => archive.mutate(!collection.archived)}>
                {collection.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                {collection.archived ? "Bring back" : "Archive"}
              </button>
              {admin ? (
                <button type="button" className="btn btn-ghost btn-sm text-error gap-1.5 rounded-xl hover:bg-error/10" disabled={remove.isPending} onClick={() => void askDelete()}>
                  <Trash2 size={14} aria-hidden="true" /> Delete
                </button>
              ) : null}
            </>
          ) : null
        }
      >
        <div className="space-y-3">
          <SettingLines collection={collection} names={names} />
          {collection.problem ? <SettingsProblem problem={collection.problem} /> : null}
          {collection.archived ? <p className="text-base-content/70 text-sm">Archived: kept here, and your agents do not look in it.</p> : null}
          <p className="text-base-content/65 font-mono text-xs">{countsLine(collection.documents, collection.sections)}</p>
        </div>
      </Card>

      <PendingList collection={collection} admin={admin} />

      <section {...handlers} className="relative" aria-label="Documents">
        {dragging ? <DropOverlay label={`Drop to add to ${collection.name}`} /> : null}
        <Card
          title="Documents"
          description={editable ? "Drop files here to add them, or write one. Pictures, videos and scanned pages are kept, not searched." : "What your agents can look things up in."}
          actions={
            editable ? (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    // Cleared, so picking the same file again is still a change.
                    event.target.value = "";
                    if (files.length) onFiles(files);
                  }}
                />
                <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-xl" onClick={() => picker.current?.click()}>
                  <Upload size={14} aria-hidden="true" /> Add files
                </button>
                <button type="button" className="btn btn-primary btn-sm gap-1.5 rounded-xl" onClick={() => setWriting(true)}>
                  <PenLine size={14} aria-hidden="true" /> Write a document
                </button>
              </>
            ) : null
          }
        >
          <ErrorNote error={documents.error} />
          {documents.isPending ? (
            <ListLoading />
          ) : (
            <DocumentList
              collection={collection}
              documents={list}
              reading={reading}
              editable={editable}
              onOpen={(path) => onOpen({ collection: collection.id, path })}
              empty={<EmptyState icon={FilePlus2} title="No documents yet" description={editable ? "Drop files here, or write one." : "Nothing has been added to it yet."} />}
            />
          )}
        </Card>
      </section>

      <Leaving value={writing}>{() => <WriteDialog collection={collection} onClose={() => setWriting(false)} />}</Leaving>
      <Leaving value={editing}>{() => <CollectionForm collection={collection} names={names} admin={admin} onClose={() => setEditing(false)} />}</Leaving>
      {confirm.dialog}
    </div>
  );
}
