/**
 * A webhook's address and whether a call from outside can arrive at it: the address to copy and to make anew, local
 * network only, reachable from the internet, or unknown (the server's answer), a Send a test that goes through the
 * public address and runs nothing, and how to call it.
 *
 * A box behind a home router took webhooks a service could never deliver, and nothing on the page said so.
 */

import { useMutation } from "@tanstack/react-query";
import { Globe, HelpCircle, House, RefreshCw, Send, type LucideIcon } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AutomationSummary } from "@nouride/wire";
import { DOCS_URL } from "@/commons/lib/docs";
import { ErrorNote } from "@/commons/components/ui/ui";
import { CopyButton } from "@/commons/components/ui/CopyButton";
import { Details } from "@/commons/components/ui/Details";
import { useConfirm } from "@/commons/components/ui/confirm";
import { CallExample } from "./CallExample";

type Hook = NonNullable<AutomationSummary["hook"]>;
type State = Hook["reach"]["state"];

const LOOK: Record<State, { label: string; badge: string; icon: LucideIcon }> = {
  internet: { label: "Reachable from the internet", badge: "badge-success", icon: Globe },
  local: { label: "Local network only", badge: "badge-warning", icon: House },
  unknown: { label: "Reach unknown", badge: "badge-ghost", icon: HelpCircle },
};

function Reach({ id, enabled, hook, canTest, onTested }: { id: string; enabled: boolean; hook: Hook; canTest: boolean; onTested: () => void }) {
  const test = useMutation({ mutationFn: () => api.webhookTest(id), onSuccess: onTested });
  const look = LOOK[hook.reach.state];
  const Icon = look.icon;

  return (
    <div className="space-y-1.5 rounded-[14px] bg-base-200/60 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge badge-soft badge-sm gap-1 font-medium ${look.badge}`}>
          <Icon size={12} aria-hidden="true" /> {look.label}
        </span>
        {hook.reach.state !== "local" && (
          <button
            type="button"
            className="btn btn-ghost btn-xs gap-1 font-medium"
            disabled={!canTest || !enabled || test.isPending}
            title={enabled ? "Send a test through the public address. It does not run the automation." : "Turn it on first: a paused webhook answers nobody"}
            onClick={() => test.mutate()}
          >
            <Send size={14} aria-hidden="true" /> {test.isPending ? "Sending…" : "Send a test"}
          </button>
        )}
      </div>
      <p className="break-words text-base-content/75">
        {hook.reach.why}
        {hook.reach.test && <span className="font-mono text-base-content/65"> · {new Date(hook.reach.test.at).toLocaleString()}</span>}
      </p>
      {hook.reach.state === "local" && (
        <p className="leading-normal text-base-content/65">
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

/**
 * The address, and the two things anyone does with it.
 *
 * The public address when one is set: it is what a service outside is handed, and what Send a test goes through.
 * Without one, the browser's own origin: the server knows only what it bound to, which behind a reverse proxy is not
 * the host anybody can reach, while the browser is already talking to a name that reaches it.
 */
export function HookAddress({
  automation,
  canEdit,
  admin,
  onChanged,
}: {
  automation: Pick<AutomationSummary, "id" | "enabled" | "payload"> & { hook: Hook };
  canEdit: boolean;
  /** A new address is an admin's to make, as making the webhook was. */
  admin: boolean;
  onChanged: () => void;
}) {
  const { hook } = automation;
  const url = hook.urlGuessed ? `${window.location.origin}${hook.path}` : hook.url;
  const rotate = useMutation({ mutationFn: () => api.webhookRotate(automation.id), onSuccess: onChanged });
  const { ask, dialog } = useConfirm();
  const kind = automation.payload.kind;

  return (
    <div className="space-y-3">
      {dialog}
      {/* The address the whole width on a phone, its buttons under it; beside them it was a column of a dozen characters. */}
      <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
        <code className="min-w-0 flex-1 rounded-[14px] border border-base-content/[0.08] bg-base-200/60 px-3 py-2.5 font-mono text-xs leading-relaxed break-all max-sm:basis-full">{url}</code>
        <CopyButton text={url} className="btn btn-sm shrink-0 gap-1.5" />
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0 gap-1.5"
          disabled={!admin || rotate.isPending}
          title="Make a new address. The current one stops working"
          aria-label="Make a new address"
          onClick={async () => {
            const yes = await ask({
              title: "Give this webhook a new address?",
              body: "The current address stops working at once. Anything already using it is turned away until you paste the new one in.",
              confirmLabel: "New address",
            });
            if (yes) rotate.mutate();
          }}
        >
          <RefreshCw size={14} aria-hidden="true" className={rotate.isPending ? "animate-spin" : ""} />
        </button>
      </div>
      <p className="text-xs leading-normal text-base-content/65">Anyone with this address can start it, so treat it like a password, and make a new one if it leaks.</p>
      <ErrorNote error={rotate.error} />
      <Reach id={automation.id} enabled={automation.enabled} hook={hook} canTest={canEdit} onTested={onChanged} />
      <CallExample url={url} kind={kind === "steps" ? "agentTurn" : kind} />
    </div>
  );
}
