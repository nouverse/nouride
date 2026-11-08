/**
 * Webhooks — jobs that fire when something calls them.
 *
 * The same rows the Schedule page lists, filtered the other way and shown for a different question.
 * A scheduled job is read for "when does this next run"; a webhook is read for "what do I paste into
 * GitHub", and after that for "did it actually fire". So the URL is the largest thing on each card
 * and the recent deliveries sit right under it.
 *
 * Enable, disable, run, delete and history all go through the `cron*` endpoints, because that is
 * what these are. Only the listing and the token belong to this page.
 */

import { CallExample } from "./components/CallExample.tsx";
import { Reach } from "./components/Reach.tsx";
import { RunResult } from "@/commons/components/jobs/RunResult";
import { Allowed, HeldActions } from "@/commons/components/jobs/Allowances";
import { ProposalBar } from "@/commons/components/jobs/ProposalBar";
import { WebhookForm } from "./components/WebhookForm.tsx";
import { useKnownChats } from "@/commons/hooks/use-known-chats";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { api } from "@/commons/lib/api";
import type { WebhookSummary } from "@nouride/wire";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { copyText } from "@/commons/lib/clipboard";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { runOutcomeToast } from "@/commons/lib/run-outcome";
import { FILL_PAGE, ScrollArea } from "@/commons/components/ui/ScrollCard";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";

type Filter = "all" | "active" | "paused" | "failing";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "failing", label: "Failing" },
];

export default function WebhooksPage() {
  const me = useMe();
  const hooks = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks });
  // The agent list rides along with /status, the same place the Agents page reads it from.
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const admin = isAdmin(me.data ?? null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });
  const webhooks = hooks.data?.webhooks ?? [];
  // Filtered by state, as Schedule's jobs are — these are the same rows.
  const [filter, setFilter] = useState<Filter>("all");
  const counts: Record<Filter, number> = {
    all: webhooks.length,
    active: webhooks.filter((hook) => hook.enabled).length,
    paused: webhooks.filter((hook) => !hook.enabled).length,
    failing: webhooks.filter((hook) => hook.failStreak > 0).length,
  };
  const shown = webhooks.filter((hook) => (filter === "active" ? hook.enabled : filter === "paused" ? !hook.enabled : filter === "failing" ? hook.failStreak > 0 : true));

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        title="Webhooks"
        description="Addresses that start an agent's work when something calls them: a failed test run, a new issue, an alert, anything that can call a web address."
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
            disabled={!admin}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} /> New Webhook
          </button>
        }
      />

      <ErrorNote error={hooks.error} />

      {adding && (
        <WebhookForm
          agents={(status.data?.agents ?? []).map((agent) => agent.id)}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}

      <SegmentedTabs
        tabs={FILTERS.map((entry) => ({ value: entry.id, label: entry.label, after: <Count n={counts[entry.id]} highlight={entry.id === "failing" && counts.failing > 0} /> }))}
        value={filter}
        onChange={setFilter}
      />

      {webhooks.length === 0 && !adding ? (
        <EmptyState
          pose="sleeping"
          title="No webhooks yet"
          description="A webhook gives one agent job a URL. Whatever calls that URL starts the job, and the request body is handed to the agent."
        />
      ) : shown.length === 0 ? (
        <EmptyState pose="sleeping" title={`No ${filter} webhooks`} />
      ) : (
        // Its own scroll, so the filters stay put over a long list. Keyed by the filter, to fade in anew (`FILL_PAGE`).
        <ScrollArea key={filter} fill className="space-y-4 pr-1">
          {shown.map((hook) => (
            <WebhookCard key={hook.id} hook={hook} onChanged={refresh} canEdit={canWrite(me.data ?? null)} admin={admin} />
          ))}
        </ScrollArea>
      )}
    </div>
  );
}

/** Where a hook's reply goes: its connection, and the chat as words where the daemon can name it ("DM · Gading"). */
function replyTo(gatewayId: string, chatId: string, labelOf: (gatewayId: string, chatId: string) => string | undefined): string {
  const named = labelOf(gatewayId, chatId);
  return `${gatewayId} · ${named ? `${named} (${chatId})` : chatId}`;
}

function WebhookCard({
  hook,
  onChanged,
  canEdit,
  admin,
}: {
  hook: WebhookSummary;
  onChanged: () => void;
  canEdit: boolean;
  /** A proposed webhook is an admin's to turn on, as making one is. */
  admin: boolean;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const { labelOf } = useKnownChats();

  const toggle = useMutation({
    mutationFn: () => api.cronAction(hook.id, hook.enabled ? "disable" : "enable"),
    onSuccess: onChanged,
  });
  const toast = useToast();
  // What the test fire did, said — and one still going is followed in its deliveries rather than read as a failure.
  const fire = useMutation({
    mutationFn: () => api.cronRun(hook.id),
    onSuccess: ({ outcome }) => {
      toast.show(runOutcomeToast(hook.name, outcome));
      if (outcome.status === "running") setShowRuns(true);
      onChanged();
    },
  });
  const rotate = useMutation({ mutationFn: () => api.webhookRotate(hook.id), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => api.cronDelete(hook.id), onSuccess: onChanged });

  const failing = hook.failStreak > 0;
  const { ask, dialog } = useConfirm();

  return (
    <Card
      title={hook.name}
      description={`${hook.agentId} · ${hook.runCount} deliveries${failing ? ` · ${hook.failStreak} failing` : ""}`}
      actions={
        hook.proposal ? (
          <ProposalBar job={hook} canAnswer={admin} onAnswered={onChanged} />
        ) : <div className="flex items-center gap-1.5">
          {!hook.enabled && (
            <span className="badge badge-ghost badge-sm font-medium font-mono">Paused</span>
          )}
          {failing && (
            <span className="badge badge-error badge-sm gap-1 font-medium font-mono">
              <AlertTriangle size={12} /> Failing
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg gap-1 font-medium hover:bg-base-200"
            disabled={!canEdit || fire.isPending || !hook.enabled}
            title="Run the job now, without a body. Counted as a run by hand, not a delivery"
            onClick={() => fire.mutate()}
          >
            <Zap size={14} /> Run now
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg gap-1 font-medium hover:bg-base-200"
            disabled={!canEdit || toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {hook.enabled ? <Pause size={14} /> : <Play size={14} />}
            {hook.enabled ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
            disabled={!canEdit}
            aria-label="Delete webhook"
            onClick={async () => {
              const yes = await ask({
                title: `Delete "${hook.name}"?`,
                body: "Its URL stops working, and its delivery history goes with it. Pause it instead to keep both.",
                confirmLabel: "Delete",
              });
              if (yes) remove.mutate();
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* A proposal has no address to hand out until somebody turns it on. */}
        {!hook.proposal && <><UrlBar
          url={hook.urlGuessed ? `${window.location.origin}${hook.path}` : hook.url}
          kind={hook.payload.kind}
          canEdit={canEdit}
          rotating={rotate.isPending}
          onRotate={async () => {
            const yes = await ask({
              title: "Give this webhook a new address?",
              body: "The current address stops working at once. Anything already using it is turned away until you paste the new one in.",
              confirmLabel: "New address",
            });
            if (yes) rotate.mutate();
          }}
        />

        <Reach hook={hook} canTest={canEdit} onTested={onChanged} /></>}

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
          <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
            <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
              What it does
            </dt>
            <dd className="text-base-content break-words">{payloadLine(hook)}</dd>
          </div>
          <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
            <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
              Where the reply goes
            </dt>
            <dd className="text-base-content break-words">
              {hook.delivery.mode === "none"
                ? "nowhere: the run is recorded and nothing is sent"
                : hook.delivery.mode === "webhook"
                  ? "posted to an outbound URL"
                  : replyTo(hook.delivery.gatewayId ?? hook.target.gatewayId, hook.delivery.chatId ?? hook.target.chatId, labelOf)}
            </dd>
          </div>
        </dl>

        <ErrorNote error={rotate.error ?? fire.error ?? toggle.error ?? remove.error} />
        <Allowed job={hook} canEdit={admin} />

        <button
          type="button"
          className="btn btn-ghost btn-xs rounded-lg gap-1 font-medium"
          onClick={() => setShowRuns((v) => !v)}
        >
          {showRuns ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          Recent deliveries
        </button>
        {showRuns && <Deliveries id={hook.id} admin={admin} />}
      </div>
      {dialog}
    </Card>
  );
}

/**
 * The address, and the two things anyone does with it.
 *
 * The public address when one is set (`[dashboard] public_url`): it is what a service outside is handed, and what Send
 * a test goes through. Without one, the browser's own origin — the daemon knows only what it bound to, which behind a
 * reverse proxy is `0.0.0.0:18254` and not the host anybody can reach, while the browser is already talking to a name
 * that reaches it.
 */
function UrlBar({
  url,
  kind,
  canEdit,
  rotating,
  onRotate,
}: {
  url: string;
  /** Passed down only so the call example can describe what *this* mode does with a body. */
  kind: WebhookSummary["payload"]["kind"];
  canEdit: boolean;
  rotating: boolean;
  onRotate: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-1.5">
      {/* The address the whole width on a phone, its buttons under it; beside them it was a column of a dozen characters. */}
      <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
        <code className="flex-1 min-w-0 max-sm:basis-full rounded-xl bg-base-200/60 border border-base-content/[0.08] px-3 py-2.5 font-mono text-xs break-all leading-relaxed">
          {url}
        </code>
        <button
          type="button"
          className="btn btn-sm rounded-xl gap-1.5 shrink-0"
          onClick={() => {
            void copyText(url).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 2_000);
            });
          }}
        >
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm rounded-xl gap-1.5 shrink-0"
          disabled={!canEdit || rotating}
          title="Make a new address. The current one stops working"
          aria-label="Make a new address"
          onClick={onRotate}
        >
          <RefreshCw size={14} className={rotating ? "animate-spin" : ""} />
        </button>
      </div>
      <p className="text-base-content/65 text-xs leading-normal">
        Anyone with this URL can fire it, so treat it like a password, and rotate it if it leaks.
      </p>
      <CallExample url={url} kind={kind} />
    </div>
  );
}

/** A hook's calls, newest first — and what its guards held in each, allowed always by an admin, as making a hook is. */
function Deliveries({ id, admin }: { id: string; admin: boolean }) {
  const detail = useQuery({
    queryKey: ["cron", id],
    queryFn: () => api.cronJob(id),
    // A delivery still going is asked about until it ends.
    refetchInterval: (query) => (query.state.data?.runs.some((run) => run.status === "running") ? 2_000 : false),
  });
  const runs = detail.data?.runs ?? [];

  if (detail.isPending) return <span className="loading loading-spinner loading-xs" />;
  if (runs.length === 0) {
    return <p className="text-base-content/65 text-xs">Nothing has called this yet.</p>;
  }

  return (
    <ul className="space-y-1.5">
      {runs.map((run) => (
        <li
          key={run.id}
          className="flex items-start gap-2.5 rounded-xl bg-base-200/40 px-3 py-2 text-xs"
        >
          <span
            className={`badge badge-xs mt-0.5 shrink-0 ${
              run.status === "success" ? "badge-success" : run.status === "error" ? "badge-error" : "badge-ghost"
            }`}
          />
          <span className="text-base-content/65 shrink-0 font-mono">
            {new Date(run.startedAt).toLocaleString("sv-SE")}
          </span>
          <span className="text-base-content/80 break-words min-w-0">
            <RunResult text={run.result ?? run.status} />
            {run.held?.length ? <HeldActions jobId={id} held={run.held} canEdit={admin} /> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function payloadLine(hook: WebhookSummary): string {
  if (hook.payload.kind === "agentTurn") return String(hook.payload.message ?? "");
  if (hook.payload.kind === "mission") return `Mission: ${String(hook.payload.goal ?? "")}`;
  if (hook.payload.kind === "systemEvent") return String(hook.payload.text ?? "");
  const argv = Array.isArray(hook.payload.argv) ? hook.payload.argv.join(" ") : "";
  return `${argv}${hook.payload.then === "agentTurn" ? " → agent reads output" : ""}`;
}
