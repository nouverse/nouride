/**
 * Updating the daemon, as three decisions rather than one button.
 *
 * ## The shape of the page
 *
 * **Check** is free and happens on arrival — nobody should have to press anything to learn
 * whether the thing they rely on is current. **Download** costs bandwidth and disk, can be
 * paused, and touches nothing that is running. **Install** costs the daemon: it swaps the
 * binary and restarts, and it is the only step that cannot be taken back.
 *
 * They are three steps because they have three different consequences, and a single "update
 * now" would be asking one question about all of them. Each of the two that act asks first, and
 * each confirmation says what that particular step will do — not what the whole flow will do.
 *
 * ## What it refuses to offer
 *
 * Most installs cannot update themselves: a container's image is replaced from outside, a
 * Pro edition's tarballs are not on the public channel, an unsupervised daemon would be
 * stopped rather than restarted. The daemon works out which and sends back the command that
 * does work, and this page prints it rather than making somebody go and find it.
 *
 * And a version that exists for another edition is not an update *here*. The daemon resolves
 * the newest release that actually carries a build for this one, so a community install is
 * never offered a cloud-only release — it is told that one exists and that there is no build of
 * it for them, which is a different sentence and the honest one.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpCircle,
  CheckCircle2,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/commons/lib/api";
import type { UpdateStatus } from "@nouride/wire";
import { Card, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { useConfirm } from "@/commons/components/ui/confirm";
import { InstallCard } from "./InstallCard";
import { FloorCard } from "./FloorCard";
import { TrackCard } from "./TrackCard";
import { RestartingCard } from "./RestartingCard";
import { UPDATE_QUERY_KEY, useUpdate } from "@/commons/hooks/use-update";
import { formatBytes } from "@/commons/lib/format";
import { UPDATE_PROGRESS_KEY, useDownloadProgress, useInstall } from "./useUpdate";

export default function UpdatePage() {
  const status = useUpdate();
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();

  /**
   * The transfer's own counter, which polls itself while bytes are arriving.
   *
   * Falls back to whatever the check last reported, so arriving on the page shows a bar at once
   * rather than a blank one for the length of the first request.
   */
  const live = useDownloadProgress();
  const download = live.data?.download ?? status.data?.download;

  const refreshProgress = () => queryClient.invalidateQueries({ queryKey: UPDATE_PROGRESS_KEY });

  /**
   * Check again reaches past the daemon's channel cache; nothing else does.
   *
   * Written as a mutation rather than a refetch so the button can spin on its own without the
   * background poll — which shares this query key — showing a spinner every second.
   */
  const recheck = useMutation({
    mutationFn: () => api.updateStatus(true),
    onSuccess: (fresh) => queryClient.setQueryData(UPDATE_QUERY_KEY, fresh),
  });

  const start = useMutation({ mutationFn: api.startDownload, onSuccess: refreshProgress });
  const pause = useMutation({ mutationFn: api.pauseDownload, onSuccess: refreshProgress });
  const discard = useMutation({ mutationFn: api.discardDownload, onSuccess: refreshProgress });
  const install = useInstall();

  if (status.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Update" description="Checking for updates…" />
        <Card title="" description="">
          <Loader2 size={18} className="animate-spin opacity-60" />
        </Card>
      </div>
    );
  }

  const data = status.data;
  // `install` as well as `data`: an error body carries neither, and every panel below reads it.
  if (!data?.install) {
    return (
      <div className="space-y-6">
        <PageHeader title="Update" description="Could not reach Nouride." />
        <ErrorNote error={status.error} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Update"
        description="Which version of Nouride runs here, and whether a newer one is out."
        actions={
          <button
            type="button"
            className="btn btn-sm btn-ghost gap-2"
            disabled={recheck.isPending}
            onClick={() => recheck.mutate()}
          >
            <RefreshCw size={14} className={recheck.isPending ? "animate-spin" : undefined} />
            Check again
          </button>
        }
      />

      <InstallCard data={data} />
      {data.check && <FloorCard check={data.check} />}
      {data.check && <TrackCard check={data.check} />}

      {!data.supported && (
        <Card title="This version cannot check for updates" description="It was built without a way to ask.">
          <p className="text-xs opacity-70">Nothing is wrong with it. Whoever runs this server updates it the way it was installed.</p>
          <Details className="mt-2">
            <p>It was compiled without the update provider. Replace it with a build that carries the provider, or update it the way it was installed.</p>
          </Details>
        </Card>
      )}

      {data.error && (
        <Card
          title="Could not check for updates"
          description="The version above is what runs here; whether a newer one is out is not known."
          className="border-warning/40 bg-warning/5"
        >
          <p className="text-xs text-base-content/65">
            A server whose network does not let it reach the internet says this every time. Nothing failed to update.
          </p>
          <Details className="mt-2">
            <p>{data.error}</p>
          </Details>
        </Card>
      )}

      {/*
        * Hidden once Install has been pressed.
        *
        * The status underneath is the last thing the daemon said before it went, so the step
        * card would sit there offering "Install v0.3.2" next to a card saying it is installing
        * v0.3.2 — two answers to the same question, one of them a button.
        */}
      {!install.isSuccess && data.check?.newer && data.check.plan?.can && (
        <FlowCard
          data={data}
          download={download}
          busy={start.isPending || pause.isPending || install.isPending || discard.isPending}
          onDownload={async () => {
            const to = data.check!.latest;
            const ok = await ask({
              title: `Download ${to}?`,
              body: (
                <>
                  Downloads the update and checks that it is the real one. Nothing that is running is touched, and you
                  can pause it or throw it away afterwards.
                </>
              ),
              confirmLabel: "Download",
              danger: false,
            });
            if (ok) start.mutate();
          }}
          onResume={() => start.mutate()}
          onPause={() => pause.mutate()}
          onDiscard={async () => {
            const ok = await ask({
              title: "Discard this download?",
              body: "The partly-downloaded file is removed. Starting again begins from zero.",
              confirmLabel: "Discard",
            });
            if (ok) discard.mutate();
          }}
          onInstall={async () => {
            const to = data.check!.latest;
            const ok = await ask({
              title: `Install ${to} and restart?`,
              body: (
                <>
                  The new version is put in place and <strong>Nouride restarts</strong> once nothing is running: a reply, a
                  waiting message or an approval for up to ten minutes, a background job until it finishes. The chat, your
                  chat apps and this page are then away for a few seconds. The current version is kept, so there is a way
                  back.
                </>
              ),
              confirmLabel: "Install and restart",
            });
            if (ok) install.mutate();
          }}
        />
      )}

      {data.check?.newer && data.check.plan && !data.check.plan.can && <BlockedCard plan={data.check.plan} />}

      <ErrorNote error={start.error ?? pause.error ?? install.error ?? discard.error} />
      {install.isSuccess && (
        <RestartingCard note={install.data.plain ?? install.data.note} expected={install.data.to} before={install.data.before} />
      )}
      {dialog}
    </div>
  );
}

/** Download, then install. Two steps, each with its own button and its own confirmation. */
function FlowCard({
  data,
  download,
  busy,
  onDownload,
  onResume,
  onPause,
  onDiscard,
  onInstall,
}: {
  data: UpdateStatus;
  /** The live counter when one is running, or the last one the check reported. */
  download: UpdateStatus["download"] | undefined;
  busy: boolean;
  onDownload: () => void;
  onResume: () => void;
  onPause: () => void;
  onDiscard: () => void;
  onInstall: () => void;
}) {
  const check = data.check!;
  const dl = download ?? {
    status: "idle" as const,
    received: 0,
    total: null,
    tag: null,
    artifact: null,
    error: null,
  };
  const forThis = dl.tag === check.latest;
  const received = forThis ? dl.received : 0;
  const total = forThis ? dl.total : null;
  const percent = total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
  const ready = forThis && dl.status === "ready";
  const running = forThis && dl.status === "downloading";
  const paused = forThis && dl.status === "paused";

  return (
    <Card
      title={`${check.current} → ${check.latest}`}
      description="Downloading changes nothing that is running. Installing restarts Nouride."
      className="border-info/40 bg-info/5"
    >
      <ol className="space-y-5">
        <li>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                <span className="text-base-content/65 mr-1.5">1.</span>Download {check.plan?.artifact}
              </p>
              <p className="text-xs text-base-content/65 mt-0.5">
                {ready
                  ? "Downloaded and waiting to be installed."
                  : running
                    ? "Running. You can pause and pick it up later."
                    : paused
                      ? "Paused. Resuming continues where it stopped."
                      : "Downloaded, and checked that it is the real one."}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {ready ? (
                <span className="badge badge-sm badge-success gap-1 font-mono">
                  <CheckCircle2 size={11} /> Ready
                </span>
              ) : running ? (
                <button type="button" className="btn btn-sm btn-ghost gap-1.5" disabled={busy} onClick={onPause}>
                  <Pause size={13} /> Pause
                </button>
              ) : paused ? (
                <button type="button" className="btn btn-sm btn-primary gap-1.5" disabled={busy} onClick={onResume}>
                  <Play size={13} /> Resume
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-primary gap-1.5" disabled={busy} onClick={onDownload}>
                  <Download size={13} /> Download
                </button>
              )}
              {(running || paused || ready) && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost btn-square"
                  disabled={busy}
                  onClick={onDiscard}
                  aria-label="Discard the download"
                  title="Discard the download"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>

          {(running || paused || ready) && (
            <div className="mt-2">
              <progress
                className={`progress w-full ${ready ? "progress-success" : "progress-primary"}`}
                value={percent ?? undefined}
                max={100}
              />
              <p className="text-[11px] text-base-content/65 mt-1 tabular-nums">
                {formatBytes(received)}
                {total ? ` of ${formatBytes(total)}` : ""}
                {percent !== null ? ` · ${percent}%` : ""}
                {paused ? " · paused" : ""}
              </p>
            </div>
          )}
          {forThis && dl.status === "failed" && (
            <p className="text-xs text-error mt-2">
              <TriangleAlert size={12} className="inline mr-1 -mt-0.5" />
              {dl.error}
            </p>
          )}
        </li>

        <li>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className={`text-sm font-medium ${ready ? "" : "text-base-content/65"}`}>
                <span className="text-base-content/65 mr-1.5">2.</span>Install and restart
              </p>
              <p className="text-xs text-base-content/65 mt-0.5">
                {ready
                  ? "Puts the new version in place and restarts. The current version is kept, so there is a way back."
                  : "Available once the download has finished."}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-primary gap-1.5 shrink-0"
              disabled={!ready || busy}
              onClick={onInstall}
            >
              <ArrowUpCircle size={13} /> Install {check.latest}
            </button>
          </div>
        </li>
      </ol>
    </Card>
  );
}

/** A version exists and this install cannot take it. Say why, and what does work. */
function BlockedCard({ plan }: { plan: NonNullable<NonNullable<UpdateStatus["check"]>["plan"]> }) {
  return (
    <Card
      title={`${plan.to} cannot be installed from here`}
      description={plan.reason}
      className="border-warning/40 bg-warning/5"
    >
      {(plan.instead ?? []).length > 0 && (
        <>
          <p className="text-xs opacity-70 mb-2">Whoever runs this server can still update it another way.</p>
          <Details>
            <p>What does work:</p>
            <pre className="text-[11px] bg-base-200/60 rounded-lg p-3 overflow-x-auto">
              {(plan.instead ?? []).join("\n")}
            </pre>
          </Details>
        </>
      )}
      <p className="text-xs text-base-content/65 mt-3">
        Back to <Link to="/" className="link link-hover">Home</Link>.
      </p>
    </Card>
  );
}
