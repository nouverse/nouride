/**
 * "Merge into…" on a tag's panel: this tag's conversations take the other tag instead, and the other
 * tag keeps this one as an alias, so a model writing it tomorrow is filed under the kept tag. A tidy
 * of one change on the daemon: the vault is backed up first, and the Memory page's tags card undoes it.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Merge } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@/commons/lib/api";
import type { Facet } from "@/commons/lib/api.memory";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";

/** Tags offered as you type, at most — the most used first, which is what a merge usually wants. */
const OFFERED = 200;

export function MergeTag({ tag, tags, onMerged }: { tag: string; tags: readonly Facet[]; onMerged: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useId();
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState("");
  const target = into.trim().replace(/^#/, "").toLowerCase();
  const merge = useMutation({
    mutationFn: () => api.mergeTags([tag], target),
    onSuccess: async (result) => {
      toast.success(`Merged #${tag} into #${target}`, `${result.episodes} conversation(s) retagged. Undo is on the Knowledge & Memory page.`);
      for (const key of ["memory-graph", "memory-facets", "memory-tag-plan", "memory-episodes"]) await queryClient.invalidateQueries({ queryKey: [key] });
      onMerged();
    },
    onError: (err) => toast.error("Could not merge", err),
  });

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" onClick={() => setOpen(true)}>
        <Merge size={12} /> Merge into…
      </button>
    );
  }

  const offered = tags.filter((facet) => facet.value !== tag).slice(0, OFFERED);
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!target || target === tag) return;
        const known = tags.some((facet) => facet.value === target);
        const body = known ? `Every conversation tagged #${tag} is tagged #${target} instead.` : `#${target} is a new tag. Every conversation tagged #${tag} takes it instead.`;
        if (await confirm.ask({ title: `Merge #${tag} into #${target}?`, body, confirmLabel: "Merge", danger: false })) merge.mutate();
      }}
    >
      <input
        className="input input-xs min-w-0 flex-1 rounded-lg"
        list={list}
        placeholder="the tag to keep"
        aria-label={`Merge #${tag} into`}
        value={into}
        onChange={(event) => setInto(event.target.value)}
        autoFocus
      />
      <datalist id={list}>
        {offered.map((facet) => (
          <option key={facet.value} value={facet.value}>
            {facet.count}
          </option>
        ))}
      </datalist>
      <button type="submit" className="btn btn-primary btn-xs rounded-lg" disabled={!target || target === tag || merge.isPending}>
        {merge.isPending ? "Merging…" : "Merge"}
      </button>
      <button type="button" className="btn btn-ghost btn-xs rounded-lg" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {confirm.dialog}
    </form>
  );
}
