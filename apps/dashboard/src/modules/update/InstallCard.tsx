/**
 * The update page's first card: what this install is, and what the release channel has for it.
 */

import { ArrowUpCircle, CheckCircle2, Info } from "lucide-react";
import type { UpdateStatus } from "@/commons/lib/api";
import { Card } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { editionLabel } from "@/commons/hooks/use-update";

/** Version, edition, and what the channel has. The facts, before any of the buttons. */
export function InstallCard({ data }: { data: UpdateStatus }) {
  const check = data.check;
  const current = check?.current ?? data.install.version;

  return (
    <Card title="This Nouride" description="The version that runs here, and the newest one for it.">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-base-content/65 mb-1 font-mono">Running</p>
          <p className="text-2xl font-semibold tabular-nums">{current}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="badge badge-sm badge-ghost font-mono">{editionLabel(data.install.edition)}</span>
          </div>
          {/* Where it runs and how it is kept running: for whoever runs the server (0.8.19). */}
          <Details className="mt-3">
            <p className="font-mono">
              {data.install.platform}/{data.install.arch}
              {data.install.musl ? " musl" : ""}
            </p>
            <Row label="Install directory">
              <code className="text-[11px] opacity-70">{data.install.installDir}</code>
            </Row>
            <Row label="Supervisor">{data.install.supervisor}</Row>
          </Details>
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wider text-base-content/65 mb-1 font-mono">Newest for this edition</p>
          {check ? (
            <>
              <p className="text-2xl font-semibold tabular-nums">{check.latest}</p>
              <div className="mt-2">
                {check.newer ? (
                  <span className="badge badge-sm badge-info gap-1 font-mono">
                    <ArrowUpCircle size={11} /> Update available
                  </span>
                ) : check.floor ? (
                  // Not up to date: a newer release needs a version this one is below (FloorCard).
                  <span className="badge badge-sm badge-warning gap-1 font-mono">Needs {check.floor.needs} first</span>
                ) : check.notice ? (
                  // Not up to date either: newer releases came out after this licence's year of updates.
                  <span className="badge badge-sm badge-warning gap-1 font-mono">Newest for this licence</span>
                ) : (
                  <span className="badge badge-sm badge-success gap-1 font-mono">
                    <CheckCircle2 size={11} /> Up to date
                  </span>
                )}
              </div>
              <div className="mt-3">
                {check.publishedAt && <Row label="Published">{new Date(check.publishedAt).toLocaleDateString()}</Row>}
                {check.notesUrl && (
                  <Row label="Notes">
                    <a href={check.notesUrl} target="_blank" rel="noreferrer" className="link link-hover">
                      Release notes
                    </a>
                  </Row>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-base-content/65">Unknown</p>
          )}
        </div>
      </div>

      {check?.notice && (
        <div className="mt-5 rounded-xl border border-base-content/10 bg-base-200/40 p-3">
          <p className="text-xs opacity-80">
            <Info size={13} className="inline mr-1 -mt-0.5" />
            {check.notice.charAt(0).toUpperCase() + check.notice.slice(1)}.
          </p>
        </div>
      )}

      {check?.stale && (
        <div className="mt-5 rounded-xl border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs opacity-80">
            <Info size={13} className="inline mr-1 -mt-0.5" />
            Nouride could not check for updates just now, so this is the last answer it had:{" "}
            {check.stale}.
          </p>
        </div>
      )}

      {check?.latestElsewhere && check.floor?.release !== check.latestElsewhere && (
        <div className="mt-5 rounded-xl border border-base-content/10 bg-base-200/40 p-3">
          <p className="text-xs opacity-80">
            <Info size={13} className="inline mr-1 -mt-0.5" />
            <strong>{check.latestElsewhere}</strong> is out, but not as an update for this Nouride:{" "}
            {check.blockedReason ?? `there is no ${editionLabel(data.install.edition)} version of it yet`}.
            Each edition is published on its own, so an update reaches you once yours is out.
          </p>
        </div>
      )}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-base-content/65">{label}</span>
      <span className="text-xs font-medium text-right">{children}</span>
    </div>
  );
}
