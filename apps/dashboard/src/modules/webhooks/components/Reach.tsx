/**
 * Whether a call from outside can arrive at this hook (0.8.0): local network only, reachable from the internet, or
 * unknown — the daemon's answer, with a Send a test that goes through the public address and runs nothing.
 *
 * A box behind a home router took webhooks a service could never deliver, and nothing on this page said so.
 */

import { useMutation } from "@tanstack/react-query";
import { Globe, HelpCircle, House, Send, type LucideIcon } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { WebhookSummary } from "@nouride/wire";
import { DOCS_URL } from "@/commons/lib/docs";
import { ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";

type State = WebhookSummary["reach"]["state"];

const LOOK: Record<State, { label: string; badge: string; icon: LucideIcon }> = {
  internet: { label: "Reachable from the internet", badge: "badge-success", icon: Globe },
  local: { label: "Local network only", badge: "badge-warning", icon: House },
  unknown: { label: "Reach unknown", badge: "badge-ghost", icon: HelpCircle },
};

export function Reach({ hook, canTest, onTested }: { hook: WebhookSummary; canTest: boolean; onTested: () => void }) {
  const test = useMutation({ mutationFn: () => api.webhookTest(hook.id), onSuccess: onTested });
  const look = LOOK[hook.reach.state];
  const Icon = look.icon;

  return (
    <div className="space-y-1.5 rounded-xl bg-base-200/40 border border-base-content/[0.05] p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge badge-soft badge-sm gap-1 font-medium font-mono ${look.badge}`}>
          <Icon size={12} aria-hidden="true" /> {look.label}
        </span>
        {hook.reach.state !== "local" && (
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg gap-1 font-medium hover:bg-base-200"
            disabled={!canTest || !hook.enabled || test.isPending}
            title={hook.enabled ? "Post a test through the public address. It does not run the job." : "Resume it first: a paused webhook answers nobody"}
            onClick={() => test.mutate()}
          >
            <Send size={14} aria-hidden="true" /> {test.isPending ? "Sending…" : "Send a test"}
          </button>
        )}
      </div>
      <p className="text-base-content/75 break-words">
        {hook.reach.why}
        {hook.reach.test && <span className="text-base-content/65 font-mono"> · {new Date(hook.reach.test.at).toLocaleString("sv-SE")}</span>}
      </p>
      {hook.reach.state === "local" && (
        <p className="text-base-content/65 leading-normal">
          To take calls from GitHub, Stripe or another service, this server needs an address the internet can reach (a
          tunnel such as Cloudflare Tunnel or Tailscale Funnel, or a forwarded port), set by whoever runs it. Anything that can
          post to Telegram or Discord reaches it from anywhere already.{" "}
          <a className="link" href={`${DOCS_URL}/docs/manual/schedule/#reaching-a-webhook-from-the-internet`} target="_blank" rel="noreferrer">
            How
          </a>
        </p>
      )}
      {hook.reach.state === "local" && (
        <Details>
          <p>
            Set the public address as <code>[dashboard] public_url</code>.
          </p>
        </Details>
      )}
      <ErrorNote error={test.error} />
    </div>
  );
}
