/**
 * A new mission from the dashboard: who does it, what it is, and how it is judged done — commands that must pass,
 * a reviewer's criteria, a person's accept — with its brief and its own limits, the fields a draft is changed with:
 * they were only there, so a mission could be given neither as it was made. Saved to the backlog it is a draft that
 * waits to be started, as an agent's is; "Start now" starts it at once. It reports to the dashboard's own chat;
 * nothing here parses a goal or a check, and a refusal (no such agent, a folder that is not an absolute path, a limit
 * out of its bounds) is the daemon's sentence, shown under it.
 */

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { AgentSummary, MissionStart, MissionView } from "@nouride/wire";
import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import { limitsAreNumbers, limitsTyped, MILLION, OwnLimits, type OwnLimitValues } from "./OwnLimits";

/** The form's fields as the route takes them: checks one per line, blanks dropped; a reviewer's words or none at all. */
export function startInput(draft: {
  agent: string;
  /** Its name; left empty, the daemon names it from its goal. */
  title?: string;
  goal: string;
  checks: string;
  review: string;
  noReview: boolean;
  accept: boolean;
  workdir: string;
  /** Its brief; left empty, it has none and each turn starts from its goal alone. */
  brief?: string;
  /** Its own limits as typed, tokens in millions; each left empty is the limit every mission starts with. */
  limits?: OwnLimitValues;
}): MissionStart {
  const checks = draft.checks.split("\n").map((line) => line.trim()).filter(Boolean);
  const limits = draft.limits ? limitsTyped(draft.limits) : {};
  return {
    agent: draft.agent,
    ...(draft.title?.trim() ? { title: draft.title.trim() } : {}),
    goal: draft.goal.trim(),
    ...(checks.length > 0 ? { checks } : {}),
    ...(draft.noReview ? { noReview: true } : draft.review.trim() ? { review: draft.review.trim() } : {}),
    ...(draft.accept ? { accept: true } : {}),
    ...(draft.workdir.trim() ? { workdir: draft.workdir.trim() } : {}),
    ...(draft.brief?.trim() ? { brief: draft.brief.trim() } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

export function NewMissionForm({
  agents,
  onSaved,
  onStarted,
  onCancel,
}: {
  agents: AgentSummary[];
  /** Saved to the backlog: a draft, not started. */
  onSaved: (mission: MissionView) => void;
  onStarted: (mission: MissionView) => void;
  onCancel: () => void;
}) {
  const orchestrator = useOrchestrator();
  const ordered = useOrchestratorFirst(agents.filter((agent) => agent.enabled), (agent) => agent.id);
  const [agent, setAgent] = useState("");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [checks, setChecks] = useState("");
  const [review, setReview] = useState("");
  const [noReview, setNoReview] = useState(false);
  const [accept, setAccept] = useState(false);
  const [workdir, setWorkdir] = useState("");
  const [brief, setBrief] = useState("");
  const [limits, setLimits] = useState<OwnLimitValues>({ hours: "", turns: "", tokens: "" });
  const toast = useToast();
  // The limits every mission starts with, shown in the empty fields: the Limits card's own read, shared with it.
  const settings = useQuery({ queryKey: ["mission-settings"], queryFn: api.missionSettings, retry: false });
  const usual = settings.data ? { hours: String(settings.data.limitHours), turns: String(settings.data.limitTurns), tokens: String(settings.data.limitTokens / MILLION) } : undefined;
  const chosen = agent || orchestrator || ordered[0]?.id || "";

  // One form, two ends: saved to the backlog as a draft (the form's own button, as an agent's mission is one first),
  // or started now. Which was pressed goes with the request, so the answer is handed to the right end.
  const start = useMutation({
    mutationFn: (draft: boolean) => api.startMission({ ...startInput({ agent: chosen, title, goal, checks, review, noReview, accept, workdir, brief, limits }), ...(draft ? { draft: true } : {}) }),
    onSuccess: ({ mission, plain }, draft) => {
      // Made, but its brief could not be kept: said, since the page that opens next shows none.
      if (plain) toast.error("Its brief was not kept", plain);
      if (draft) onSaved(mission);
      else onStarted(mission);
    },
  });
  const numbers = limitsAreNumbers(limits);
  const ready = Boolean(chosen && goal.trim()) && numbers;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) start.mutate(true);
      }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
        <Field label="Agent">
          <select className="select select-sm w-full rounded-xl" value={chosen} onChange={(e) => setAgent(e.target.value)}>
            {ordered.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id === orchestrator ? `${entry.id} (orchestrator)` : entry.id}
              </option>
            ))}
          </select>
        </Field>
        {/* Beside the agent: what it is called, then what it is to do. */}
        <div className="min-w-0 space-y-4">
          <Field label="Name" hint="What the work is called, in a few words. Empty: named from its goal.">
            <input className="input input-sm w-full rounded-xl" maxLength={60} value={title} placeholder="The new API client" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Goal" hint="What done looks like, in a sentence or two. The agent writes its own checklist from it.">
            <textarea
              className="textarea textarea-sm w-full rounded-xl leading-relaxed"
              rows={2}
              value={goal}
              placeholder="Upgrade the API to the new client and keep the tests green"
              onChange={(e) => setGoal(e.target.value)}
            />
          </Field>
          <Field label="Brief" hint="Optional. Kept in its folder: what the work is, why, what to read, what done means. Each turn starts from it.">
            <textarea className="textarea textarea-sm w-full rounded-xl font-mono text-xs leading-relaxed" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Checks" hint="Commands that must pass in its folder, one per line. It is not done until they do.">
          <textarea
            className="textarea textarea-sm w-full rounded-xl font-mono text-xs"
            rows={3}
            value={checks}
            placeholder={"bun test\nbun run lint"}
            onChange={(e) => setChecks(e.target.value)}
          />
        </Field>
        <div className="space-y-3">
          <Field label="Review criteria" hint="What a second agent checks the result against. Empty: the goal itself.">
            <input
              className="input input-sm w-full rounded-xl"
              value={review}
              disabled={noReview}
              placeholder="The changelog lists what breaks"
              onChange={(e) => setReview(e.target.value)}
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-base-content/80">
            <input type="checkbox" className="checkbox checkbox-xs" checked={noReview} onChange={(e) => setNoReview(e.target.checked)} />
            Skip the reviewer
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-base-content/80">
            <input type="checkbox" className="checkbox checkbox-xs" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            I accept the result before it counts as done
          </label>
        </div>
      </div>

      <Field label="Folder" hint="An absolute path it works in. Empty: a folder of its own under the agent's private workspace.">
        <input
          className="input input-sm w-full rounded-xl font-mono text-xs"
          value={workdir}
          placeholder="/home/you/projects/api"
          onChange={(e) => setWorkdir(e.target.value)}
        />
      </Field>

      {/* This mission's own, where it stops to ask whether to go on: the Limits card's three, for this one alone. */}
      <OwnLimits
        values={limits}
        usual={usual}
        onChange={(key, value) => setLimits((now) => ({ ...now, [key]: value }))}
        note="Where this mission stops to ask you whether to go on. Only this one. Left empty, it has the limit every mission starts with."
      />

      <ErrorNote error={start.error} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary btn-sm min-h-11 rounded-xl shadow-xs transition-all active:scale-95 sm:min-h-8" disabled={!ready || start.isPending}>
          {start.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          Save to backlog
        </button>
        <button type="button" className="btn btn-sm min-h-11 rounded-xl border-base-content/15 sm:min-h-8" disabled={!ready || start.isPending} onClick={() => start.mutate(false)}>
          Start now
        </button>
        <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onCancel}>
          Cancel
        </button>
        {!ready && <span className="text-[11px] text-base-content/65">{numbers ? "Needs an agent and a goal." : "A limit is a number: 12, or 0.5 for half an hour."}</span>}
      </div>
    </form>
  );
}
