/**
 * Turn off, on the LLM Gateway page's header: asked first, naming the agents that stop answering, and then a restart,
 * because the gateway stops only with the process it runs in.
 *
 * The question is asked with what the daemon says now (`GET /llm-gateway`): which agents reach their AI through it,
 * and whether anything starts Nouride again after a restart. Where nothing would, the setting is still saved and the
 * page says it takes effect when the server is restarted there. The restart is followed as Restart's is
 * (`restartThrough`), so the page holds still while Nouride is away and comes back on its own.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Power } from "lucide-react";
import type { LlmGatewayUser, LlmGatewayView } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { restartThrough } from "@/commons/lib/restart";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";

/** "Nouva", "Nouva and Kuro", "Nouva, Kuro and Nix". */
function names(users: LlmGatewayUser[]): string {
  const all = users.map((user) => user.name);
  return all.length <= 1 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}

/** What turning it off does, said before it is done. */
function TurnOffWords({ view }: { view: LlmGatewayView }) {
  return (
    <div className="space-y-2">
      <p>
        {view.usedBy.length === 0
          ? "No agent gets its AI through Nougate now."
          : `${names(view.usedBy)} ${view.usedBy.length === 1 ? "gets its" : "get their"} AI through Nougate, and ${view.usedBy.length === 1 ? "stops" : "stop"} answering until you give ${view.usedBy.length === 1 ? "it" : "them"} another AI service.`}
      </p>
      <p>
        {view.restarts
          ? "Nouride restarts to turn it off, once nothing is running. Chats are offline for a few seconds, and carry on after."
          : "Nothing on this server starts Nouride again by itself, so Nougate stays on until whoever runs the server restarts it."}
      </p>
    </div>
  );
}

/**
 * In Turn off's place once it is off in the settings but still running: turned off where nothing restarts Nouride.
 * Pressing it again would change nothing, so the header says what happens instead.
 */
export function StopsAtNextStart() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 text-xs text-base-content/65" title="Whoever runs the server can restart Nouride there.">
      <Power size={13} aria-hidden="true" />
      Stops when Nouride restarts
    </span>
  );
}

export function TurnOff() {
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function turnOff() {
    setBusy(true);
    try {
      const view = await queryClient.fetchQuery({ queryKey: ["llm-gateway", "switch"], queryFn: api.llmGateway, staleTime: 0 });
      const yes = await ask({
        title: "Turn off Nougate?",
        body: <TurnOffWords view={view} />,
        confirmLabel: view.restarts ? "Turn off and restart" : "Turn off",
      });
      if (!yes) return;
      await restartThrough(async () => {
        const answer = await api.switchLlmGateway(false);
        toast.info(answer.said);
        return answer.restart ? { waiting: answer.restart.waiting, note: answer.said } : null;
      });
      await queryClient.invalidateQueries({ queryKey: ["setup"] });
    } catch (error) {
      toast.error("Nougate was not turned off", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-xs gap-1.5 rounded-lg text-base-content/70 hover:text-base-content"
        disabled={busy}
        onClick={() => void turnOff()}
      >
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Power size={13} aria-hidden="true" />}
        Turn off
      </button>
      {dialog}
    </>
  );
}
