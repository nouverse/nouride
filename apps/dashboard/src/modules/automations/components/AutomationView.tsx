/**
 * One automation, drawn as a canvas: how it starts, its steps in order, where its results go. The same view makes a new
 * one. Three things can be drawn on the canvas, one at a time: the steps themselves, to be changed; a run, with how
 * each step went and the path it took; and a change an agent suggested, beside the steps as they run now.
 *
 * Beside the canvas is one panel. A pressed box opens its fields there, the canvas staying in view; with nothing
 * pressed it holds the last runs. On a screen with no room beside the canvas a box opens in place, under itself: no
 * sheet over the page. Whose the automation is opens there too, from the head's menu: it was two cards of explanation
 * beside the steps on every visit.
 *
 * What is typed is a draft (`useEditor`): the page saves nothing until Save, and a run's polling never moves a draft.
 *
 * One the reader only reads (it reports to a chat of theirs, and is another person's) is drawn the same, with nothing
 * that changes it: its steps and its runs are read, and what a run waits for is its own person's to answer.
 */

import { useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { JobRunSummary } from "@nouride/wire";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { useToast } from "@/commons/components/ui/toast";
import { useKnownChats } from "@/commons/hooks/use-known-chats";
import { useDesktop } from "@/commons/hooks/use-wide";
import { usePageSubject } from "@/commons/hooks/use-page-subject";
import { useWaitingSteps } from "@/commons/hooks/use-waiting-steps";
import { api } from "@/commons/lib/api";
import { answeredBy, readsOnly } from "@/commons/lib/by-person";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useDrawn, type AutomationDetail } from "../hooks/use-drawn";
import { OPEN_OWNER, useEditor, type Editor } from "../hooks/use-editor";
import { useSave, type Saving } from "../hooks/use-save";
import { draftOf, draftProblems, turnsIntoList, type Draft } from "../lib/draft";
import { pathsOf } from "../lib/paths";
import { outcomesOf, whenWords } from "../lib/runs";
import type { Step, StepProblem } from "../lib/steps";
import { stepTitle } from "../lib/words";
import { AutomationCanvas } from "./AutomationCanvas";
import { AutomationHeader } from "./AutomationHeader";
import type { AgentChoice } from "./KindFields";
import { OpenFields, opensFields } from "./OpenFields";
import { AtRest, PanelCard, Whose } from "./Panel";
import { SaveBar } from "./SaveBar";
import type { FlowMode } from "./StepItem";
import { SuggestedBanner } from "./SuggestedBanner";
import { reportsWords } from "./WhoCard";

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

export function AutomationView({ detail, blank, home }: { detail: AutomationDetail | null; blank: Draft; home: string }) {
  const automation = detail?.automation ?? null;
  // What the floating chat tells an agent this page is about: the automation by its name; nothing while one is made.
  usePageSubject(automation?.name);
  const fresh = automation === null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const me = useMe();
  // Whether there is room beside the canvas for a pressed box's fields: without it they open in the box. A desktop's
  // width: on a laptop's the menu and a panel left the canvas 300px, and its boxes too narrow for their own titles.
  const laptop = useDesktop();
  // Whether this page may change it: the account may change automations, and this one is not another person's.
  const [writable, admin] = [canWrite(me.data ?? null) && !(automation && readsOnly(automation)), isAdmin(me.data ?? null)];
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways, retry: false });
  const { labelOf } = useKnownChats();
  const waiting = useWaitingSteps();
  const agents = useOrchestratorFirst(status.data?.agents ?? [], (agent) => agent.id).map((agent) => ({ id: agent.id, name: agent.displayName || agent.id }));
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;

  const loaded = useMemo(() => (automation ? draftOf(automation, home) : blank), [automation, blank, home]);
  const editor = useEditor(loaded, fresh);
  const { draft, open } = editor;
  const { runs, view, setView, runId, side, setSide, suggested, run, showsSuggested, shown, marks, showRun } = useDrawn(detail, loaded, draft, home);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["automations"] });
  const saving = useSave(automation?.id ?? null, loaded, draft, (id) => {
    if (fresh) void navigate({ to: "/automations/$id", params: { id } });
    else editor.discard();
  });

  const editable = writable && !automation?.proposal && view === "steps" && !showsSuggested;
  const { problems, steps: stepIssues } = draftProblems(draft);
  const removed = (kept: Draft, said: string) => toast.show({ kind: "info", message: said, duration: 7_000, action: { label: "Undo", onPress: () => editor.restore(kept) } });
  const remove = (index: number) => {
    const kept = editor.remove(index);
    const place = pathsOf(kept.steps, false).line.indexOf(index);
    removed(kept, place >= 0 ? `Step ${place + 1} deleted` : "Step deleted");
  };

  const mode: FlowMode = run
    ? { kind: "run", run, outcomes: outcomesOf(shown.steps, run), name: automation?.name ?? "", before: saidBefore(run, waiting.data?.waiting.find((step) => step.runId === run.id)?.said), canAnswer: writable, whom: automation ? answeredBy(automation) : undefined }
    : editable
      ? editing(editor, agents, stepIssues, saving.refused, remove)
      : { kind: "read" };

  // What is open, as its fields: a step's, how it starts, where its results go. Only while the steps can be changed.
  const close = () => editor.setOpen(null);
  const titleOf = (step: Step) => stepTitle(step, agentName(("agentId" in step && step.agentId) || draft.agentId));
  const fields: ReactNode =
    editable && opensFields(editor) ? (
      <OpenFields
        editor={editor}
        automation={automation}
        runs={runs}
        home={home}
        writable={writable}
        admin={admin}
        agents={agents}
        agentName={agentName}
        gateways={gateways.data?.gateways ?? []}
        titleOf={titleOf}
        onChanged={refresh}
        onRemove={remove}
        onWent={(kept) => removed(kept, "The steps of its last answer went with it")}
      />
    ) : null;
  const gone = () => {
    refresh();
    void navigate({ to: "/automations" });
  };
  const whose = open === OPEN_OWNER && automation && !automation.proposal ? <Whose automation={automation} onHanded={gone} onDone={close} /> : null;
  // A webhook's standing yes is an admin's to give, as making the webhook was.
  const atRest = <AtRest automation={automation} runs={runs} picked={run?.id ?? null} onPick={(picked) => showRun(picked.id)} canAllow={automation?.start === "webhook" ? admin : writable} />;

  return (
    <div className="space-y-5">
      <AutomationHeader
        automation={automation}
        draft={draft}
        home={home}
        reports={reportsWords(shown, labelOf)}
        onWhose={() => editor.setOpen(open === OPEN_OWNER ? null : OPEN_OWNER)}
        agentName={agentName}
        canName={writable && !automation?.proposal}
        writable={writable}
        admin={admin}
        dirty={editor.dirty}
        onName={(name) => editor.set({ name })}
        onChanged={refresh}
        onRan={(outcome) => (outcome.status === "unavailable" ? undefined : showRun(null))}
        onGone={gone}
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
          // A change proposed in a chat the reader cannot open is not theirs to answer: the server says so of it.
          canAnswer={(suggested.start === "webhook" ? admin : writable) && suggested.changeable !== false}
          held={editor.dirty ? "Save or discard your own changes first." : null}
          onAnswered={() => {
            setSide("current");
            refresh();
          }}
        />
      ) : null}

      {/* Whose it is, over the canvas where there is no room beside it. */}
      {whose && !laptop ? <PanelCard label="Whose it is">{whose}</PanelCard> : null}

      <AutomationCanvas
        shown={shown}
        home={home}
        agentName={agentName}
        mode={mode}
        marks={marks}
        drawn={`${mode.kind} ${showsSuggested ? "suggested" : "current"}`}
        editor={editor}
        editable={editable}
        laptop={laptop}
        fields={fields}
        run={run}
        lacks={problems[0]}
        beside={laptop && whose ? <PanelCard label="Whose it is">{whose}</PanelCard> : laptop && fields ? <PanelCard label="Change this box">{fields}</PanelCard> : atRest}
      />

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
