/**
 * A draft changed before it starts (0.8.11, RFC MISSION_DRAFTS §2.3): the new-mission form's fields, its limits and its
 * brief, prefilled from the draft. Only what was changed is sent; the daemon checks it as a start and says what changed,
 * and sends the draft's notice to its chat again. A started mission has no such form: its checks stay its own.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { MissionEdit, MissionView } from "@nouride/wire";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote, Field } from "@/commons/components/ui/ui";

interface Values {
  goal: string;
  checks: string;
  review: string;
  noReview: boolean;
  accept: boolean;
  workdir: string;
  branch: string;
  hours: string;
  turns: string;
  brief: string;
}

/** The form's values as the draft has them: its own folder shown as empty, as the new-mission form takes it. */
function valuesOf(mission: MissionView, brief: string | null, ownFolder: boolean): Values {
  return {
    goal: mission.goal,
    checks: mission.checks.join("\n"),
    review: mission.review ?? "",
    noReview: !mission.reviewOn,
    accept: mission.accept,
    workdir: ownFolder ? "" : mission.workdir,
    branch: mission.branch ?? "",
    hours: String(mission.limits.hours),
    turns: String(mission.limits.turns),
    brief: brief ?? "",
  };
}

/** What changed, as the route takes it — nothing else, so a field left alone is not judged again. */
function changeOf(before: Values, after: Values): MissionEdit {
  const checks = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const number = (text: string) => Number(text.trim());
  return {
    ...(after.goal.trim() !== before.goal.trim() ? { goal: after.goal.trim() } : {}),
    ...(checks(after.checks).join("\n") !== checks(before.checks).join("\n") ? { checks: checks(after.checks) } : {}),
    ...(after.noReview !== before.noReview ? (after.noReview ? { noReview: true } : { noReview: false, ...(after.review.trim() ? { review: after.review.trim() } : {}) }) : !after.noReview && after.review.trim() !== before.review.trim() ? { review: after.review.trim() } : {}),
    ...(after.accept !== before.accept ? { accept: after.accept } : {}),
    ...(after.workdir.trim() !== before.workdir.trim() ? { workdir: after.workdir.trim() || null } : {}),
    ...(after.branch.trim() !== before.branch.trim() ? { branch: after.branch.trim() || null } : {}),
    ...(after.hours.trim() !== before.hours.trim() || after.turns.trim() !== before.turns.trim()
      ? { limits: { ...(after.hours.trim() !== before.hours.trim() ? { hours: number(after.hours) } : {}), ...(after.turns.trim() !== before.turns.trim() ? { turns: number(after.turns) } : {}) } }
      : {}),
    ...(after.brief !== before.brief ? { brief: after.brief } : {}),
  };
}

export function DraftForm({ mission, brief, ownFolder, writable }: { mission: MissionView; brief: string | null; ownFolder: boolean; writable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const before = valuesOf(mission, brief, ownFolder);
  const [values, setValues] = useState(before);
  const set = (key: keyof Values) => (value: string | boolean) => setValues((now) => ({ ...now, [key]: value }));
  const change = changeOf(before, values);
  const save = useMutation({
    mutationFn: () => api.editMission(mission.id, change),
    onSuccess: (answer) => {
      // The page's words (0.8.23): what changed is the chat's list, a folder's path among it, and a brief's failure the
      // server's error.
      toast.success("Draft changed", answer.plain ?? (answer.briefFailed ? `${answer.changed.join(", ")}. The brief could not be written: ${answer.briefFailed}` : answer.changed.join(", ")));
      setOpen(false);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["missions"] }),
  });

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm gap-1.5 rounded-xl"
        disabled={!writable}
        onClick={() => {
          setValues(valuesOf(mission, brief, ownFolder));
          setOpen(true);
        }}
      >
        <Pencil size={13} aria-hidden="true" /> Change the draft
      </button>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (Object.keys(change).length > 0) save.mutate();
      }}
    >
      <Field label="Goal" hint="What done looks like. Each turn starts from it.">
        <textarea className="textarea textarea-sm w-full rounded-xl leading-relaxed" rows={2} value={values.goal} onChange={(e) => set("goal")(e.target.value)} />
      </Field>
      <Field label="Brief" hint="Kept in its folder: what the work is, why, what to read, what done means. Each turn starts from it.">
        <textarea className="textarea textarea-sm w-full rounded-xl font-mono text-xs leading-relaxed" rows={8} value={values.brief} onChange={(e) => set("brief")(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Checks" hint="Commands that must pass in its folder, one per line.">
          <textarea className="textarea textarea-sm w-full rounded-xl font-mono text-xs" rows={3} value={values.checks} onChange={(e) => set("checks")(e.target.value)} />
        </Field>
        <div className="space-y-3">
          <Field label="Review criteria" hint="What a second agent checks the result against. Empty: the goal itself.">
            <input className="input input-sm w-full rounded-xl" value={values.review} disabled={values.noReview} onChange={(e) => set("review")(e.target.value)} />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-base-content/80">
            <input type="checkbox" className="checkbox checkbox-xs" checked={values.noReview} onChange={(e) => set("noReview")(e.target.checked)} />
            Skip the reviewer
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-base-content/80">
            <input type="checkbox" className="checkbox checkbox-xs" checked={values.accept} onChange={(e) => set("accept")(e.target.checked)} />
            I accept the result before it counts as done
          </label>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <Field label="Folder" hint="An absolute path it works in. Empty: a folder of its own.">
          <input className="input input-sm w-full rounded-xl font-mono text-xs" value={values.workdir} onChange={(e) => set("workdir")(e.target.value)} />
        </Field>
        <Field label="Branch" hint="The branch it works on, when the folder keeps a history of its changes.">
          <input className="input input-sm w-full rounded-xl font-mono text-xs" value={values.branch} disabled={!values.workdir.trim()} onChange={(e) => set("branch")(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:max-w-sm">
        <Field label="Hours">
          <input className="input input-sm w-full rounded-xl" inputMode="decimal" value={values.hours} onChange={(e) => set("hours")(e.target.value)} />
        </Field>
        <Field label="Turns">
          <input className="input input-sm w-full rounded-xl" inputMode="numeric" value={values.turns} onChange={(e) => set("turns")(e.target.value)} />
        </Field>
      </div>

      <ErrorNote error={save.error} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary btn-sm rounded-xl shadow-xs transition-all active:scale-95" disabled={!writable || save.isPending || Object.keys(change).length === 0}>
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          Save the draft
        </button>
        <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-xl" onClick={() => setOpen(false)}>
          <X size={13} aria-hidden="true" /> Cancel
        </button>
        {Object.keys(change).length === 0 && <span className="text-[11px] text-base-content/65">Nothing changed yet.</span>}
      </div>
    </form>
  );
}
