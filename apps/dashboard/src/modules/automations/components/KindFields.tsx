/**
 * What each kind of step is written with: a message, what to ask an agent, a command, a mission's goal and checks, or
 * the question a person is asked and how long the run waits for the answer. One set of fields a kind, drawn in the
 * step's own card.
 */

import { useState } from "react";
import { Field } from "@/commons/components/ui/ui";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { MissionFields, missionDraft, type MissionDraft } from "@/commons/components/jobs/MissionFields";
import type { Then } from "../lib/draft";
import { APPROVAL_WAIT_MS, argvOf, shellLine, type Step } from "../lib/steps";

type Of<K extends Step["kind"]> = Extract<Step, { kind: K }>;

export interface AgentChoice {
  id: string;
  name: string;
}

const AREA = "textarea w-full text-sm leading-relaxed";

/** Whose step it is: the automation's own agent unless another is picked, who then starts from what the step before said. */
function StepAgent({ value, own, agents, onChange }: { value: string | undefined; own: string; agents: readonly AgentChoice[]; onChange: (agentId: string | undefined) => void }) {
  if (agents.length < 2) return null;
  const ownName = agents.find((agent) => agent.id === own)?.name ?? own;
  return (
    <Field label="Who does it" hint="Another agent starts fresh, with what the step before said.">
      <SearchSelect
        label="Who does it"
        align="start"
        className="w-full"
        options={[{ value: "", label: `${ownName}, who runs this automation` }, ...agents.filter((agent) => agent.id !== own).map((agent) => ({ value: agent.id, label: agent.name }))]}
        value={value && value !== own ? value : ""}
        onChange={(next) => onChange(next || undefined)}
      />
    </Field>
  );
}

const withAgent = <S extends Of<"agentTurn"> | Of<"mission">>(step: S, agentId: string | undefined): S => {
  const { agentId: _was, ...rest } = step;
  return (agentId ? { ...rest, agentId } : rest) as S;
};

function MissionStep({ step, own, agents, onChange }: { step: Of<"mission">; own: string; agents: readonly AgentChoice[]; onChange: (step: Step) => void }) {
  // What is typed is kept as typed: read back from the step, a checks box would lose the line being started.
  const [draft, setDraft] = useState<MissionDraft>(() => missionDraft({ ...step }));
  const write = (next: MissionDraft) => {
    setDraft(next);
    const checks = next.checks.split("\n").map((line) => line.trim()).filter(Boolean);
    const { checks: _checks, review: _review, ...rest } = step;
    onChange({
      ...rest,
      goal: next.goal,
      ...(checks.length > 0 ? { checks } : {}),
      ...(next.review === "off" ? { review: false as const } : next.review === "criteria" && next.criteria.trim() ? { review: next.criteria.trim() } : {}),
    });
  };
  return (
    <>
      <MissionFields draft={draft} onChange={write} />
      <StepAgent value={step.agentId} own={own} agents={agents} onChange={(agentId) => onChange(withAgent({ ...step, goal: draft.goal }, agentId))} />
      <p className="text-xs text-base-content/65">The run waits here until the mission ends, however long that is, and goes on with its result.</p>
    </>
  );
}

/** How long a step waits for a person: the choices a person reads, and the one it holds when it is none of them. */
const WAITS: [ms: number, label: string][] = [
  [5 * 60_000, "5 minutes"],
  [15 * 60_000, "15 minutes"],
  [3_600_000, "1 hour"],
  [4 * 3_600_000, "4 hours"],
  [12 * 3_600_000, "12 hours"],
  [86_400_000, "1 day"],
  [3 * 86_400_000, "3 days"],
  [7 * 86_400_000, "7 days"],
];

function waitChoices(held: number): { value: string; label: string }[] {
  const listed = WAITS.some(([ms]) => ms === held) ? WAITS : [...WAITS, [held, `${Math.round(held / 60_000)} minutes`] as [number, string]].sort((a, b) => a[0] - b[0]);
  return listed.map(([ms, label]) => ({ value: String(ms), label }));
}

function ApprovalStep({ step, onChange }: { step: Of<"approval">; onChange: (step: Step) => void }) {
  const held = step.timeoutMs ?? APPROVAL_WAIT_MS;
  return (
    <>
      <Field label="Question" hint="Asked where it reports and under Waiting for you, with what the step before said.">
        <textarea className={AREA} rows={2} value={step.ask} placeholder="Send this to the team?" onChange={(event) => onChange({ ...step, ask: event.target.value })} />
      </Field>
      <Field label="Wait for an answer for" hint="With no answer by then, the run takes this step's other path.">
        <SearchSelect
          label="Wait for an answer for"
          align="start"
          options={waitChoices(held)}
          value={String(held)}
          onChange={(next) => {
            const { timeoutMs: _was, ...rest } = step;
            onChange(Number(next) === APPROVAL_WAIT_MS ? rest : { ...rest, timeoutMs: Number(next) });
          }}
        />
      </Field>
    </>
  );
}

function CommandStep({ step, alone, onChange }: { step: Of<"command">; alone: { then: Then; agent: string; onThen: (then: Then) => void } | null; onChange: (step: Step) => void }) {
  const seconds = step.timeoutMs !== undefined ? String(step.timeoutMs / 1000) : "";
  return (
    <>
      <Field label="Command" hint="Runs on this server with no AI, and nobody is asked first. What it prints goes to the next step.">
        <input
          className="input w-full font-mono text-[13px]"
          value={shellLine(step.argv)}
          placeholder="scripts/check-queue.sh" // plain-words-ok: an example of the command this field takes
          onChange={(event) => onChange({ ...step, argv: argvOf(event.target.value) })}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Give up after (seconds)" hint="Empty: the usual limit.">
          <input
            className="input w-full font-mono text-sm"
            type="number"
            min={1}
            value={seconds}
            placeholder="600"
            onChange={(event) => {
              const { timeoutMs: _was, ...rest } = step;
              const typed = Number(event.target.value);
              onChange(event.target.value && Number.isFinite(typed) && typed > 0 ? { ...rest, timeoutMs: Math.round(typed * 1000) } : rest);
            }}
          />
        </Field>
        {/* Only while the command is all the automation does: among other steps, what reads its output is the next step. */}
        {alone ? (
          <Field label="After it runs" hint="What its output is worth.">
            <SearchSelect
              label="After it runs"
              align="start"
              className="w-full"
              options={[
                { value: "deliver", label: "Send what it printed, as it is" },
                { value: "agentTurn", label: `Hand what it printed to ${alone.agent}` },
              ]}
              value={alone.then}
              onChange={alone.onThen}
            />
          </Field>
        ) : null}
      </div>
    </>
  );
}

export function KindFields({
  step,
  own,
  agents,
  alone,
  onChange,
}: {
  step: Step;
  /** The automation's own agent. */
  own: string;
  agents: readonly AgentChoice[];
  /** Set while this command is the one thing the automation does: what its output is worth is a choice of its own. */
  alone: { then: Then; agent: string; onThen: (then: Then) => void } | null;
  onChange: (step: Step) => void;
}) {
  switch (step.kind) {
    case "systemEvent":
      return (
        <Field label="Message" hint="Sent as written to where it reports. No AI.">
          <textarea className={AREA} rows={2} value={step.text} placeholder="The weekly backup is done." onChange={(event) => onChange({ ...step, text: event.target.value })} />
        </Field>
      );
    case "agentTurn":
      return (
        <>
          <Field label="What to ask" hint="The agent works on it with its tools. It is handed what the step before said.">
            <textarea className={AREA} rows={3} value={step.message} placeholder="Find out why it failed, and say what you found." onChange={(event) => onChange({ ...step, message: event.target.value })} />
          </Field>
          <StepAgent value={step.agentId} own={own} agents={agents} onChange={(agentId) => onChange(withAgent(step, agentId))} />
        </>
      );
    case "command":
      return <CommandStep step={step} alone={alone} onChange={onChange} />;
    case "mission":
      return <MissionStep step={step} own={own} agents={agents} onChange={onChange} />;
    case "approval":
      return <ApprovalStep step={step} onChange={onChange} />;
  }
}
