/**
 * The LLM Gateway page while Nougate is off: what it is, in a sentence, and the one thing to do about it.
 *
 * Every build carries it switched off, so this is the page most people see first. Turning it on starts it on this
 * server in a few seconds, with no restart, and the page becomes the gateway's own as soon as the daemon says it runs.
 * Where the server's settings hold the switch, it is shown as theirs and nothing here can move it.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Power } from "lucide-react";
import { NougateMark } from "@/commons/components/brand/logos";
import { ErrorNote } from "@/commons/components/ui/ui";
import { api } from "@/commons/lib/api";
import { SetByServer } from "./SetByServer";

export function GatewayOff({ locked }: { locked: boolean }) {
  const queryClient = useQueryClient();
  const turnOn = useMutation({
    mutationFn: () => api.switchLlmGateway(true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["setup"] }),
  });

  return (
    <div className="flex flex-1 items-center justify-center p-4 sm:p-8">
      <section className="w-full max-w-md space-y-5 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-6 shadow-soft sm:p-8">
        <div className="flex items-center gap-3">
          <NougateMark className="size-12 shrink-0 drop-shadow-sm" />
          <div className="min-w-0">
            <h1 className="text-xl text-base-content">Nougate</h1>
            <p className="text-xs font-semibold text-base-content/65">Off</p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-base-content/80">
          Nougate lets your agents use an AI account you already pay for, instead of an API key. It runs here, on your
          server. Once it is on, you sign in to your accounts on this page.
        </p>
        {locked ? (
          <SetByServer on={false} />
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full gap-2 rounded-full font-semibold active:scale-[0.98] transition-transform"
            disabled={turnOn.isPending}
            onClick={() => turnOn.mutate()}
          >
            {turnOn.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}
            {turnOn.isPending ? "Turning on…" : "Turn on Nougate"}
          </button>
        )}
        <ErrorNote error={turnOn.error} />
      </section>
    </div>
  );
}
