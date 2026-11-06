/**
 * One conversation, whole: who took part, what it was about, and what was said — or, once its
 * transcript is no longer kept, the archived copy.
 *
 * Deleting takes the facts it taught with it, because a fact is only readable where its conversation
 * was; the confirmation says so rather than leaving it a surprise.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote } from "@/commons/components/ui/ui";
import { overPage } from "@/commons/components/ui/OverPage";

const STATUS: Record<string, string> = {
  raw: "Waiting for the nightly pass",
  summarized: "Filed",
  compacted: "Filed, transcript archived",
};

export function stars(importance?: number): string {
  return importance ? "★".repeat(importance) + "☆".repeat(5 - importance) : "";
}

export function EpisodeView({ id, editable, nameOf, onOpen, onClose }: { id: string; editable: boolean; nameOf: (identity: string) => string; onOpen: (id: string) => void; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const episode = useQuery({ queryKey: ["memory-episode", id], queryFn: () => api.memoryEpisode(id) });

  const remove = useMutation({
    mutationFn: () => api.deleteEpisode(id),
    onSuccess: async (result) => {
      toast.success("Conversation deleted", result.facts ? `${result.facts} fact(s) it taught were removed too.` : undefined);
      await queryClient.invalidateQueries({ queryKey: ["memory-episodes"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-people"] });
      onClose();
    },
    onError: (err) => toast.error("Could not delete it", err),
  });

  const askDelete = async () => {
    const yes = await confirm.ask({
      title: "Delete this conversation?",
      body: "Its transcript, its archive copy, and every fact it taught are deleted. This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (yes) remove.mutate();
  };

  const data = episode.data?.episode;
  const transcript = data?.transcript.trim() || episode.data?.archived?.replace(/^---[\s\S]*?\n---\s*\n?/, "").trim() || "";

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label="Conversation">
      <div className="modal-box max-w-4xl rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="font-semibold">{data ? `${data.day} · ${data.agents.join(", ") || "archive"}` : "Conversation"}</h3>
            {data ? (
              <p className="text-base-content/65 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                <span>{STATUS[data.status]}</span>
                <span>With {data.people.map(nameOf).join(", ") || "nobody named"}</span>
                {data.kind === "group" ? <span>In a group</span> : null}
                {data.importance ? <span title="importance">{stars(data.importance)}</span> : null}
                {data.tags.map((tag) => (
                  <span key={tag} className="badge badge-ghost badge-xs font-mono">
                    #{tag}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {episode.error ? <ErrorNote error={episode.error} /> : null}
        {data?.summary ? <p className="bg-base-200/50 mb-3 rounded-xl p-3 text-sm leading-relaxed">{data.summary}</p> : null}
        {data?.mentions.length ? <p className="text-base-content/65 mb-2 text-xs">Talked about: {data.mentions.map(nameOf).join(", ")}</p> : null}

        {transcript ? (
          <pre className="bg-base-200/40 max-h-[50vh] overflow-auto rounded-xl p-4 font-sans text-sm whitespace-pre-wrap">{transcript}</pre>
        ) : data ? (
          <p className="text-base-content/65 text-sm">{data.kind === "archive" ? "A day summary from the old memory. It never had a transcript." : "The transcript is no longer kept."}</p>
        ) : null}
        {episode.data?.archived && !data?.transcript.trim() ? <p className="text-base-content/65 mt-2 text-xs">From the archive. Agents cannot read this copy.</p> : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {data?.related.map((related) => (
              <button key={related} type="button" className="btn btn-ghost btn-xs rounded-lg font-mono" onClick={() => onOpen(related)}>
                {related}
              </button>
            ))}
          </div>
          {editable && data ? (
            <button type="button" className="btn btn-ghost btn-sm text-error gap-1 rounded-xl" disabled={remove.isPending} onClick={() => void askDelete()}>
              <Trash2 size={14} /> Delete
            </button>
          ) : null}
        </div>
        {confirm.dialog}
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}
