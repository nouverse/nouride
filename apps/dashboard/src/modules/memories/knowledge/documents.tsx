/**
 * A collection's documents (0.8.20, KNOWLEDGE_BASE §6 and §11), each with how it reads: ready to search, being read, or
 * could not be read and why. Where a program has to be installed first, the Ask button opens a chat with the
 * orchestrator, the request already written; the package's name is under Details.
 *
 * Newest first, each saying when it was added (0.8.23): sorted by name, a file just dropped landed somewhere down the
 * list, and nothing said which one was new (the owner, 2026-11-08). Its title, what search finds it by, is set on its row.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FileText, FileWarning, Loader2, Pencil, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { KnowledgeCollection, KnowledgeDocument } from "@/commons/lib/api.knowledge";
import { formatBytes } from "@/commons/lib/format";
import { cn } from "@/commons/lib/utils";
import { AskAgentButton } from "@/commons/components/ui/AskAgentButton";
import { useConfirm } from "@/commons/components/ui/confirm";
import { Details } from "@/commons/components/ui/Details";
import { useToast } from "@/commons/components/ui/toast";
import { TitleDialog } from "./title.dialog";
import { addedLine, installMessage, statusOf } from "./words";

const TONE = { ready: "badge-success", reading: "badge-info", "not-read": "badge-warning" } as const;

/** The file's name, unless it is the title and a page of text: a document written here is named after its title. */
function fileName(document: Pick<KnowledgeDocument, "path" | "title">): string | null {
  const text = /^(.*)\.(md|markdown|txt)$/i.exec(document.path);
  return text && text[1]!.toLowerCase() === document.title.toLowerCase() ? null : document.path;
}

function Status({ label, tone }: { label: string; tone: keyof typeof TONE }) {
  return <span className={cn("badge badge-sm badge-soft shrink-0 font-mono", TONE[tone])}>{label}</span>;
}

/** A file on its way in: shown until the collection's documents say how it reads. */
function Reading({ name }: { name: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Loader2 size={16} className="text-base-content/50 shrink-0 animate-spin" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      <Status label="Being read" tone="reading" />
    </li>
  );
}

function DocumentRow({ collection, document, editable, onOpen }: { collection: KnowledgeCollection; document: KnowledgeDocument; editable: boolean; onOpen: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [titling, setTitling] = useState(false);
  const status = statusOf(document);
  const file = fileName(document);
  const remove = useMutation({
    mutationFn: () => api.removeDocument(collection.id, document.path),
    onSuccess: async () => {
      toast.success(`${document.title} removed`);
      for (const key of [["knowledge-documents", collection.id], ["knowledge"], ["memory-graph"]]) await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(`Could not remove ${document.title}`, err),
  });
  const askRemove = async () => {
    const yes = await confirm.ask({
      title: `Remove ${document.title}?`,
      body: "It is deleted from this collection, and your agents stop finding it. The backups made before now keep a copy until they are replaced.",
      confirmLabel: "Remove",
    });
    if (yes) remove.mutate();
  };
  const Icon = status.tone === "ready" ? FileText : FileWarning;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon size={16} className={cn("mt-0.5 shrink-0", status.tone === "ready" ? "text-base-content/50" : "text-warning")} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <button type="button" className="hover:text-primary max-w-full truncate text-left text-sm font-medium transition-colors" onClick={onOpen}>
          {document.title}
        </button>
        <p className="text-base-content/65 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Status label={status.label} tone={status.tone} />
          {file ? <span className="font-mono break-all">{file}</span> : null}
          <span>{formatBytes(document.size)}</span>
          <span title={new Date(document.mtime).toLocaleString()}>{addedLine(document.mtime)}</span>
        </p>
        {document.reason ? <p className="text-base-content/70 text-xs">{document.reason}</p> : null}
        {document.needs ? (
          <div className="space-y-1.5 pt-0.5">
            <AskAgentButton task="to install it" message={installMessage(document.needs, document.title, collection.name)} />
            <Details>
              <p>It needs the {document.needs} package.</p>
            </Details>
          </div>
        ) : null}
      </div>
      {editable ? (
        <button type="button" className="btn btn-ghost btn-xs rounded-lg" aria-label={`Change the title of ${document.title}`} title="Change the title" onClick={() => setTitling(true)}>
          <Pencil size={13} />
        </button>
      ) : null}
      {editable ? (
        <button type="button" className="btn btn-ghost btn-xs text-error rounded-lg hover:bg-error/10" aria-label={`Remove ${document.title}`} title={`Remove ${document.title}`} disabled={remove.isPending} onClick={() => void askRemove()}>
          <Trash2 size={13} />
        </button>
      ) : null}
      {confirm.dialog}
      {titling ? <TitleDialog collection={collection} document={document} onClose={() => setTitling(false)} /> : null}
    </li>
  );
}

export function DocumentList({
  collection,
  documents,
  reading,
  editable,
  onOpen,
}: {
  collection: KnowledgeCollection;
  documents: readonly KnowledgeDocument[];
  /** Files on their way in, by name. */
  reading: readonly string[];
  editable: boolean;
  onOpen: (path: string) => void;
}) {
  const sorted = [...documents].sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title));
  return (
    <ul className="divide-base-content/[0.06] divide-y">
      {reading.map((name, n) => (
        <Reading key={`${name}-${n}`} name={name} />
      ))}
      {sorted.map((document) => (
        <DocumentRow key={document.path} collection={collection} document={document} editable={editable} onOpen={() => onOpen(document.path)} />
      ))}
    </ul>
  );
}
