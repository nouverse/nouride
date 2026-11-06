/**
 * What every agent knows, in every chat — `shared.md`: the house, this box, how things are done here.
 *
 * Nothing reaches it without a person: the nightly pass only proposes — and only while
 * `[memory] propose_shared` is on, switched here — and what is approved or typed here is readable by
 * everyone, so nothing private belongs in it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { useToast } from "@/commons/components/ui/toast";
import { DocumentEditor } from "./document-editor";
import { EpisodeView } from "./episode-view";
import { FactList, factsOf } from "./facts";
import { useNames } from "./names";
import { useSaved } from "@/commons/hooks/use-saved";

/** `[memory] propose_shared`, saved at once. */
function ProposeShared({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = useSaved();
  const settings = useQuery({ queryKey: ["memory-settings"], queryFn: api.memorySettings });
  const save = useMutation({
    mutationFn: (proposeShared: boolean) => api.setMemorySettings({ proposeShared }),
    onSuccess: (answer, proposeShared) => {
      saved(answer, proposeShared ? "The nightly pass proposes shared knowledge" : "The nightly pass proposes no shared knowledge");
      return queryClient.invalidateQueries({ queryKey: ["memory-settings"] });
    },
    onError: (err) => toast.error("Could not save", err),
  });
  if (settings.error) return <ErrorNote error={settings.error} />;
  if (!settings.data) return null;
  return (
    <div className="border-base-content/[0.08] bg-base-200/40 rounded-2xl border px-5 py-3.5">
      <ToggleRow
        label="Suggest shared knowledge from conversations"
        hint="Each night the pass may propose a few things for everyone to know. Nothing is added until you approve it on Proposals."
        disabled={!editable || save.isPending}
        checked={settings.data.proposeShared}
        onChange={(next) => save.mutate(next)}
      />
    </div>
  );
}

export function SharedTab({ editable }: { editable: boolean }) {
  const nameOf = useNames();
  const doc = useQuery({ queryKey: ["memory-document", "shared"], queryFn: () => api.memoryDocument("shared") });
  const [editing, setEditing] = useState(false);
  const [episode, setEpisode] = useState<string | null>(null);
  const facts = factsOf(doc.data?.content ?? "");

  return (
    <div className="space-y-4">
      <ProposeShared editable={editable} />
      <Card
        title="Shared knowledge"
        description="Things that aren't about one person, like house rules or how this server is set up. Every agent knows these, so keep private things out."
        actions={
          editable ? (
            <button type="button" className="btn btn-ghost btn-sm gap-1 rounded-xl" onClick={() => setEditing(true)}>
              <Pencil size={14} /> Edit
            </button>
          ) : null
        }
      >
        {doc.error ? <ErrorNote error={doc.error} /> : null}
        {facts.length ? (
          <FactList facts={facts} nameOf={nameOf} onOpenEpisode={setEpisode} />
        ) : (
          <p className="text-base-content/65 text-sm">Nothing yet. Add it with Edit, or turn on suggestions above and approve what the nightly pass proposes.</p>
        )}
      </Card>
      {editing ? <DocumentEditor subject="shared" title="Shared knowledge" editable={editable} onClose={() => setEditing(false)} /> : null}
      {episode ? <EpisodeView id={episode} editable={editable} nameOf={nameOf} onOpen={setEpisode} onClose={() => setEpisode(null)} /> : null}
    </div>
  );
}
