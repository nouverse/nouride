/**
 * A mission job's fields (0.8.0): the goal each run works to, the commands that tell it is done, and how the reviewer
 * judges it. Drawn in an automation's step that starts a mission, whatever starts the automation.
 *
 * Each run is a mission: it survives a restart, asks when it needs someone, and ends at the reviewer rather than at a
 * person's accept, since whoever made the job accepted the work then. The reviewer costs a turn a run, so a run whose
 * checks are the whole answer can go without one.
 */

import { Field } from "@/commons/components/ui/ui";
import type { JobPayloadInput } from "@nouride/wire";

type MissionPayload = Extract<JobPayloadInput, { kind: "mission" }>;

export interface MissionDraft {
  goal: string;
  /** One command a line. */
  checks: string;
  review: "goal" | "criteria" | "off";
  criteria: string;
}

/** The form's draft of a stored mission, or an empty one. */
export function missionDraft(payload?: { kind: string; [key: string]: unknown }): MissionDraft {
  const mission = payload?.kind === "mission" ? (payload as unknown as MissionPayload) : undefined;
  const review = mission?.review;
  return {
    goal: mission?.goal ?? "",
    checks: (mission?.checks ?? []).join("\n"),
    review: review === false ? "off" : typeof review === "string" ? "criteria" : "goal",
    criteria: typeof review === "string" ? review : "",
  };
}

export function MissionFields({ draft, onChange }: { draft: MissionDraft; onChange: (draft: MissionDraft) => void }) {
  const set = (patch: Partial<MissionDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="space-y-3">
      <Field label="Goal" hint="What each run works to: what should be true when it is done.">
        <textarea
          className="textarea textarea-sm w-full rounded-xl text-sm leading-relaxed"
          rows={3}
          value={draft.goal}
          placeholder="Sum up this week's customer mail for the team: one line per thread, the open ones first."
          onChange={(e) => set({ goal: e.target.value })}
        />
      </Field>
      <Field label="Checks" hint="Commands that say whether a run is done, one a line. Empty: the reviewer judges.">
        <textarea
          className="textarea textarea-sm w-full rounded-xl font-mono text-xs"
          rows={2}
          value={draft.checks}
          placeholder="test -s summary.md" // plain-words-ok: an example of the command this field takes
          onChange={(e) => set({ checks: e.target.value })}
        />
      </Field>
      <Field label="Reviewer" hint="A fresh look before a run counts as done. It costs about as much as one more answer, each run.">
        <select className="select select-sm w-full rounded-xl" value={draft.review} onChange={(e) => set({ review: e.target.value as MissionDraft["review"] })}>
          <option value="goal">Checks it against the goal</option>
          <option value="criteria">Checks it against these words</option>
          <option value="off">No reviewer: the checks are the whole answer</option>
        </select>
      </Field>
      {draft.review === "criteria" && (
        <input
          className="input input-sm w-full rounded-xl text-sm"
          value={draft.criteria}
          placeholder="Every thread named once, each with who is waiting on whom."
          onChange={(e) => set({ criteria: e.target.value })}
        />
      )}
    </div>
  );
}
