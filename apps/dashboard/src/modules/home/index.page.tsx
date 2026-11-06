/**
 * What this daemon is doing right now.
 * Apple-inspired Overview dashboard with frosted glass cards, rich metrics,
 * quick actions, and clear status indicators.
 */

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  Clock,
  Coins,
  Loader2,
  Radio,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type HealthPayload } from "@/commons/lib/api";
import { orchestratorFirst } from "@/commons/lib/agents";
import { PendingAlerts } from "@/modules/home/PendingAlerts";
import { SetupNotes } from "@/modules/home/SetupNotes";
import { Card, EmptyState, PageHeader } from "@/commons/components/ui/ui";
import { CollapsibleCard } from "@/commons/components/ui/CollapsibleCard";
import { Details } from "@/commons/components/ui/Details";
import { ApprovalCard } from "@/commons/components/ui/ApprovalCard";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";
import { UpdateBadge } from "./UpdateBadge";
import { UsageRoutes } from "./UsageRoutes";
import { OfficeTeaser } from "./OfficeTeaser";
import { RestartButton } from "@/commons/components/ui/RestartButton";
import { editionLabel } from "@/commons/hooks/use-update";
import { healthWarnings } from "@/modules/home/health-warnings";

function uptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** 1,234,567 → "1.2M", 45,210 → "45.2K". */
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Today's spend and token telemetry. */
function UsageCard() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.usage(1), retry: false });
  const total = usage.data?.total;
  // Derived here rather than inline so the guard and the percentage cannot disagree about which
  // numbers they are talking about.
  const cacheActivity = (total?.cachedInputTokens ?? 0) + (total?.cacheCreationInputTokens ?? 0);
  const cachedShare =
    total && total.inputTokens > 0
      ? Math.round((total.cachedInputTokens / total.inputTokens) * 100)
      : 0;

  // Collapsed by default, at the top: today's token volume is the line worth a glance; the breakdown is not.
  return (
    <CollapsibleCard
      title="AI usage and spend"
      description="What your agents' AI use cost today, counted in tokens: the pieces of text a model reads and writes." // plain-words-ok: tokens, the unit a model's use is counted and billed in
      {...(total && total.requests > 0
        ? {
            // Tokens rather than dollars at a glance: the price depends on the model, the volume does not.
            summary: (
              <span className="font-mono text-xs text-base-content/70 sm:text-sm">
                <span className="font-semibold text-base-content">{COMPACT.format(total.inputTokens)}</span> in ·{" "}
                <span className="font-semibold text-base-content">{COMPACT.format(total.outputTokens)}</span> out ·{" "}
                <span className="font-semibold text-base-content">{cachedShare}%</span> cached
              </span>
            ),
          }
        : {})}
    >
      {!total || total.requests === 0 ? (
        <EmptyState icon={Coins} title="No model calls today" description="It shows here as soon as an agent answers." />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-extrabold tracking-tight text-base-content sm:text-4xl">
              ${total.usd.toFixed(4)}
            </span>
            <span className="text-base-content/65 text-sm font-medium px-2.5 py-0.5 rounded-full bg-base-200 border border-base-content/10">
              {total.requests} {total.requests === 1 ? "call" : "calls"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Tokens read</p> {/* plain-words-ok: tokens, the unit a model's use is counted and billed in */}
              <p className="text-base font-bold font-mono text-base-content mt-0.5">{total.inputTokens.toLocaleString()}</p>
            </div>
            <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Tokens written</p> {/* plain-words-ok: tokens, the unit a model's use is counted and billed in */}
              <p className="text-base font-bold font-mono text-base-content mt-0.5">{total.outputTokens.toLocaleString()}</p>
            </div>
          </div>

          {/*
            * Cache activity, shown only when a provider reported some.
            *
            * `since()` sums with COALESCE, so a NULL — the provider said nothing — arrives here as 0
            * and is indistinguishable from "no hits". Absence of this line therefore means *nothing
            * was reported*, not that caching is off. Rendering a hard 0% would state the stronger of
            * the two, and the weaker one is the true one.
            */}
          {cacheActivity > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:max-w-md">
              <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Cache Reads</p>
                <p className="text-base font-bold font-mono text-base-content mt-0.5">
                  {total.cachedInputTokens.toLocaleString()}
                  <span className="text-base-content/65 text-xs font-medium ml-1.5">{cachedShare}% of input</span>
                </p>
              </div>
              <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06]">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">Cache Writes</p>
                <p className="text-base font-bold font-mono text-base-content mt-0.5">
                  {total.cacheCreationInputTokens.toLocaleString()}
                </p>
              </div>
            </div>
          )}

          {/*
            * The one reading of these two numbers that is actionable.
            *
            * A write costs 25% *more* than an uncached token, so a breakpoint sitting after content
            * that changes every request writes a fresh entry each time and reads none of them back —
            * strictly worse than not caching. From the read count alone that is indistinguishable
            * from a cold start; it is the ratio that gives it away.
            */}
          {total.cacheCreationInputTokens > total.cachedInputTokens && (
            <div role="alert" className="alert alert-warning text-xs bg-warning/10 text-warning border border-warning/20 rounded-xl p-3">
              <AlertTriangle size={14} className="shrink-0" />
              <div className="space-y-1">
                <p>More was saved to the provider's cache than read back from it, and each save costs 25% more than not saving at all.</p>
                <Details>
                  <p>A cache breakpoint may sit after content that changes on every request. The cache boundary is described in docs/SPEC.md §6.3.</p>
                </Details>
              </div>
            </div>
          )}

          {total.unpricedRequests > 0 && (
            <div role="alert" className="alert alert-warning text-xs bg-warning/10 text-warning border border-warning/20 rounded-xl p-3">
              <AlertTriangle size={14} className="shrink-0" />
              <span>
                {total.unpricedRequests} calls have no known price, so the provider's bill may be higher than this total.
              </span>
            </div>
          )}

          <UsageRoutes days={usage.data?.routeDays ?? 7} routes={usage.data?.routes ?? []} warnings={usage.data?.cacheWarnings ?? []} />
        </div>
      )}
    </CollapsibleCard>
  );
}

/**
 * Tool calls an agent is blocked on.
 */
function ApprovalsCard() {
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: api.approvals,
    refetchInterval: 5_000,
    retry: false,
  });
  // Its outcome is a toast (the hook says why): an error inside this card went with the card on the next poll.
  const answer = useAnswerApproval();

  const pending = approvals.data?.pending ?? [];
  if (pending.length === 0) return null;

  return (
    <Card
      title={`Waiting on Approval (${pending.length})`}
      description="An agent is waiting for your answer before it goes on."
      className="border-warning/40 bg-warning/5"
    >
      <div className="space-y-3">
        {pending.map((request) => (
          <ApprovalCard
            key={request.id}
            request={request}
            pending={answer.isPending}
            onAnswer={(request, decision) => answer.mutate({ request, decision })}
          />
        ))}
      </div>
    </Card>
  );
}

export default function HomePage() {
  const health = useQuery<HealthPayload>({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 10_000,
  });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 10_000 });
  const cron = useQuery({ queryKey: ["cron", "all"], queryFn: () => api.cron(true), retry: false });

  if (health.isPending) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <Loader2 className="animate-spin text-primary" size={28} />
        <span className="text-sm font-medium text-base-content/65">Connecting to Nouride…</span>
      </div>
    );
  }

  if (health.error || !health.data) {
    return (
      <div className="alert alert-error bg-error/10 border border-error/30 text-error rounded-2xl p-4 shadow-sm flex items-start gap-3">
        <AlertTriangle size={20} className="shrink-0 mt-0.5" />
        <div>
          <h3 className="font-bold text-sm">Nouride is not answering</h3>
          <p className="text-xs opacity-90 mt-0.5">Whoever runs this server can check that Nouride is running.</p>
        </div>
      </div>
    );
  }

  const data = health.data;
  // The daemon's issues and each pack that did not load — `/health` stays "ok" over those, so they are said here.
  const warnings = healthWarnings(data);
  const agents = orchestratorFirst(status.data?.agents ?? [], status.data?.orchestrator);
  const gateways = Object.entries(data.gateways);
  const jobs = cron.data?.jobs ?? [];
  const nextJob = jobs
    .filter((job) => job.enabled && job.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];

  return (
    <div className="space-y-6">
      {/* "Operational" only when it is: the badge beside it says starting or degraded, and the line said otherwise. */}
      <PageHeader
        title="Overview"
        description={`Version ${data.version}${
          data.edition && data.edition !== "unknown" ? ` (${editionLabel(data.edition)})` : ""
        } · Up for ${uptime(data.uptime)}${data.status === "ok" ? " · Everything is working" : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <RestartButton />
          <UpdateBadge />
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-base-100 border border-base-content/10 shadow-xs">
            {data.status === "ok" ? (
              <span className="status status-success halo size-2 rounded-full" />
            ) : (
              <span className="status status-warning halo size-2 rounded-full animate-pulse" />
            )}
            <span className="text-xs font-semibold text-base-content capitalize">
              {data.status === "ok" ? "System Healthy" : data.status === "starting" && data.phase ? `Starting: ${data.phase}` : data.status}
            </span>
          </div>
          </div>
        }
      />

      <UsageCard />

      <ApprovalsCard />

      {warnings.length > 0 && (
        <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-2xl p-4 shadow-xs">
          <AlertTriangle size={18} className="shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold text-xs uppercase tracking-wider font-mono">System Warnings</p>
            <ul className="list-inside list-disc text-xs space-y-0.5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Modern Apple HIG Stat Grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Active Agents"
          value={agents.filter((a) => a.state === "running").length}
          suffix={`of ${agents.length} set up`}
          icon={Bot}
          tone="primary"
        />
        <Stat
          label="Live Connections"
          value={gateways.filter(([, state]) => state === "connected").length}
          suffix={`of ${gateways.length} connections`}
          icon={Radio}
          tone="accent"
        />
        <Stat
          label="Scheduled Tasks"
          value={jobs.filter((job) => job.enabled).length}
          suffix={`of ${jobs.length} total`}
          icon={Clock}
          tone="info"
        />
        <Stat
          label="Next Run"
          value={nextJob?.nextRunAt ? new Date(nextJob.nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
          suffix={nextJob?.name ?? "Nothing scheduled"}
          icon={Sparkles}
          tone="secondary"
        />
      </div>

      {/* Above the two-column fold: these are the only things on this page that are waiting on a
          person, and both expire or stall. They say how many and where; the deciding happens on the
          page that shows the whole request. Renders nothing when nothing is waiting. */}
      <PendingAlerts />

      {/* Where the Agents and Gateways lists were (the owner, 2026-11-03): the Agents and Connections stats above
          count them, and the Office shows who is doing what. */}
      <OfficeTeaser agents={status.data?.agents ?? []} orchestrator={status.data?.orchestrator ?? null} />

      {/* Below the fold, folded away: things to fix when there is time. Renders nothing when there are none. */}
      <SetupNotes />
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: string | number;
  suffix?: string;
  icon: LucideIcon;
  tone?: "primary" | "secondary" | "accent" | "info";
}) {
  const toneClasses = {
    primary: "text-primary bg-primary/10 border-primary/20",
    secondary: "text-secondary bg-secondary/10 border-secondary/20",
    accent: "text-accent bg-accent/10 border-accent/20",
    info: "text-info bg-info/10 border-info/20",
  };

  return (
    <div className="rounded-2xl border border-base-content/[0.08] bg-base-100/80 backdrop-blur-xl p-4 sm:p-5 shadow-xs transition-all duration-200 hover:shadow-md hover:border-base-content/15">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold tracking-wider uppercase text-base-content/65 truncate font-mono">{label}</span>
        <div className={`p-2 rounded-xl border ${toneClasses[tone]} shrink-0`}>
          <Icon size={16} />
        </div>
      </div>
      <div className="mt-2">
        <p className="text-2xl sm:text-3xl font-extrabold tracking-tight text-base-content truncate">{value}</p>
        {suffix && <p className="text-base-content/65 text-xs truncate mt-0.5 font-medium">{suffix}</p>}
      </div>
    </div>
  );
}
