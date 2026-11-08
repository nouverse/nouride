/**
 * My Box — this Nouride Box, its link to a Nouverse account, and the codes printed on it.
 *
 * Served by the appliance plugin through `/api/control/appliance/*` (a paired Box, Pro or Pro
 * Router); the menu item exists only there (`/health` → `appliance`). On anything else the state read answers 404 and the
 * page says so rather than drawing an empty box.
 *
 * ## Claiming is manual, and it happens here
 *
 * Wi-Fi setup ends on this dashboard whether or not the box is claimed. Claiming is the owner's
 * choice: they read what it is for, ask for a claim link, and open it on a phone (QR) or in this
 * browser. The link carries a one-time token the box has just reported to Nouverse, so only
 * somebody signed in here as an admin can claim it. The page then polls until Nouverse says the
 * box is linked, and names the account.
 */

import { useEffect, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  CircleAlert,
  Cloud,
  CloudOff,
  ExternalLink,
  Link2,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { applianceApi as api } from "@/commons/lib/api.appliance";
import type { BoxState } from "@nouride/wire";
import { editionLabel } from "@/commons/hooks/use-update";
import { ago } from "@/commons/lib/format";
import { QrTile } from "./components/QrTile";
import { CodesCard } from "./components/CodesCard";
import { LocalCard } from "./components/LocalCard";
import { UpdatesCard } from "./components/UpdatesCard";
import { Card, ErrorNote, PageHeader } from "@/commons/components/ui/ui";

const BENEFITS: { icon: typeof Cloud; title: string; body: string }[] = [
  {
    icon: Sparkles,
    title: "Updates for your edition",
    body: "Your box gets new Nouride versions and fixes for its edition, installed from this dashboard.",
  },
  {
    icon: MapPin,
    title: "Find your box from anywhere",
    body: "app.nouverse.tech always shows your box's current dashboard address, even after your router gives it a new one.",
  },
  {
    icon: ShieldCheck,
    title: "Proof it's yours",
    body: "Support, warranty and replacements go through your account, and a lost or stolen box can be suspended.",
  },
  {
    icon: Cloud,
    title: "Your Nouverse account, on your box",
    body: "Account features such as NOU credits for models become available to the box as they launch.",
  },
];

const SYNC_LABEL: Record<NonNullable<BoxState["lastSync"]>, string> = {
  active: "Online",
  awaiting_claim: "Online, not claimed yet",
  suspended: "Suspended by Nouverse",
  unauthorized: "Refused: this box needs to be reprovisioned",
  rate_limited: "Online, Nouverse asked it to wait",
  unreachable: "Offline: can't reach Nouverse",
};

const LICENSE_LABEL: Record<BoxState["license"], string> = {
  absent: "None yet. Claim the box to get one",
  valid: "Valid",
  hardware_mismatch: "Issued for different hardware, updates paused",
  invalid: "Does not verify",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5 border-b border-base-content/[0.06] last:border-0">
      <dt className="text-xs font-semibold uppercase tracking-wider text-base-content/65 font-mono">{label}</dt>
      <dd className="text-sm text-base-content text-right break-all">{children}</dd>
    </div>
  );
}

export default function BoxPage() {
  const queryClient = useQueryClient();
  const box = useQuery({
    queryKey: ["box"],
    queryFn: api.boxState,
    // Fast while a claim link is out — the owner is claiming on their phone right now.
    refetchInterval: (query) => (query.state.data?.claimLink ? 4_000 : 30_000),
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: api.boxRefresh,
    onSuccess: (state) => queryClient.setQueryData(["box"], state),
  });
  const claimLink = useMutation({
    mutationFn: api.boxClaimLink,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["box"] }),
  });

  // While a link is out, also ask Nouverse directly now and then: the box's own poll can be a
  // minute apart, and the owner is looking at this page waiting for it to flip.
  const linkOut = Boolean(box.data?.claimLink);
  const { mutate: refreshNow } = refresh;
  useEffect(() => {
    if (!linkOut) return;
    const timer = setInterval(() => refreshNow(), 15_000);
    return () => clearInterval(timer);
  }, [linkOut, refreshNow]);

  const state = box.data && typeof box.data.deviceId === "string" ? box.data : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Box"
        description="This Nouride Box, its link to your Nouverse account, and the codes printed on it."
        actions={
          state ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm rounded-xl gap-2 font-medium active:scale-95 transition-all"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              <RefreshCw size={14} className={refresh.isPending ? "animate-spin" : ""} /> Check now
            </button>
          ) : undefined
        }
      />

      {box.isPending && (
        <div className="flex items-center gap-2.5 py-6 text-sm text-base-content/65">
          <Loader2 size={16} className="animate-spin text-primary" /> Reading your box…
        </div>
      )}

      {!box.isPending && !state && (
        <Card title="Not a Nouride Box">
          <p className="text-sm text-base-content/65 leading-relaxed">
            This page is for Nouride Boxes (the Pro edition). This Nouride is not a Box, so there is nothing to show.
          </p>
          {box.error ? <div className="mt-3"><ErrorNote error={box.error} /></div> : null}
        </Card>
      )}

      {state && (
        <div className="grid gap-6">
          <StatusCard state={state} />
          {state.claimed ? (
            <LinkedCard state={state} />
          ) : (
            <ClaimCard
              state={state}
              onClaim={() => claimLink.mutate()}
              claiming={claimLink.isPending}
              error={claimLink.error}
            />
          )}
          <LocalCard state={state} />
          <UpdatesCard state={state} />
          <CodesCard state={state} />
        </div>
      )}
    </div>
  );
}

function StatusCard({ state }: { state: BoxState }) {
  const online = state.lastSync === "active" || state.lastSync === "awaiting_claim" || state.lastSync === "rate_limited";
  return (
    <Card
      title="Status"
      actions={
        state.claimed ? (
          <span className="badge badge-success badge-soft gap-1.5 font-medium font-mono">
            <BadgeCheck size={13} /> Claimed
          </span>
        ) : (
          <span className="badge badge-warning badge-soft gap-1.5 font-medium font-mono">
            <CircleAlert size={13} /> Not claimed
          </span>
        )
      }
    >
      <dl>
        <Row label="Linked account">
          {state.owner ? (
            <span>
              <span className="font-medium">{state.owner.email}</span>
              {state.owner.name ? <span className="text-base-content/65"> · {state.owner.name}</span> : null}
            </span>
          ) : state.claimed ? (
            <span className="text-base-content/65">Claimed. Details arrive with the next check</span>
          ) : (
            <span className="text-base-content/65">Not linked</span>
          )}
        </Row>
        {state.claimedAt && <Row label="Claimed">{new Date(state.claimedAt).toLocaleString()}</Row>}
        <Row label="Nouverse">
          <span className="inline-flex items-center gap-1.5">
            {online ? <Cloud size={14} className="text-success" /> : <CloudOff size={14} className="text-base-content/45" />}
            {state.lastSync ? SYNC_LABEL[state.lastSync] : "Not checked yet"}
            <span className="text-base-content/65">· {state.lastSyncAt ? ago(state.lastSyncAt) : "never"}</span>
          </span>
        </Row>
        <Row label="License">{LICENSE_LABEL[state.license]}</Row>
        <Row label="Edition">{state.edition ? editionLabel(state.edition) : "—"}</Row>
        <Row label="Device ID">
          <span className="font-mono text-xs">{state.deviceId}</span>
        </Row>
        <Row label="On your network">
          {state.network.lanIp ? (
            <span className="font-mono text-xs">{state.network.lanIp}</span>
          ) : (
            <span className="text-base-content/65">No address yet</span>
          )}
        </Row>
        <Row label="Hardware identity">
          {state.fingerprintQuality === "strong" ? "Bound to the board's serial" : "Bound to the OS install only (no readable serial)"}
        </Row>
      </dl>
    </Card>
  );
}

function Benefits() {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {BENEFITS.map(({ icon: Icon, title, body }) => (
        <li key={title} className="flex gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon size={16} />
          </span>
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-base-content">{title}</p>
            <p className="text-xs text-base-content/65 leading-relaxed">{body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ClaimCard({
  state,
  onClaim,
  claiming,
  error,
}: {
  state: BoxState;
  onClaim: () => void;
  claiming: boolean;
  error: unknown;
}) {
  const link = state.claimLink;
  return (
    <Card
      title="Claim this box"
      description="Link it to your Nouverse account. Optional: everything on the box works without it."
    >
      <div className="space-y-6">
        <Benefits />

        <p className="text-xs text-base-content/65 leading-relaxed">
          Claiming shares this box's identity, version and network address with Nouverse. Your chats, agents and files stay on the box.
        </p>

        {!link ? (
          <div className="space-y-3">
            <button type="button" className="btn btn-primary rounded-xl gap-2 active:scale-95 transition-all" onClick={onClaim} disabled={claiming}>
              {claiming ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />} Get a claim link
            </button>
            {error ? <ErrorNote error={error} /> : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-[auto_1fr] sm:items-center">
            <QrTile
              payload={link.url}
              title="Scan with your phone"
              caption="Sign in to Nouverse on the phone and tap Claim."
            />
            <div className="space-y-3">
              <p className="text-sm text-base-content/75 leading-relaxed">
                Or open the link here and sign in. This page updates by itself once the box is claimed.
              </p>
              <a href={link.url} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm rounded-xl gap-2">
                Open claim page <ExternalLink size={14} />
              </a>
              <p className="flex items-center gap-2 text-xs text-base-content/65">
                <Loader2 size={12} className="animate-spin" /> Waiting for Nouverse · link valid until{" "}
                {new Date(link.expiresAt).toLocaleTimeString()}
              </p>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function LinkedCard({ state }: { state: BoxState }) {
  return (
    <Card title="What your claim gives you" description={state.owner ? `Linked to ${state.owner.email}.` : undefined}>
      <div className="space-y-5">
        <Benefits />
        <a href={`${state.appUrl}/b/${state.deviceId}`} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm rounded-xl gap-2">
          Open in Nouverse <ExternalLink size={14} />
        </a>
      </div>
    </Card>
  );
}
