/**
 * Restart: the daemon, for its supervisor to start again — on Overview, and beside every "takes effect after a restart".
 *
 * It waits for running work the way `nouride restart` does, says so while it waits, and offers the way to stop waiting.
 * What happens after is the follower's (`commons/lib/restart.ts`): the page holds still while the daemon is away and
 * comes back by itself, wherever the person went meanwhile. Shown to whoever may make changes: `POST /restart` is an
 * operator's, like every other one.
 */

import { Loader2, RefreshCw } from "lucide-react";
import { restartDaemon, restartNow, useRestart } from "@/commons/lib/restart";
import { canWrite, useMe } from "@/commons/lib/session";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { cn } from "@/commons/lib/utils";

export function RestartButton({ className }: { className?: string }) {
  const me = useMe();
  const { ask, dialog } = useConfirm();
  const toast = useToast();
  const restart = useRestart();
  if (!canWrite(me.data ?? null)) return null;

  async function handleRestart() {
    const confirmed = await ask({
      title: "Restart Nouride?",
      body:
        "Nouride waits until nothing is running (replies, queued messages and approvals for up to ten minutes, " +
        "background jobs until they finish), then restarts. Every chat is offline for a few seconds, and " +
        "conversations carry on after. This page comes back by itself.",
      confirmLabel: "Restart",
    });
    if (!confirmed) return;
    try {
      await restartDaemon();
    } catch (error) {
      // The route's everyday words where it gave them, its own (a command, a flag) under Details (0.8.20).
      toast.error("Could not restart", error);
    }
  }

  if (restart.phase === "waiting" || restart.phase === "restarting" || restart.phase === "back") {
    return (
      <div role="status" className={cn("flex items-center gap-2 px-3 py-1.5 rounded-full bg-base-100 border border-base-content/10 shadow-xs font-mono text-xs font-medium", className)}>
        <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />
        {restart.phase === "waiting" && restart.kind !== "outage" ? (
          <>
            <span title={restart.note ?? undefined}>Waiting for running work…</span>
            <button type="button" className="link link-primary" onClick={restartNow}>
              Restart now
            </button>
          </>
        ) : (
          <span>Restarting…</span>
        )}
      </div>
    );
  }

  return (
    <>
      <button type="button" className={cn("btn btn-ghost btn-sm rounded-xl gap-1.5", className)} onClick={() => void handleRestart()}>
        <RefreshCw size={14} aria-hidden="true" /> Restart
      </button>
      {dialog}
    </>
  );
}
