/**
 * A script step's fields: what it does, in words first; what is known of it without reading it (who wrote it, what
 * runs it, how long it is, which saved keys it is handed); and behind buttons, the agent that can write or change
 * it, the text itself, and a run of it to see.
 *
 * A person who does not read code agrees to a script by what it is said to do, and by seeing it run: "Try it" runs it
 * once on what the step before would hand it and shows what it printed. That is a real run, and the button says so.
 */

import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Code, FlaskConical } from "lucide-react";
import type { TriedStep } from "@nouride/wire";
import { AskAgentButton } from "@/commons/components/agents/AskAgentButton";
import { Expandable } from "@/commons/components/ui/ListCard";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import { api } from "@/commons/lib/api";
import { cn } from "@/commons/lib/utils";
import { took } from "../lib/runs";
import type { Step } from "../lib/steps";
import { scriptWriter } from "../lib/words";

type Command = Extract<Step, { kind: "command" }>;
type Scripted = Command & { script: NonNullable<Command["script"]> };

/** The programs a script is most often written for, by what a person calls each. One named otherwise is shown as it is. */
const PROGRAMS: { run: string; label: string }[] = [
  { run: "sh", label: "Shell" },
  { run: "python3", label: "Python" },
  { run: "bun", label: "JavaScript (Bun)" },
  { run: "node", label: "JavaScript (Node)" },
];

const runOf = (step: Command): string => step.argv.join(" ");
/** What a script is written in, as a person says it. */
const languageOf = (step: Command): string => PROGRAMS.find((program) => program.run === runOf(step))?.label ?? (runOf(step) || "a program");


const lineCount = (text: string): number => (text.trim() ? text.trimEnd().split("\n").length : 0);

const TRIED: Record<TriedStep["status"], { label: string; tone: string }> = {
  done: { label: "It worked", tone: "bg-success/15 text-success" },
  empty: { label: "It worked, and had nothing to say", tone: "bg-base-content/[0.06] text-base-content/70" },
  failed: { label: "It failed", tone: "bg-error/10 text-error" },
};

const CHIP = "rounded-full bg-base-content/[0.06] px-2.5 py-0.5 text-xs font-bold text-base-content/75";

/** What is known of a script without reading it: who wrote it, what it is written in and how long it is, the keys it is handed. */
function ScriptFacts({ step, agentName }: { step: Scripted; agentName: (id: string) => string }) {
  const { script } = step;
  const writer = scriptWriter(script.by, agentName);
  const lines = lineCount(script.text);
  return (
    <ul aria-label="About this script" className="flex list-none flex-wrap gap-1.5">
      {writer ? <li className={CHIP}>Written by {writer}</li> : null}
      <li className={CHIP}>
        {languageOf(step)}
        {lines > 0 ? `, ${lines} ${lines === 1 ? "line" : "lines"}` : ""}
      </li>
      <li className={CHIP}>No AI</li>
      {script.secrets?.length ? (
        <li className={CHIP}>
          Uses your saved {script.secrets.length === 1 ? "key" : "keys"}: {script.secrets.join(", ")}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * A script read and not changed: what is known of it, and its text behind the same button. For one an agent proposed,
 * before it is turned on; for a suggested change, on both sides; and for whoever only reads the automation. Its card
 * in a chat sends a person here for a text too long for a message, so the page must show it where nothing is edited.
 */
export function ScriptRead({ step, agentName }: { step: Scripted; agentName: (id: string) => string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="space-y-2.5" data-script-read>
      <ScriptFacts step={step} agentName={agentName} />
      <button type="button" aria-expanded={shown} className="btn btn-sm gap-1.5 rounded-xl border-base-content/15 bg-base-100" onClick={() => setShown((was) => !was)}>
        <Code size={14} aria-hidden="true" />
        {shown ? "Hide the script" : "Show the script"}
      </button>
      {shown ? <pre className="max-h-96 overflow-auto rounded-[14px] bg-base-200/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-base-content/85 [overflow-wrap:anywhere]">{step.script.text}</pre> : null}
    </div>
  );
}

/** "Try it": the script run once, for real, on what it is given to read, and what it printed. */
function TryIt({ step, agentId, sample }: { step: Scripted; agentId: string; sample: string | undefined }) {
  const [input, setInput] = useState(sample ?? "");
  const tried = useMutation({ mutationFn: () => api.cronTry({ agentId, step, ...(input ? { input } : {}) }) });
  const result = tried.data?.tried;
  return (
    <section aria-label="Try it" className="space-y-2.5 rounded-[18px] bg-base-200/60 p-3.5">
      <Field label="What it is given to read" hint="What the step before it would hand it. Empty: nothing.">
        <textarea className="textarea w-full text-sm leading-relaxed" rows={2} value={input} onChange={(event) => setInput(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm gap-1.5 rounded-xl" disabled={tried.isPending || !step.script.text.trim() || !agentId} onClick={() => tried.mutate()}>
          {tried.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
          Run it once
        </button>
        <p className="min-w-0 flex-1 text-xs text-base-content/65">It runs for real, once: a script that sends or saves something does so.</p>
      </div>
      {result ? (
        <div role="status" data-tried={result.status} className="space-y-1.5">
          <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold", TRIED[result.status].tone)}>
            {TRIED[result.status].label} · {took(result.ms)}
          </span>
          {result.said ? (
            <Expandable maxHeight="max-h-56">
              <p className="rounded-[14px] bg-base-100 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-base-content/85 [overflow-wrap:anywhere]">{result.said}</p>
            </Expandable>
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={tried.error} />
    </section>
  );
}

export function ScriptFields({
  step,
  agentId,
  agentName,
  asks,
  sample,
  more,
  onChange,
}: {
  step: Scripted;
  /** The agent it runs as: whose commands it is one of. */
  agentId: string;
  agentName: (id: string) => string;
  /** What the button that asks an agent to write or change it puts in the chat: the automation and the step named. None hides the button. */
  asks?: string | undefined;
  /** What the step before said in the last run: what "Try it" starts with. */
  sample?: string | undefined;
  /** What else the step is set with, shown with its text: how long it may take. */
  more?: ReactNode;
  onChange: (step: Step) => void;
}) {
  const { script } = step;
  const [trying, setTrying] = useState(false);
  // One with nothing written yet, or nothing said of what it does, opens on its text: there is nothing to read of it
  // in words, and the text is what its writer came for.
  const [shown, setShown] = useState(() => !script.text.trim() || !script.about.trim());
  // As it is typed: read back from the step, a comma just written would be gone before the next name.
  const [keys, setKeys] = useState(() => (script.secrets ?? []).join(", "));
  const write = (patch: Partial<Scripted["script"]>) => onChange({ ...step, script: { ...script, ...patch } });
  const listed = PROGRAMS.some((program) => program.run === runOf(step));
  return (
    <>
      <Field label="What it does" hint="One line, in plain words: what a person reads before turning it on.">
        <input className="input w-full text-sm" value={script.about} placeholder="Saves the summary to the notes page" onChange={(event) => write({ about: event.target.value })} />
      </Field>
      <ScriptFacts step={step} agentName={agentName} />
      <div className="flex flex-wrap gap-2">
        {/* Named for what it asks, apart from the page's own "to change it" at its head. */}
        {asks ? <AskAgentButton task={script.text.trim() ? "to change this script" : "to write this script"} message={asks} variant="soft" /> : null}
        <button type="button" aria-expanded={shown} className="btn btn-sm gap-1.5 rounded-xl border-base-content/15 bg-base-100" onClick={() => setShown((was) => !was)}>
          <Code size={14} aria-hidden="true" />
          {shown ? "Hide the script" : "Show the script"}
        </button>
        <button type="button" aria-expanded={trying} className="btn btn-sm gap-1.5 rounded-xl border-base-content/15 bg-base-100" onClick={() => setTrying((was) => !was)}>
          <FlaskConical size={14} aria-hidden="true" />
          Try it
        </button>
      </div>
      {shown ? (
        <div className="space-y-3">
          <Field label="Script" hint="It reads what the step before said, and what it prints goes to the next step. Printing nothing says nothing; ending with an error is a failure.">
            <textarea className="textarea min-h-48 w-full font-mono text-[13px] leading-relaxed" value={script.text} spellCheck={false} onChange={(event) => write({ text: event.target.value })} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Written in">
              <SearchSelect
                label="Written in"
                align="start"
                className="w-full"
                options={[...PROGRAMS.map((program) => ({ value: program.run, label: program.label })), ...(listed ? [] : [{ value: runOf(step), label: runOf(step) }])]}
                value={runOf(step)}
                onChange={(run) => onChange({ ...step, argv: run.split(" ").filter(Boolean) })}
              />
            </Field>
            <Field
              label="Saved keys it uses"
              hint="Their names, with a comma between. The script reads each by its name in capitals: notes_key is NOTES_KEY." // plain-words-ok: a saved key's name and how a script reads it, for whoever writes the script
            >
              <input
                className="input w-full font-mono text-[13px]"
                value={keys}
                onChange={(event) => {
                  setKeys(event.target.value);
                  const names = event.target.value.split(",").map((name) => name.trim()).filter(Boolean);
                  const { secrets: _was, ...rest } = script;
                  onChange({ ...step, script: names.length > 0 ? { ...rest, secrets: names } : rest });
                }}
              />
            </Field>
          </div>
          {more}
        </div>
      ) : null}
      {trying ? <TryIt step={step} agentId={agentId} sample={sample} /> : null}
    </>
  );
}
