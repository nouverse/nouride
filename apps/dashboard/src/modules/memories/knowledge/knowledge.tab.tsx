/**
 * The Knowledge tab (0.8.20, KNOWLEDGE_BASE §11): documents a person keeps for the agents to look things up in, in
 * collections. Each collection a card; one opened shows its documents; a search over all of them shows what an agent
 * would find. Memory learns from conversations; this is what somebody handed over on purpose, kept as it was given.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Library, Plus } from "lucide-react";
import { api } from "@/commons/lib/api";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { CollectionCard } from "./collection-card";
import { CollectionForm } from "./collection-form";
import { CollectionView } from "./collection.view";
import { DocumentDialog, type OpenDocument } from "./document.dialog";
import { useKnowledgeNames } from "./names";
import { KnowledgeSearch } from "./search";
import { useUploads } from "./uploads";
import { CardGrid } from "@/commons/components/ui/CardGrid";

export function KnowledgeTab({ editable, admin }: { editable: boolean; admin: boolean }) {
  const collections = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledge });
  const names = useKnowledgeNames();
  const uploads = useUploads();
  const [open, setOpen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [reading, setReading] = useState<OpenDocument | null>(null);

  const list = collections.data?.collections ?? [];
  const current = open ? list.find((collection) => collection.id === open) : undefined;
  const active = list.filter((collection) => !collection.archived);
  const archived = list.filter((collection) => collection.archived);
  const newCollection = editable ? (
    <button type="button" className="btn btn-primary btn-sm gap-1.5 rounded-xl" onClick={() => setMaking(true)}>
      <Plus size={14} aria-hidden="true" /> New collection
    </button>
  ) : null;
  const card = (collection: (typeof list)[number]) => (
    <CollectionCard
      key={collection.id}
      collection={collection}
      names={names}
      editable={editable}
      admin={admin}
      reading={uploads.reading[collection.id] ?? []}
      onOpen={() => setOpen(collection.id)}
      onFiles={(files) => uploads.add(collection, files)}
    />
  );

  return (
    <div className="space-y-4">
      <ErrorNote error={collections.error} />
      {current ? (
        <CollectionView
          collection={current}
          names={names}
          editable={editable}
          admin={admin}
          reading={uploads.reading[current.id] ?? []}
          onFiles={(files) => uploads.add(current, files)}
          onBack={() => setOpen(null)}
          onOpen={setReading}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-base-content/70 max-w-2xl text-sm">
              Documents you keep for your agents to look things up in: a price list, a manual, a lab result. Your agents answer from a collection only the people it is meant for.
            </p>
            {newCollection}
          </div>
          {list.length ? <KnowledgeSearch onOpen={setReading} /> : null}
          {list.length === 0 && collections.data ? (
            <EmptyState icon={Library} title="No collections yet" description="Make one, then drop files on it or write a document in it." action={newCollection} />
          ) : null}
          {active.length ? <CardGrid>{active.map(card)}</CardGrid> : null}
          {archived.length ? (
            <section className="space-y-2" aria-label="Archived">
              <h3 className="text-base-content/65 text-xs font-semibold uppercase tracking-wider font-mono">Archived</h3>
              <CardGrid>{archived.map(card)}</CardGrid>
            </section>
          ) : null}
        </>
      )}
      {making ? <CollectionForm names={names} admin={admin} onClose={() => setMaking(false)} onSaved={setOpen} /> : null}
      {reading ? <DocumentDialog at={reading} onOpen={setReading} onClose={() => setReading(null)} /> : null}
    </div>
  );
}
