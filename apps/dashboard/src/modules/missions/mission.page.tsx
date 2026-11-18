/**
 * One mission, working: how far it is against each limit, what it is doing this moment, its checklist, what waits on
 * you, the questions it asked, its result, and its turns — with what a person says to it, each only when it applies,
 * and (0.8.10) a box to tell it something while it works. Laid out from the top as a person asks of it: what it does
 * now and how far it is, its brief beside what decides it is done, its result once it has one, then its checklist and
 * its turns, with its folder and the box to tell it something beside them. A draft shows none of what only work
 * makes: no meters, no checklist, no turns.
 *
 * Two sources. The record (`/missions/:id`), asked again every few seconds while it can change and as a slow net once it
 * cannot — a hidden tab asks for none of it, the query client's rule for an interval. And its conversation, read
 * exactly as the chat reads one (`useConversation`): the same live loop and event stream, so the "now" line and the
 * turns are what the chat would draw, and a turn ending reads the record again at once.
 */

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Mascot } from "@/commons/components/brand/Mascot";
import { api } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { ApprovalCard } from "@/commons/components/approvals/ApprovalCard";
import { ReadOnlyNote } from "@/commons/components/people/ReadOnlyNote";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";
import { useConversation } from "@/commons/hooks/use-conversation";
import { usePageSubject } from "@/commons/hooks/use-page-subject";
import { readsOnly } from "@/commons/lib/by-person";
import { canWrite, useMe } from "@/commons/lib/session";
import { Meters } from "./components/Meters";
import { MissionActions } from "./components/MissionActions";
import { MissionResult } from "./components/MissionResult";
import { BriefCard } from "./components/BriefCard";
import { DoneWhenCard } from "./components/DoneWhenCard";
import { MissionWork } from "./components/MissionWork";
import { NowLine } from "./components/NowLine";
import { AnswerBox } from "./components/Questions";
import { SeenBadge } from "./components/SeenBadge";
import { WhenLine } from "./components/WhenLine";
import { useMissionAct } from "./hooks/use-mission-act";
import { useMissionDelete } from "./hooks/use-mission-delete";
import { Goal } from "./components/Goal";
import { DraftForm } from "./components/DraftForm";
import { briefShown, meters, needsYouSaid, shortId } from "./lib/mission";
import { missionName } from "@/commons/lib/mission-name";
import { asksWhileWorking, openQuestion } from "@/commons/lib/mission-waits";
import { DetailLoading } from "@/commons/components/ui/Skeleton";

const OPEN_MS = 5_000;
const SETTLED_MS = 60_000;

const noSession = () => {};

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
  // What this page is about, for an agent asked from the chat that floats over it.
  usePageSubject(detail ? missionName(detail.mission) : undefined);
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

  if (found.isLoading) return <DetailLoading cards={3} />;
  if (!detail) {
    if (found.error instanceof ApiError && found.error.status === 404) {
      return (
        <Card>
          <EmptyState pose="lost" title="No such mission" description={`There is no mission called ${missionId} here.`} action={<Link to="/missions" className="btn btn-sm btn-ghost">All missions</Link>} />
        </Card>
      );
    }
    return <ErrorNote error={found.error} />;
  }

  const { mission, plan, parked } = detail;
  // One the reader only reads, since it reports to a chat of theirs: nothing on the page changes it or answers it.
  const only = readsOnly(mission);
  const writable = canWrite(me.data ?? null) && !only;
  const live = conversation.liveTurns[0];
  const waitingOn = mission.status === "waiting" ? mission.waitKind : null;
  const draft = waitingOn === "accept" && mission.startedAt === null;
  // It asked and went on working: the question and the box to answer it are here though nothing is held up.
  const asking = asksWhileWorking(mission) ? openQuestion(mission) : null;

  return (
    <div className="space-y-5">
      <Link to="/missions" className="btn btn-ghost btn-xs -ml-2 gap-1.5 rounded-lg text-base-content/70">
        <ArrowLeft size={13} aria-hidden="true" /> Missions
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <SeenBadge mission={mission} />
          <span className="font-mono text-[11px] text-base-content/65">
            {mission.agentId} · {shortId(mission.id)}
            {mission.byAgent ? ` · by ${mission.byAgent}` : ""}
            {mission.jobId ? ` · a run of job ${detail.jobName ?? mission.jobId}` : ""}
          </span>
          {/* When, as its card on the board says it, the day and the minute a hover away: a draft never "started". */}
          <WhenLine mission={mission} side="under" />
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <h1 className="min-w-0 text-lg font-semibold leading-snug tracking-tight text-base-content [overflow-wrap:anywhere] sm:text-xl">{missionName(mission)}</h1>
          <MissionActions
            mission={mission}
            writable={writable}
            pending={act.isPending || remove.isPending}
            onAct={(verb) => act.mutate({ verb })}
            onDelete={(force) => remove.mutateAsync(force)}
          />
        </div>
        {/* What it is to do, under what it is called; said once where the two are the same words. */}
        {mission.goal.replace(/\s+/g, " ").trim() !== missionName(mission) && <Goal goal={mission.goal} />}
        {only && <ReadOnlyNote thing={mission} />}
      </header>

      {/* Not over a draft: it waits to be started, which its own card says, and asks nothing of anybody. */}
      {(mission.seen === "needs_you" || asking) && !only && !draft && (
        <div role="status" className="alert alert-soft alert-warning grid-cols-[auto_minmax(0,1fr)] items-start rounded-2xl">
          <Mascot pose="waiting" decorative className="w-12 sm:w-14" />
          <div className="w-full min-w-0 space-y-3">
            <p className="text-sm leading-relaxed text-base-content">
              <span className="mr-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-warning">Needs you</span>
              {asking ? "It asked a question and works on meanwhile. Your answer reaches it while it works." : waitingOn === "input" ? "It asked a question and waits for your answer." : needsYouSaid(mission)}
            </p>
            {(waitingOn === "input" || asking) && (
              <>
                <p className="whitespace-pre-line rounded-xl bg-base-100/80 px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]">{asking ? asking.question : mission.reason}</p>
                <AnswerBox disabled={!writable} pending={act.isPending} onAnswer={(text) => act.mutate({ verb: "answer", text })} />
              </>
            )}
          </div>
        </div>
      )}

      {/* What it does this moment and how far it is, straight under its name: both were below the brief, a scroll away. */}
      {mission.seen === "working" && <NowLine mission={mission} live={live?.status === "running" ? live : undefined} jobs={conversation.jobs} {...(detail.reviewing ? { reviewing: detail.reviewing } : {})} />}
      {!draft && <Meters meters={meters(mission, plan, detail.steps)} />}

      {/* A draft (0.8.11): nothing has run; what it will do, how it is judged and its brief are changed here before it starts. */}
      {draft && (
        <Card title="Draft" description="Nothing has run. Change it here, then start it, or delete it.">
          <DraftForm key={mission.updatedAt} mission={mission} brief={detail.brief ?? null} ownFolder={mission.workdir.endsWith(`/missions/${mission.id}`)} writable={writable} />
        </Card>
      )}

      {/* Its brief and what decides it is done, side by side at the top, each folded to its header: ten checks open beside
          a folded brief left a hole under the brief and pushed the result down the page. A draft's form holds its own. */}
      {draft ? (
        detail.brief && <BriefCard brief={detail.brief} shown={briefShown(detail.briefPath, mission.id)} />
      ) : (
        <div className={detail.brief ? "grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]" : ""} data-brief-and-done>
          {detail.brief && <BriefCard brief={detail.brief} shown={briefShown(detail.briefPath, mission.id)} />}
          <DoneWhenCard mission={mission} />
        </div>
      )}

      {/* Parked while it works on what does not depend on them — a mission waits only once nothing else moves. */}
      {parked.length > 0 && !only && (
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

      {(mission.report || mission.files.length > 0) && (
        <Card
          title="Result"
          description={mission.seen === "done" ? "What it handed back." : "What it handed back so far."}
          {...(mission.seen === "done" ? { actions: <Mascot pose="trophy" decorative className="-my-3 w-16" /> } : {})}
        >
          <MissionResult report={mission.report} files={mission.files} workdir={mission.workdir} />
        </Card>
      )}

      {/* Nothing of a draft has run: no checklist, no turns, nothing to tell. All of it shows once it starts. */}
      {!draft && <MissionWork mission={mission} plan={plan} turns={conversation.turns} live={live} writable={writable} pending={act.isPending} onTell={(text, done) => act.mutate({ verb: "tell", text }, { onSuccess: done })} />}
    </div>
  );
}
