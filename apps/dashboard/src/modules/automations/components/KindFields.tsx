/**
 * What each kind of step is written with: a message, what to ask an agent, a command, a mission's goal and checks, or
 * the question a person is asked and how long the run waits for the answer. One set of fields a kind, drawn in the
 * step's own card.
 */

import type { Look } from "@/commons/cat/look";
import { AgentSelect } from "@/commons/components/agents/AgentSelect";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Field } from "@/commons/components/ui/ui";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { MissionFields, missionDraft, type MissionDraft } from "@/commons/components/jobs/MissionFields";
import type { Then } from "../lib/draft";
import { ScriptFields } from "./ScriptFields";
import { APPROVAL_WAIT_MS, TOGETHER_MAX, TOGETHER_MIN, argvOf, asPart, blankPart, parted, shellLine, type Part, type Step } from "../lib/steps";

type Of<K extends Step["kind"]> = Extract<Step, { kind: K }>;

export interface AgentChoice {
  id: string;
  name: string;
  /** Its face, where the daemon has the agent. */
  look?: Look | undefined;
}

/** What a script's fields need of the page around them. */
export interface ScriptContext {
  /** The agent the automation runs as. */
  agentId: string;
  agentName: (id: string) => string;
  /** What "Ask … to change it" writes in the chat, the automation and the step named. */
  asks?: string | undefined;
  /** What the step before said in the last run. */
  sample?: string | undefined;
}

const AREA = "textarea w-full text-sm leading-relaxed";

/** Whose step it is: the automation's own agent unless another is picked, who then starts from what the step before said. */
function StepAgent({ value, own, agents, onChange }: { value: string | undefined; own: string; agents: readonly AgentChoice[]; onChange: (agentId: string | undefined) => void }) {
  if (agents.length < 2) return null;
  const mine = agents.find((agent) => agent.id === own);
  const ownName = mine?.name ?? own;
  return (
    <Field label="Who does it" hint="Another agent starts fresh, with what the step before said.">
      <AgentSelect
        label="Who does it"
        picks={[{ value: "", name: ownName, look: mine?.look, words: `${ownName}, who runs this automation` }, ...agents.filter((agent) => agent.id !== own).map((agent) => ({ value: agent.id, name: agent.name, look: agent.look }))]}
        value={value && value !== own ? value : ""}
        onChange={(next) => onChange(next || undefined)}
      />
    </Field>
  );
}

const withAgent = <S extends Of<"agentTurn"> | Of<"mission"> | Extract<Part, { kind: "agentTurn" }>>(step: S, agentId: string | undefined): S => {
  const { agentId: _was, ...rest } = step;
  return (agentId ? { ...rest, agentId } : rest) as S;
};

/** What a run does when it reaches a mission's step: starts it, or leaves it for a person to start. */
const MISSION_BEGINS: { value: "start" | "draft"; label: string }[] = [
  { value: "start", label: "Start the mission and wait for it" },
  { value: "draft", label: "Leave it in the Backlog as a draft" },
];

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
  // Started, or left as a draft for a person to start: what the run does at this step, so it is asked first.
  const leaves = step.draft === true;
  const setLeaves = (on: boolean) => {
    const { draft: _was, ...rest } = step;
    onChange(on ? { ...rest, goal: draft.goal, draft: true } : { ...rest, goal: draft.goal });
  };
  return (
    <>
      {/* What each choice does to the run is said under it, where it is chosen. */}
      <Field
        label="When the run gets here"
        hint={
          leaves
            ? "Nothing starts by itself. The mission waits in the Backlog until it is started there, or from the message where this automation reports, and the run goes on at once."
            : "The run waits here until the mission ends, however long that is, and goes on with its result."
        }
      >
        <SearchSelect label="When the run gets here" align="start" className="w-full" options={MISSION_BEGINS} value={leaves ? "draft" : "start"} onChange={(next) => setLeaves(next === "draft")} />
      </Field>
      <MissionFields draft={draft} onChange={write} />
      <StepAgent value={step.agentId} own={own} agents={agents} onChange={(agentId) => onChange(withAgent({ ...step, goal: draft.goal }, agentId))} />
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

function CommandStep({ step, alone, script, onChange }: { step: Of<"command">; alone: { then: Then; agent: string; onThen: (then: Then) => void } | null; script: ScriptContext; onChange: (step: Step) => void }) {
  const seconds = step.timeoutMs !== undefined ? String(step.timeoutMs / 1000) : "";
  // How long it may take, and what a lone command's output is worth: for whoever writes the script, so with its text.
  const limits = (
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
  );
  // A script the automation keeps: read in words first, its text behind a button (`ScriptFields`).
  if (step.script) return <ScriptFields step={{ ...step, script: step.script }} agentId={script.agentId} agentName={script.agentName} asks={script.asks} sample={script.sample} more={limits} onChange={onChange} />;
  // One line, as an automation made before scripts holds it, or one typed here.
  return (
    <>
      <Field label="Command" hint="One line, run on this server with no AI, and nobody is asked first. What it prints goes to the next step.">
        <input
          className="input w-full font-mono text-[13px]"
          value={shellLine(step.argv)}
          placeholder="scripts/check-queue.sh" // plain-words-ok: an example of the command this field takes
          onChange={(event) => onChange({ ...step, argv: argvOf(event.target.value) })}
        />
      </Field>
      <button type="button" className="btn btn-ghost btn-xs -mt-1 self-start font-bold text-secondary" onClick={() => onChange({ ...step, argv: ["sh"], script: { text: shellLine(step.argv), about: "" } })}>
        Write it as a script instead
      </button>
      {limits}
    </>
  );
}

/**
 * Several at the same time: each one what to ask an agent or a command to run, with a name its words go under. Two to
 * five, the server's own bounds: the last two cannot be removed, and a sixth cannot be added.
 */
function TogetherStep({ step, own, agents, onChange }: { step: Of<"parallel">; own: string; agents: readonly AgentChoice[]; onChange: (step: Step) => void }) {
  const write = (parts: readonly Part[]) => onChange(parted(step, parts));
  const set = (at: number, part: Part) => write(step.steps.map((one, index) => (index === at ? part : one)));
  return (
    <>
      <p className="text-xs text-base-content/65">They start at the same time, each handed what the step before said. The run goes on when the last one is done, with what each said under its name.</p>
      <ul className="space-y-3" data-together>
        {step.steps.map((part, at) => (
          <li key={at} className="space-y-3 rounded-2xl border border-base-content/[0.08] bg-base-200/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SegmentedTabs
                tabs={[
                  { value: "agentTurn" as const, label: "Ask an agent" },
                  { value: "command" as const, label: "Run a script" },
                ]}
                value={part.kind}
                onChange={(kind) => set(at, asPart(part, kind))}
              />
              <button type="button" className="btn btn-ghost btn-sm btn-circle" aria-label={`Remove number ${at + 1}`} title="Remove it" disabled={step.steps.length <= TOGETHER_MIN} onClick={() => write(step.steps.filter((_, index) => index !== at))}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
            {part.kind === "agentTurn" ? (
              <>
                <Field label="What to ask" hint="The agent works on it with its tools.">
                  <textarea className={AREA} rows={2} value={part.message} placeholder="Read today's news and say what matters." onChange={(event) => set(at, { ...part, message: event.target.value })} />
                </Field>
                <StepAgent value={part.agentId} own={own} agents={agents} onChange={(agentId) => set(at, withAgent(part, agentId))} />
              </>
            ) : part.script ? (
              // A script among them: its text, and the line that says what it does.
              <>
                <Field label="What it does">
                  <input className="input w-full text-sm" value={part.script.about} onChange={(event) => set(at, { ...part, script: { ...part.script!, about: event.target.value } })} />
                </Field>
                <Field label="Script" hint="Runs on this server with no AI, and nobody is asked first. It reads what the step before said.">
                  <textarea className="textarea min-h-32 w-full font-mono text-[13px]" value={part.script.text} spellCheck={false} onChange={(event) => set(at, { ...part, script: { ...part.script!, text: event.target.value } })} />
                </Field>
              </>
            ) : (
              <Field label="Command" hint="One line, run on this server with no AI, and nobody is asked first.">
                <input
                  className="input w-full font-mono text-[13px]"
                  value={shellLine(part.argv)}
                  placeholder="scripts/check-queue.sh" // plain-words-ok: an example of the command this field takes
                  onChange={(event) => set(at, { ...part, argv: argvOf(event.target.value) })}
                />
              </Field>
            )}
            <Field label="Name" hint="What its words are put under. Empty: the agent's name, or the command.">
              <input
                className="input w-full text-sm"
                value={part.name ?? ""}
                maxLength={80}
                placeholder="News"
                onChange={(event) => {
                  const { name: _was, ...rest } = part;
                  set(at, (event.target.value ? { ...rest, name: event.target.value } : rest) as Part);
                }}
              />
            </Field>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-sm gap-1.5 self-start rounded-xl" disabled={step.steps.length >= TOGETHER_MAX} onClick={() => write([...step.steps, blankPart("agentTurn")])}>
        <Plus size={14} aria-hidden="true" /> Add another
      </button>
    </>
  );
}

export function KindFields({
  step,
  own,
  agents,
  alone,
  script,
  onChange,
}: {
  step: Step;
  /** The automation's own agent. */
  own: string;
  agents: readonly AgentChoice[];
  /** Set while this command is the one thing the automation does: what its output is worth is a choice of its own. */
  alone: { then: Then; agent: string; onThen: (then: Then) => void } | null;
  script: ScriptContext;
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
      return <CommandStep step={step} alone={alone} script={script} onChange={onChange} />;
    case "mission":
      return <MissionStep step={step} own={own} agents={agents} onChange={onChange} />;
    case "approval":
      return <ApprovalStep step={step} onChange={onChange} />;
    case "parallel":
      return <TogetherStep step={step} own={own} agents={agents} onChange={onChange} />;
  }
}
