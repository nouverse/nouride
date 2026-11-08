/**
 * One mission, working: how far it is against each limit, what it is doing this moment, its checklist, what waits on
 * you, the questions it asked, its result, and its turns — with what a person says to it, each only when it applies,
 * and (0.8.10) a box to tell it something while it works. Laid out (0.8.8) as its result across the page once it has one, its turns as a timeline, and beside them
 * its checklist and what decides it is done.
 *
 * Two sources. The record (`/missions/:id`), asked again every few seconds while it can change and as a slow net once it
 * cannot — a hidden tab asks for none of it, the query client's rule for an interval. And its conversation, read
 * exactly as the chat reads one (`useConversation`): the same live loop and event stream, so the "now" line and the
 * turns are what the chat would draw, and a turn ending reads the record again at once.
 */

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, FolderOpen, ScrollText, ShieldCheck, TriangleAlert } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { MissionDetail } from "@nouride/wire";
import { ApiError } from "@/commons/lib/api.client";
import { ApprovalCard } from "@/commons/components/approvals/ApprovalCard";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";
import { useConversation } from "@/commons/hooks/use-conversation";
import { ago } from "@/commons/lib/format";
import { canWrite, useMe } from "@/commons/lib/session";
import { Checklist } from "./components/Checklist";
import { Meters } from "./components/Meters";
import { MissionActions } from "./components/MissionActions";
import { MissionResult } from "./components/MissionResult";
import { BriefCard } from "./components/BriefCard";
import { MissionTimeline } from "./components/MissionTimeline";
import { NowLine } from "./components/NowLine";
import { AnswerBox, Questions } from "./components/Questions";
import { TellBox, ToldList } from "./components/Told";
import { SeenBadge } from "./components/SeenBadge";
import { useMissionAct } from "./hooks/use-mission-act";
import { useMissionDelete } from "./hooks/use-mission-delete";
import { Goal } from "./components/Goal";
import { DraftForm } from "./components/DraftForm";
import { briefShown, meters, missionTitle, needsYouSaid, shortId } from "./lib/mission";

const OPEN_MS = 5_000;
const SETTLED_MS = 60_000;

const noSession = () => {};

/** How it is judged done, in the words the daemon's start notice uses: its checks, then the reviewer, then a person. */
function JudgedBy({ detail }: { detail: MissionDetail }) {
  const { mission } = detail;
  return (
    <div className="space-y-3 text-sm">
      {mission.checks.length > 0 && (
        <div className="space-y-1">
          <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">Checks that must pass</p>
          <ul className="space-y-1">
            {mission.checks.map((check) => (
              <li key={check} className="rounded-lg bg-base-200/70 px-2.5 py-1 font-mono text-xs break-all">
                {check}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* A reviewer's brief names paths with no place to break: one ran 140 px out of this card (live, 2026-10-31). */}
      <p className="text-base-content/80 [overflow-wrap:anywhere]">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">Reviewer · </span>
        {mission.reviewOn ? (mission.review ?? "checks the result against the goal") : "none"}
      </p>
      {(mission.accept || mission.checks.length === 0) && <p className="text-base-content/80">A person accepts the result before it is done.</p>}
      {mission.lastCheck && (
        <div className="space-y-1">
          <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-error">Last check failed</p>
          <pre className="max-h-48 overflow-auto rounded-lg bg-base-200/70 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{mission.lastCheck}</pre>
        </div>
      )}
      <p className="flex items-start gap-1.5 font-mono text-xs text-base-content/70 break-all">
        <FolderOpen size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {mission.workdir}
      </p>
    </div>
  );
}

export default function MissionPage({ missionId }: { missionId: string }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const found = useQuery({
    queryKey: ["missions", "detail", missionId],
    queryFn: () => api.mission(missionId),
    refetchInterval: (query) => {
      const seen = query.state.data?.mission.seen;
      return seen === "working" || seen === "needs_you" ? OPEN_MS : SETTLED_MS;
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const detail = found.data;
  const conversation = useConversation({
    ...(detail ? { sessionId: detail.sessionId } : {}),
    agentId: detail?.mission.agentId ?? "",
    // Nothing is sent from here, so the conversation is never a new one to move to.
    onSession: noSession,
  });
  const act = useMissionAct(missionId);
  const remove = useMissionDelete(missionId);
  const answerApproval = useAnswerApproval();

  /** A turn ending moves the meters and the checklist: read the record again then, not on the next interval. */
  const finished = conversation.turns.length;
  useEffect(() => {
    if (finished > 0) void queryClient.invalidateQueries({ queryKey: ["missions", "detail", missionId] });
  }, [finished, missionId, queryClient]);

  if (found.isLoading) {
    return (
      <div className="flex justify-center p-16">
        <span className="loading loading-spinner loading-lg text-primary opacity-60" />
      </div>
    );
  }
  if (!detail) {
    if (found.error instanceof ApiError && found.error.status === 404) {
      return (
        <Card>
          <EmptyState pose="confused" title="No such mission" description={`There is no mission called ${missionId} here.`} action={<Link to="/missions" className="btn btn-sm btn-ghost">All missions</Link>} />
        </Card>
      );
    }
    return <ErrorNote error={found.error} />;
  }

  const { mission, plan, parked } = detail;
  const writable = canWrite(me.data ?? null);
  const live = conversation.liveTurns[0];
  const waitingOn = mission.status === "waiting" ? mission.waitKind : null;
  const draft = waitingOn === "accept" && mission.startedAt === null;

  return (
    <div className="space-y-5">
      <Link to="/missions" className="btn btn-ghost btn-xs -ml-2 gap-1.5 rounded-lg text-base-content/70">
        <ArrowLeft size={13} aria-hidden="true" /> Missions
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <SeenBadge mission={mission} />
          <span className="font-mono text-[11px] text-base-content/65">
            {mission.agentId} · {shortId(mission.id)} · started {ago(mission.startedAt ?? mission.createdAt)}
            {mission.byAgent ? ` · by ${mission.byAgent}` : ""}
            {mission.jobId ? ` · a run of job ${detail.jobName ?? mission.jobId}` : ""}
          </span>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <h1 className="min-w-0 text-lg font-semibold leading-snug tracking-tight text-base-content [overflow-wrap:anywhere] sm:text-xl">{missionTitle(mission.goal)}</h1>
          <MissionActions
            mission={mission}
            writable={writable}
            pending={act.isPending || remove.isPending}
            onAct={(verb) => act.mutate({ verb })}
            onDelete={(force) => remove.mutateAsync(force)}
          />
        </div>
        {mission.goal.replace(/\s+/g, " ").trim() !== missionTitle(mission.goal) && <Goal goal={mission.goal} />}
      </header>

      {mission.seen === "needs_you" && (
        <div role="status" className="alert alert-soft alert-warning grid-cols-[auto_minmax(0,1fr)] items-start rounded-2xl">
          <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="w-full min-w-0 space-y-3">
            <p className="text-sm leading-relaxed text-base-content">
              <span className="mr-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-warning">Needs you</span>
              {waitingOn === "input" ? "It asked a question and waits for your answer." : needsYouSaid(mission)}
            </p>
            {waitingOn === "input" && (
              <>
                <p className="rounded-xl bg-base-100/80 px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]">{mission.reason}</p>
                <AnswerBox disabled={!writable} pending={act.isPending} onAnswer={(text) => act.mutate({ verb: "answer", text })} />
              </>
            )}
          </div>
        </div>
      )}

      {/* A draft (0.8.11): nothing has run; what it will do, how it is judged and its brief are changed here before it starts. */}
      {draft && (
        <Card title="Draft" description="Nothing has run. Change it here, then start it, or drop it.">
          <DraftForm key={mission.updatedAt} mission={mission} brief={detail.brief ?? null} ownFolder={mission.workdir.endsWith(`/missions/${mission.id}`)} writable={writable} />
        </Card>
      )}

      {detail.brief && <BriefCard brief={detail.brief} shown={briefShown(detail.briefPath, mission.id)} />}

      {/* Parked while it works on what does not depend on them — a mission waits only once nothing else moves. */}
      {parked.length > 0 && (
        <section aria-label="Approvals it parked" className="space-y-2.5">
          <h2 className="flex items-center gap-1.5 px-1 font-mono text-[11px] font-bold uppercase tracking-wider text-base-content/65">
            <ShieldCheck size={13} aria-hidden="true" /> Waiting for your approval · {parked.length}
          </h2>
          {parked.map((request) => (
            <ApprovalCard
              key={request.id}
              request={request}
              pending={answerApproval.isPending}
              onAnswer={(req, decision) =>
                answerApproval.mutate({ request: req, decision }, { onSettled: () => void queryClient.invalidateQueries({ queryKey: ["missions", "detail", missionId] }) })
              }
            />
          ))}
        </section>
      )}

      <Meters meters={meters(mission, plan, detail.steps)} />

      {mission.seen === "working" && <NowLine mission={mission} live={live?.status === "running" ? live : undefined} jobs={conversation.jobs} {...(detail.reviewing ? { reviewing: detail.reviewing } : {})} />}

      {(mission.report || mission.files.length > 0) && (
        <Card title="Result" description={mission.seen === "done" ? "What it handed back." : "What it handed back so far."}>
          <MissionResult report={mission.report} files={mission.files} workdir={mission.workdir} />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="Turns" description="Newest first, each from the mission's page. Open a turn's steps to see what it did." className="min-w-0">
          <MissionTimeline turns={conversation.turns} live={live} />
        </Card>

        {/* Below lg one column, and its cards items of the grid (`contents`), so the Checklist can come before the Turns:
            "how far is it" was read past every turn on a phone (0.8.11). From lg, the column beside them. */}
        <aside className="min-w-0 max-lg:contents max-lg:[&>*]:min-w-0 lg:space-y-5">
          {(mission.seen === "working" || mission.seen === "needs_you" || mission.told.length > 0) && (
            <Card title="Tell it" description={mission.seen === "working" || mission.seen === "needs_you" ? "Something it should know while it works." : "What it was told while it worked."}>
              <div className="space-y-4">
                {(mission.seen === "working" || mission.seen === "needs_you") && (
                  <TellBox disabled={!writable} pending={act.isPending} onTell={(text, done) => act.mutate({ verb: "tell", text }, { onSuccess: done })} />
                )}
                <ToldList told={mission.told} />
              </div>
            </Card>
          )}
          <Card title="Checklist" description="Kept by the agent; every turn starts from it." className="max-lg:order-first">
            <Checklist plan={plan} />
          </Card>
          {mission.answers.length > 0 && (
            <Card title="Questions">
              <div className="space-y-3">
                <Questions answers={mission.answers} />
              </div>
            </Card>
          )}
          <Card title="Done when">
            <JudgedBy detail={detail} />
          </Card>
          {mission.seen === "ended" && mission.reason && (
            <Card title="Why it ended">
              <p className="flex items-start gap-1.5 text-sm text-base-content/80 [overflow-wrap:anywhere]">
                <ScrollText size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> {mission.reason}
              </p>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
