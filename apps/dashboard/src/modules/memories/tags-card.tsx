/**
 * Tags, in one card above the tabs — shown only when there is something to act on: the tags last
 * night's pass coined (each with Merge into the known tag it is nearest), tags the rules can tidy
 * (Review opens the dialog), or a tidy of the last week (Undo). A tidy vault shows nothing: an R5
 * merge alone does not count, since it is offered unticked and may be declined for good.
 *
 * {@link TidyTagsButton}, in the page header, opens the same dialog at any time — the way to ask the
 * model for tags that mean one subject when the rules have nothing left to offer.
 *
 * Every write happens on the daemon after a vault backup, and is recorded so Undo can put it back.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Tags, Undo2, X } from "lucide-react";
import { useState } from "react";
import { api } from "@/commons/lib/api";
import type { TagTidyChange } from "@nouride/wire";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote } from "@/commons/components/ui/ui";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";

/** How long the last tidy stays offered for Undo on the card. `nouride memory tags undo` has no limit. */
const UNDO_DAYS = 7;

const WHY: Record<string, string> = {
  R1: "the same word",
  R2: "a typo",
  R3: "a short form",
  R5: "a narrower tag into the broad one; check it is not a subject of its own",
  limit: "used by one conversation only",
  cap: "more than 4 on one conversation",
  model: "suggested by the model",
};

function label(change: TagTidyChange): string {
  if (change.kind === "merge") return `${change.from.join(", ")} → ${change.into}`;
  if (change.kind === "cap") return `Keep the 4 most used tags on ${change.episodes} conversation(s)`;
  return `Remove ${change.from.length} one-off tag(s) from ${change.episodes} ${change.id === "trim:archive" ? "imported day(s)" : "conversation(s)"}`;
}

/** Everything a tag change can make stale. */
function useRefreshTags(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    for (const key of ["memory-tag-plan", "memory-status", "memory-graph", "memory-facets", "memory-episodes"]) await queryClient.invalidateQueries({ queryKey: [key] });
  };
}

/** "Tidy tags", always there for an operator: the review dialog whether or not the rules find anything. */
export function TidyTagsButton() {
  const plan = useQuery({ queryKey: ["memory-tag-plan"], queryFn: api.memoryTagPlan });
  const refresh = useRefreshTags();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm gap-1 rounded-xl" disabled={!plan.data} onClick={() => setOpen(true)}>
        <Tags size={14} /> Tidy tags
      </button>
      <Leaving value={open && plan.data?.changes}>{(changes) => <ReviewDialog changes={changes} onClose={() => setOpen(false)} onDone={refresh} />}</Leaving>
    </>
  );
}

export function TagsCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const plan = useQuery({ queryKey: ["memory-tag-plan"], queryFn: api.memoryTagPlan });
  const status = useQuery({ queryKey: ["memory-status"], queryFn: api.memoryStatus });
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const refresh = useRefreshTags();
  const merge = useMutation({
    mutationFn: ({ from, into }: { from: string; into: string }) => api.mergeTags([from], into),
    onSuccess: async (result, { from, into }) => {
      toast.success(`Merged ${from} into ${into}`, `${result.episodes} conversation(s) retagged.`);
      await refresh();
    },
    onError: (err) => toast.error("Could not merge", err),
  });
  const undo = useMutation({
    mutationFn: api.undoTagTidy,
    onSuccess: async (result) => {
      toast.success("Tidy undone", `${result.restored} conversation(s) put back${result.skipped.length ? `; ${result.skipped.length} changed since and were left` : ""}.`);
      await refresh();
    },
    onError: (err) => toast.error("Could not undo", err),
  });

  const fresh = (status.data?.pass?.lastRun?.newTags ?? []).filter((entry) => entry.closest && !dismissed.includes(entry.tag));
  const changes = plan.data?.changes ?? [];
  // What Review would apply as it opens. An R5 merge is shown in the dialog but does not call for it.
  const ready = changes.filter((change) => change.why !== "R5");
  const last = plan.data?.last && Date.now() - Date.parse(plan.data.last.at) < UNDO_DAYS * 86_400_000 ? plan.data.last : null;
  if (!fresh.length && !ready.length && !last) return null;

  return (
    <div className="border-base-content/[0.08] bg-base-100/80 space-y-2 rounded-2xl border px-4 py-3 text-sm">
      {fresh.length ? (
        <div className="space-y-1">
          <p className="font-medium">New tags last night</p>
          {fresh.map((entry) => (
            <div key={entry.tag} className="flex flex-wrap items-center gap-2">
              <span className="badge badge-ghost font-mono">#{entry.tag}</span>
              <span className="text-base-content/65">nearest: #{entry.closest}</span>
              <button type="button" className="btn btn-ghost btn-xs rounded-lg" disabled={merge.isPending} onClick={() => merge.mutate({ from: entry.tag, into: entry.closest! })}>
                Merge into {entry.closest}
              </button>
              <button type="button" className="btn btn-ghost btn-xs rounded-lg" onClick={() => setDismissed([...dismissed, entry.tag])}>
                Keep
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {ready.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <Tags size={16} className="text-primary shrink-0" />
          <span>
            <span className="font-medium">{ready.length} tag change(s) can tidy the graph</span>
            <span className="text-base-content/65"> · {plan.data!.once} of {plan.data!.tags} tags are on one conversation only</span>
          </span>
          <button type="button" className="btn btn-primary btn-xs rounded-lg" onClick={() => setOpen(true)}>
            Review
          </button>
        </div>
      ) : null}

      {last && !ready.length ? (
        <div className="text-base-content/65 flex flex-wrap items-center gap-2">
          <span>
            Tidied {last.changes} change(s) on {last.episodes} conversation(s) · {new Date(last.at).toLocaleString()}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg"
            disabled={undo.isPending}
            onClick={async () => {
              if (await confirm.ask({ title: "Undo the last tidy?", body: "Conversations changed since keep their tags as they are now.", confirmLabel: "Undo", danger: false })) undo.mutate();
            }}
          >
            <Undo2 size={14} /> Undo
          </button>
        </div>
      ) : null}

      <Leaving value={open && plan.data ? changes : null}>{(shown) => <ReviewDialog changes={shown} onClose={() => setOpen(false)} onDone={refresh} />}</Leaving>
      {confirm.dialog}
    </div>
  );
}

function ReviewDialog({ changes, onClose, onDone }: { changes: TagTidyChange[]; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  // R5 is a rule, but not a certain one: `home-assistant` is not `home`, and the alias a merge leaves folds the
  // narrower tag every night after. So it is offered unticked, like the model's groups.
  const [ticked, setTicked] = useState<string[]>(changes.filter((change) => change.why !== "R5").map((change) => change.id));
  const [suggested, setSuggested] = useState<TagTidyChange[]>([]);
  const [kept, setKept] = useState<string[]>([]);
  const ask = useMutation({
    mutationFn: api.suggestTagMerges,
    onSuccess: (result) => {
      setSuggested(result.changes);
      const dropped = result.dropped ?? [];
      if (result.readable === false) toast.error("The model's answer could not be read", "Nothing was suggested. Try again, or set a stronger model for the pass.");
      // What the checks said of each group is theirs (0.8.23): the page says it in its own words.
      else if (!result.changes.length && dropped.length) toast.warning(`The model proposed ${dropped.length} group(s), and none passed the checks`, result.plain ?? "Try again, or set a stronger model for the pass.");
      else if (!result.changes.length) toast.success("Nothing more to suggest", "The model found no tags that mean one subject.");
    },
    onError: (err) => toast.error("The model could not be asked", err),
  });
  const apply = useMutation({
    mutationFn: () => api.applyTagTidy(ticked, suggested.filter((change) => kept.includes(change.id))),
    onSuccess: async (result) => {
      toast.success("Tags tidied", `${result.changes} change(s) on ${result.episodes} conversation(s). Undo is on the card.`);
      await onDone();
      onClose();
    },
    onError: (err) => toast.error("Could not tidy", err),
  });
  const toggle = (list: string[], set: (next: string[]) => void, id: string) => set(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  const count = ticked.length + kept.length;

  const row = (change: TagTidyChange, on: boolean, flip: () => void) => (
    <label key={change.id} className="hover:bg-base-200/60 flex cursor-pointer items-start gap-3 rounded-xl px-2 py-1.5">
      <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={on} onChange={flip} />
      <span className="min-w-0">
        <span className="block break-words">{label(change)}</span>
        <span className="text-base-content/65 text-xs">
          {WHY[change.why] ?? change.why}
          {change.reason ? `: ${change.reason}` : ""}
          {change.kind === "trim" ? ` · ${change.from.slice(0, 8).join(", ")}${change.from.length > 8 ? "…" : ""}` : ""}
        </span>
      </span>
    </label>
  );

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label="Tidy tags">
      <div className="modal-box max-w-2xl rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">Tidy tags</h3>
            <p className="text-base-content/65 text-xs">Only the tags line of each conversation changes. The vault is backed up first, and Undo puts it back.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[55dvh] space-y-1 overflow-y-auto">
          {!changes.length && !suggested.length ? (
            <p className="text-base-content/65 px-2 py-3 text-sm">The rules find nothing to tidy. The model can still look for tags that mean one subject: spellings the rules cannot see, synonyms, a narrow tag that only ever means a broad one.</p>
          ) : null}
          {changes.map((change) => row(change, ticked.includes(change.id), () => toggle(ticked, setTicked, change.id)))}
          {suggested.length ? <p className="text-base-content/65 px-2 pt-3 text-xs font-medium">Suggested by the model: read before ticking</p> : null}
          {suggested.map((change) => row(change, kept.includes(change.id), () => toggle(kept, setKept, change.id)))}
        </div>
        {ask.error ? <ErrorNote error={ask.error} /> : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" disabled={ask.isPending || suggested.length > 0} onClick={() => ask.mutate()}>
            <Sparkles size={14} /> {ask.isPending ? "Asking…" : "Also ask the model"}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl"
            disabled={count === 0 || apply.isPending}
            onClick={async () => {
              if (await confirm.ask({ title: `Apply ${count} change(s)?`, body: "The tags of the conversations they touch are rewritten. The vault is backed up first.", confirmLabel: "Apply", danger: false })) apply.mutate();
            }}
          >
            {apply.isPending ? "Tidying…" : `Apply ${count} change(s)`}
          </button>
        </div>
        {confirm.dialog}
      </div>
    </div>
  );
}
