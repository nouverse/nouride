/**
 * Files dropped on a collection, on its card or in it (0.8.20): sent through the dashboard's upload, and shown as being
 * read until each is, wherever the collection is drawn. Held by the tab rather than by the card, so a file dropped on a
 * card is still shown as being read once the collection is opened.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api } from "@/commons/lib/api";
import type { KnowledgeCollection } from "@/commons/lib/api.knowledge";
import { useToast } from "@/commons/components/ui/toast";

export interface Uploads {
  /** The names of the files on their way into each collection, by its id. */
  reading: Readonly<Record<string, readonly string[]>>;
  add: (collection: KnowledgeCollection, files: File[]) => void;
}

/** What an upload's answer says to a person: how many went in, and how many could not be read. */
export function addedLine(collection: string, saved: readonly { status: string }[]): { title: string; detail?: string } {
  const notRead = saved.filter((document) => document.status !== "indexed").length;
  const title = saved.length === 1 ? `Added to ${collection}` : `${saved.length} documents added to ${collection}`;
  if (notRead === 0) return { title };
  return { title, detail: notRead === saved.length && saved.length === 1 ? "It could not be read: open the collection to see why." : `${notRead} could not be read: open the collection to see why.` };
}

export function useUploads(): Uploads {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reading, setReading] = useState<Record<string, readonly string[]>>({});

  const add = useCallback(
    (collection: KnowledgeCollection, files: File[]) => {
      const names = files.map((file) => file.name);
      setReading((now) => ({ ...now, [collection.id]: [...(now[collection.id] ?? []), ...names] }));
      void api
        .uploadDocuments(collection.id, files)
        .then(({ saved }) => {
          const said = addedLine(collection.name, saved);
          if (said.detail) toast.warning(said.title, said.detail);
          else toast.success(said.title);
        })
        .catch((err: unknown) => toast.error(`Could not add to ${collection.name}`, err))
        .finally(async () => {
          setReading((now) => {
            const left = [...(now[collection.id] ?? [])];
            for (const name of names) {
              const at = left.indexOf(name);
              if (at >= 0) left.splice(at, 1);
            }
            return { ...now, [collection.id]: left };
          });
          for (const key of [["knowledge"], ["knowledge-documents", collection.id], ["memory-graph"]]) await queryClient.invalidateQueries({ queryKey: key });
        });
    },
    [queryClient, toast],
  );

  return { reading, add };
}
