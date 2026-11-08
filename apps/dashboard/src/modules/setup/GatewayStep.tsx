/**
 * The wizard's other way through the provider step: the LLM gateway this build carries.
 *
 * Offered beside the API-key form, never instead of it — a key is still the first way in, and the
 * only one on a build without the gateway. What this saves is everything a key is a stand-in for:
 * the person signs in to an account they already pay for, and the daemon wires itself to the gateway
 * with a key it mints and never shows (`SetupService.useBundledGateway`).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { NougateMark } from "@/commons/components/brand/logos";
import { api, type SetupState } from "@/commons/lib/api";
import { ConnectAccounts } from "./ConnectAccounts";
import { gatewayApi } from "./gateway-api";
import { offerSentence } from "./gateway-providers";
import { gatewayMount } from "@/commons/lib/bundled-gateway";

/** The card under the API-key form that leads here. Nothing on a build without the gateway. */
export function GatewayOffer({ state, onUse }: { state: SetupState | undefined; onUse: () => void }) {
  const mount = gatewayMount(state);
  return mount ? <OfferCard mount={mount} onUse={onUse} /> : null;
}

function OfferCard({ mount, onUse }: { mount: string; onUse: () => void }) {
  // The same read the sign-in step makes, so opening it costs nothing more — and the sentence names
  // what this gateway actually offers rather than a list written here.
  const providers = useQuery({ queryKey: ["llm-gateway", "providers"], queryFn: gatewayApi(mount).providers });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-base-content/65 font-mono">
        <span className="h-px flex-1 bg-base-content/10" /> or <span className="h-px flex-1 bg-base-content/10" />
      </div>
      <button
        type="button"
        onClick={onUse}
        className="group w-full text-left rounded-2xl border border-primary/30 bg-primary/[0.06] hover:bg-primary/[0.1] px-4 py-3.5 flex items-center gap-3 transition-colors active:scale-[0.99]"
      >
        <NougateMark className="size-10 shrink-0 drop-shadow-sm" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-base-content">Use Nougate</span>
          <span className="block text-xs text-base-content/65">{offerSentence(providers.data)}</span>
        </span>
        <ArrowRight size={16} className="text-primary shrink-0 transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}

export function GatewayStep({ mount, onBack }: { mount: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  // The same key `ConnectAccounts` reads, so a finished sign-in there enables Continue here.
  const providers = useQuery({ queryKey: ["llm-gateway", "providers"], queryFn: gatewayApi(mount).providers });
  // Any provider with an account counts — a custom one added on the LLM Gateway page included.
  const signedIn = (providers.data ?? []).some((provider) => provider.accountCount > 0);

  const connect = useMutation({
    mutationFn: api.connectBundledGateway,
    onSuccess: async (result) => {
      // The agent step's picker, filled with what the signed-in accounts can serve.
      queryClient.setQueryData(["models"], result.models);
      await queryClient.invalidateQueries({ queryKey: ["setup"] });
    },
  });

  return (
    <div className="rounded-3xl border border-base-content/[0.08] bg-base-100/85 backdrop-blur-2xl p-6 sm:p-8 shadow-2xl space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-base-content/65 hover:text-base-content"
      >
        <ArrowLeft size={14} /> Use an API key instead
      </button>

      <div>
        <h2 className="text-lg font-bold tracking-tight text-base-content">Sign in with an AI subscription</h2>
        <p className="text-base-content/65 text-sm mt-0.5">
          Nougate runs on this server and talks to the AI for your agents. Sign in to one account to start; you can
          add more accounts and see what they use later, on Nougate's own page.
        </p>
      </div>

      <ConnectAccounts mount={mount} />

      {connect.isError && (
        <div className="alert alert-error bg-error/10 border border-error/30 text-error text-xs rounded-xl p-3 flex items-center gap-2">
          <AlertTriangle size={15} className="shrink-0" />
          <span>{(connect.error as Error).message}</span>
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-sm w-full rounded-xl font-semibold shadow-md active:scale-95 transition-all"
        disabled={!signedIn || connect.isPending}
        onClick={() => connect.mutate()}
      >
        {connect.isPending && <Loader2 size={15} className="animate-spin" />}
        {signedIn ? "Continue" : "Sign in to an account to continue"}
      </button>
    </div>
  );
}
