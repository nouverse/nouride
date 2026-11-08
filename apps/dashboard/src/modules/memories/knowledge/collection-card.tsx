/**
 * A collection as a card (0.8.20, KNOWLEDGE_BASE §11): what is in it, who may be answered from it, which agents look in
 * it and whom it is about, in sentences; how many documents and sections it holds; and files dropped on it are added.
 */

import { useQuery } from "@tanstack/react-query";
import { Bot, FolderOpen, Hourglass, Loader2, UserRound, Users } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "@/commons/lib/api";
import type { KnowledgeCollection } from "@nouride/wire";
import { CARD } from "@/commons/components/ui/CardGrid";
import { Details } from "@/commons/components/ui/Details";
import { DropOverlay, useFileDrop } from "@/commons/components/ui/FileDrop";
import { cn } from "@/commons/lib/utils";
import type { KnowledgeNames } from "./names";
import { aboutLine, agentsLine, countsLine, readersLine } from "./words";

/** One line of what a collection's settings say, with its icon. */
function SettingLine({ icon: Icon, children }: { icon: typeof Users; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon size={14} className="text-base-content/50 mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

/** Its settings as sentences: who may be answered from it, which agents look in it, whom it is about. */
export function SettingLines({ collection, names }: { collection: KnowledgeCollection; names: KnowledgeNames }) {
  const about = aboutLine(collection.about, names);
  return (
    <ul className="text-base-content/80 space-y-1 text-sm">
      <SettingLine icon={Users}>{readersLine(collection.readers, names)}</SettingLine>
      <SettingLine icon={Bot}>{agentsLine(collection.agents, names.agent)}</SettingLine>
      {about ? <SettingLine icon={UserRound}>{about}</SettingLine> : null}
    </ul>
  );
}

/** Its settings could not be read: closed to all but the admins until they are fixed, and what is wrong under Details. */
export function SettingsProblem({ problem }: { problem: string }) {
  return (
    <div className="border-warning/30 bg-warning/10 text-warning space-y-1 rounded-xl border px-3 py-2 text-xs">
      <p>Its settings could not be read, so only the admins can be answered from it until they are fixed.</p>
      <Details>
        <p>{problem}</p>
      </Details>
    </div>
  );
}

/** The documents waiting for an admin's yes in a collection; none from a daemon that keeps none waiting. */
export function usePending(collection: string) {
  const pending = useQuery({ queryKey: ["knowledge-pending", collection], queryFn: () => api.pendingDocuments(collection), retry: false });
  return pending.data?.pending ?? [];
}

export function CollectionCard({
  collection,
  names,
  editable,
  admin,
  reading,
  onOpen,
  onFiles,
}: {
  collection: KnowledgeCollection;
  names: KnowledgeNames;
  /** An operator: files dropped here are added. */
  editable: boolean;
  admin: boolean;
  reading: readonly string[];
  onOpen: () => void;
  onFiles: (files: File[]) => void;
}) {
  const waiting = usePending(collection.id);
  const { dragging, handlers } = useFileDrop({ onFiles, disabled: !editable });
  return (
    <article
      {...handlers}
      aria-label={collection.name}
      className={cn(CARD, collection.archived && "bg-base-200/40")}
    >
      {dragging ? <DropOverlay label={`Drop to add to ${collection.name}`} /> : null}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="truncate font-semibold tracking-tight">{collection.name}</h3>
          {collection.description ? <p className="text-base-content/65 text-sm">{collection.description}</p> : null}
        </div>
        {collection.archived ? <span className="badge badge-ghost badge-sm shrink-0 font-mono">Archived</span> : null}
      </header>

      <SettingLines collection={collection} names={names} />
      {collection.problem ? <SettingsProblem problem={collection.problem} /> : null}

      {waiting.length ? (
        <button type="button" className="text-warning inline-flex items-center gap-1.5 self-start text-xs font-semibold hover:underline" onClick={onOpen}>
          <Hourglass size={13} aria-hidden="true" /> {waiting.length} waiting for {admin ? "your" : "an admin's"} yes
        </button>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-base-content/65 font-mono text-xs">{countsLine(collection.documents, collection.sections)}</span>
        <span className="flex items-center gap-2">
          {reading.length ? (
            <span className="text-base-content/65 inline-flex items-center gap-1 text-xs">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Reading {reading.length === 1 ? "1 file" : `${reading.length} files`}
            </span>
          ) : null}
          <button type="button" className="btn btn-primary btn-sm gap-1.5 rounded-xl" onClick={onOpen}>
            <FolderOpen size={14} aria-hidden="true" /> Open
          </button>
        </span>
      </footer>
      {editable && !collection.archived ? <p className="text-base-content/65 -mt-1 text-[11px]">Drop files here to add them.</p> : null}
    </article>
  );
}
