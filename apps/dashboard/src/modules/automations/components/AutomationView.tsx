/**
 * One automation, laid out as a flow: how it starts, its steps in order, where it reports. The same view makes a new
 * one. Three things can be drawn over the steps, one at a time: the steps themselves, to be changed; a run, with how
 * each step went and the path it took; and a change an agent suggested, beside the steps as they run now.
 *
 * What is typed is a draft (`useEditor`): the page saves nothing until Save, and a run's polling never moves a draft.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { AutomationSummary, JobRunSummary } from "@nouride/wire";
import { Allowed } from "@/commons/components/jobs/Allowances";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { useToast } from "@/commons/components/ui/toast";
import { useKnownChats } from "@/commons/hooks/use-known-chats";
import { useWaitingSteps } from "@/commons/hooks/use-waiting-steps";
import { api } from "@/commons/lib/api";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useEditor, type Editor } from "../hooks/use-editor";
import { useSave, type Saving } from "../hooks/use-save";
import { deliveryOf, draftOf, draftProblems, stepsOf, turnsIntoList, type Draft } from "../lib/draft";
import { live, outcomesOf, whenWords } from "../lib/runs";
import type { StepProblem } from "../lib/steps";
import { stepMarks } from "../lib/suggested";
import { AutomationHeader } from "./AutomationHeader";
import { Flow } from "./Flow";
import type { AgentChoice } from "./KindFields";
import { RecentRuns } from "./RecentRuns";
import { SaveBar } from "./SaveBar";
import { StartCard } from "./StartCard";
import type { FlowMode } from "./StepItem";
import { SuggestedBanner, type Side } from "./SuggestedBanner";
import { WhoCard } from "./WhoCard";

export interface AutomationDetail {
  automation: AutomationSummary;
  runs: JobRunSummary[];
  suggested?: AutomationSummary;
  timezone: string;
}

/** What the step a run waits in was handed: the waiting list's own words, or what the step reached before it said. */
function saidBefore(run: JobRunSummary, listed: string | undefined): string | undefined {
  if (listed) return listed;
  const at = run.steps?.findIndex((outcome) => outcome.id === run.waiting?.step) ?? -1;
  return at > 0 ? run.steps![at - 1]!.said : undefined;
}

/** The flow while its steps are changed: the draft's editor, and what is wrong with each step, the first thing said for each. */
function editing(editor: Editor, agents: readonly AgentChoice[], issues: readonly StepProblem[], refused: Saving["refused"], onRemove: (index: number) => void): FlowMode {
  const problems = new Map(issues.flatMap((issue) => (issue.index === null ? [] : [[issue.index, issue.message] as const])).reverse());
  return { kind: "edit", editor, agents, problems, refused, onRemove };
}

/** Beside the flow, under it on a phone: its runs, what its runs may send without asking, and who may change it. */
function Beside({ automation, runs, picked, onPick, canAllow }: { automation: AutomationSummary | null; runs: JobRunSummary[]; picked: string | null; onPick: (run: JobRunSummary) => void; canAllow: boolean }) {
  return (
    <aside className="w-full space-y-4 lg:w-80 lg:shrink-0">
      {automation && !automation.proposal ? <RecentRuns jobId={automation.id} runs={runs} picked={picked} onPick={onPick} canAllow={canAllow} /> : null}
      {automation?.allowed?.length ? (
        <section className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft">
          <Allowed job={automation} canEdit={canAllow} />
        </section>
      ) : null}
      <section className="space-y-2 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft">
        <h2 className="text-lg text-base-content">Who may change it</h2>
        <p className="text-sm text-base-content/85">You change the steps here. An agent can suggest a change, and it waits for your yes.</p>
        <p className="text-xs text-base-content/65">Nouride runs the steps in this order every time. An agent only does the step it is given, with what the step before it said.</p>
      </section>
    </aside>
  );
}

export function AutomationView({ detail, blank, home }: { detail: AutomationDetail | null; blank: Draft; home: string }) {
  const automation = detail?.automation ?? null;
  // page subject: <automation.name> (<automation.id>), once `automation` is here; none while one is being made.
  const fresh = automation === null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const [writable, admin] = [canWrite(me.data ?? null), isAdmin(me.data ?? null)];
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways, retry: false });
  const { labelOf } = useKnownChats();
  const waiting = useWaitingSteps();
  const agents = useOrchestratorFirst(status.data?.agents ?? [], (agent) => agent.id).map((agent) => ({ id: agent.id, name: agent.displayName || agent.id }));
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;

  const loaded = useMemo(() => (automation ? draftOf(automation, home) : blank), [automation, blank, home]);
  const editor = useEditor(loaded, fresh);
  const runs = detail?.runs ?? [];
  const [view, setView] = useState<"steps" | "run">(() => (live(runs[0]) ? "run" : "steps"));
  const [runId, setRunId] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("current");
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["automations"] });
  const saving = useSave(automation?.id ?? null, loaded, editor.draft, (id) => {
    if (fresh) void navigate({ to: "/automations/$id", params: { id } });
    else editor.discard();
  });

  const { draft } = editor;
  const suggested = detail?.suggested ?? null;
  const run = view === "run" ? (runs.find((one) => one.id === runId) ?? runs[0]) : undefined;
  const showsSuggested = suggested !== null && side === "suggested" && view === "steps";
  const shown = showsSuggested ? draftOf(suggested, home) : run && automation ? loaded : draft;
  const marks = suggested && automation && view === "steps" ? stepMarks(stepsOf(automation.payload), stepsOf(suggested.payload)) : null;
  const editable = writable && !automation?.proposal && view === "steps" && !showsSuggested;
  const { problems, steps: stepIssues } = draftProblems(draft);
  // The card that holds what a save lacks first says so, in the bar's own words: one thing at a time.
  const lacking = (part: (typeof problems)[number]["part"]) => (problems[0]?.part === part ? problems[0].message : undefined);

  const mode: FlowMode = run
    ? { kind: "run", run, outcomes: outcomesOf(shown.steps, run), name: automation?.name ?? "", before: saidBefore(run, waiting.data?.waiting.find((step) => step.runId === run.id)?.said), canAnswer: writable }
    : editable
      ? editing(editor, agents, stepIssues, saving.refused, (index) => {
          const kept = editor.remove(index);
          toast.show({ kind: "info", message: `Step ${index + 1} deleted`, duration: 7_000, action: { label: "Undo", onPress: () => editor.restore(kept) } });
        })
      : { kind: "read" };

  const delivery = deliveryOf(shown);
  const reportChat = shown.chatId.trim() ? (labelOf(delivery.gatewayId ?? shown.gatewayId, delivery.chatId ?? shown.chatId.trim()) ?? shown.chatId.trim()) : null;

  return (
    <div className="space-y-5">
      <AutomationHeader
        automation={automation}
        draft={draft}
        home={home}
        reports={delivery.mode === "announce" ? reportChat : null}
        agentName={agentName}
        canName={writable && !automation?.proposal}
        writable={writable}
        admin={admin}
        dirty={editor.dirty}
        onName={(name) => editor.set({ name })}
        onChanged={refresh}
        onRan={(outcome) => {
          if (outcome.status === "unavailable") return;
          setRunId(null);
          setView("run");
        }}
        onGone={() => {
          refresh();
          void navigate({ to: "/automations" });
        }}
      />

      {automation && !automation.proposal && runs.length > 0 ? (
        <SegmentedTabs
          label="What to show"
          tabs={[
            { value: "steps", label: "Steps" },
            { value: "run", label: !runId || runId === runs[0]?.id ? "Last run" : `Run of ${whenWords(runs.find((one) => one.id === runId)?.startedAt ?? 0)}` },
          ]}
          value={view}
          onChange={setView}
        />
      ) : null}

      {suggested && automation && view === "steps" ? (
        <SuggestedBanner
          current={automation}
          suggested={suggested}
          home={home}
          side={side}
          onSide={setSide}
          canAnswer={suggested.start === "webhook" ? admin : writable}
          held={editor.dirty ? "Save or discard your own changes first." : null}
          onAnswered={() => {
            setSide("current");
            refresh();
          }}
        />
      ) : null}

      <div className="flex flex-col items-start gap-6 lg:flex-row lg:gap-7">
        <div className="w-full min-w-0 lg:max-w-[44rem] lg:flex-1">
          <Flow
            // Drawn anew for each way of showing it, so one view's open card or lit jump is not carried into the next.
            key={`${mode.kind} ${showsSuggested ? "suggested" : "current"}`}
            steps={shown.steps}
            own={shown.agentId}
            agentName={agentName}
            mode={mode}
            marks={showsSuggested ? marks?.suggested : marks?.current}
            head={
              <StartCard
                draft={shown}
                automation={automation}
                home={home}
                editable={editable}
                writable={writable}
                admin={admin}
                note={run ? `This run started ${whenWords(run.startedAt).replace(/^Today/, "today").replace(/^Yesterday/, "yesterday")}.` : undefined}
                missing={editable ? lacking("start") : undefined}
                set={editor.set}
                onChanged={refresh}
              />
            }
            foot={<WhoCard draft={shown} fresh={fresh} editable={editable} agents={agents} gateways={gateways.data?.gateways ?? []} missing={editable ? lacking("who") : undefined} set={editor.set} />}
          />
        </div>

        <Beside
          automation={automation}
          runs={runs}
          picked={run?.id ?? null}
          onPick={(picked) => {
            setRunId(picked.id);
            setView("run");
          }}
          // A webhook's standing yes is an admin's to give, as making the webhook was.
          canAllow={automation?.start === "webhook" ? admin : writable}
        />
      </div>

      {editor.dirty && view === "steps" && !showsSuggested && writable ? (
        <SaveBar
          fresh={fresh}
          saving={saving.pending}
          lacks={problems[0]?.message ?? null}
          notes={turnsIntoList(fresh ? null : loaded, draft)}
          error={saving.error}
          onSave={saving.save}
          onDiscard={() => {
            saving.forget();
            if (fresh) void navigate({ to: "/automations" });
            else editor.discard();
          }}
        />
      ) : null}
    </div>
  );
}
