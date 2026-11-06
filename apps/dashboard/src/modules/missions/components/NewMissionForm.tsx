/**
 * Starting a mission from the dashboard: who does it, what it is, and how it is judged done — commands that must pass,
 * a reviewer's criteria, a person's accept. It reports to the dashboard's own chat; nothing here parses a goal or a
 * check, and a refusal (no such agent, a folder that is not an absolute path) is the daemon's sentence, shown under it.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type AgentSummary, type MissionStart, type MissionView } from "@/commons/lib/api";
import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/ui/AgentName";
import { ErrorNote, Field } from "@/commons/components/ui/ui";

/** The form's fields as the route takes them: checks one per line, blanks dropped; a reviewer's words or none at all. */
export function startInput(draft: {
  agent: string;
  goal: string;
  checks: string;
  review: string;
  noReview: boolean;
  accept: boolean;
  workdir: string;
}): MissionStart {
  const checks = draft.checks.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    agent: draft.agent,
    goal: draft.goal.trim(),
    ...(checks.length > 0 ? { checks } : {}),
    ...(draft.noReview ? { noReview: true } : draft.review.trim() ? { review: draft.review.trim() } : {}),
    ...(draft.accept ? { accept: true } : {}),
    ...(draft.workdir.trim() ? { workdir: draft.workdir.trim() } : {}),
  };
}

export function NewMissionForm({ agents, onStarted, onCancel }: { agents: AgentSummary[]; onStarted: (mission: MissionView) => void; onCancel: () => void }) {
  const orchestrator = useOrchestrator();
  const ordered = useOrchestratorFirst(agents.filter((agent) => agent.enabled), (agent) => agent.id);
  const [agent, setAgent] = useState("");
  const [goal, setGoal] = useState("");
  const [checks, setChecks] = useState("");
  const [review, setReview] = useState("");
  const [noReview, setNoReview] = useState(false);
  const [accept, setAccept] = useState(false);
  const [workdir, setWorkdir] = useState("");
  const chosen = agent || orchestrator || ordered[0]?.id || "";

  const start = useMutation({
    mutationFn: () => api.startMission(startInput({ agent: chosen, goal, checks, review, noReview, accept, workdir })),
    onSuccess: ({ mission }) => onStarted(mission),
  });
  const ready = Boolean(chosen && goal.trim());

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) start.mutate();
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
        <Field label="Goal" hint="What done looks like, in a sentence or two. The agent writes its own checklist from it.">
          <textarea
            className="textarea textarea-sm w-full rounded-xl leading-relaxed"
            rows={2}
            value={goal}
            placeholder="Upgrade the API to the new client and keep the tests green"
            onChange={(e) => setGoal(e.target.value)}
          />
        </Field>
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
              placeholder="The changelog names every breaking change"
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

      <ErrorNote error={start.error} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary btn-sm rounded-xl shadow-xs transition-all active:scale-95" disabled={!ready || start.isPending}>
          {start.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          Start mission
        </button>
        <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onCancel}>
          Cancel
        </button>
        {!ready && <span className="text-[11px] text-base-content/65">Needs an agent and a goal.</span>}
      </div>
    </form>
  );
}
