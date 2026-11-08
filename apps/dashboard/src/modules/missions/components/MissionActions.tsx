/**
 * Stop, Continue and Accept, beside the mission's goal — each only when it applies (`actionsFor`) — and Delete once it
 * has ended (0.8.13). Answer is not here: it is a box under the question it answers. Stop, Accept as it is and Delete
 * ask first, since what they end does not come back.
 */

import { Check, Play, Square, Trash2 } from "lucide-react";
import type { MissionVerb, MissionView } from "@nouride/wire";
import { ApiError } from "@/commons/lib/api.client";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { actionsFor, shortId } from "../lib/mission";

export function MissionActions({
  mission,
  writable,
  pending,
  onAct,
  onDelete,
}: {
  mission: MissionView;
  writable: boolean;
  pending: boolean;
  onAct: (verb: MissionVerb) => void;
  /** Rejects with the daemon's refusal; a 409 with a note is the one `force` gets past — work nobody committed. */
  onDelete?: (force: boolean) => Promise<unknown>;
}) {
  const { ask, dialog } = useConfirm();
  const toast = useToast();

  async function deleteIt(): Promise<void> {
    if (!onDelete) return;
    const yes = await ask({
      title: `Delete mission ${shortId(mission.id)}?`,
      body: "Its record, its conversation and checklist, and the folder Nouride made for it go, and do not come back. A folder you named and its branch stay.",
      confirmLabel: "Delete it",
    });
    if (!yes) return;
    try {
      await onDelete(false);
    } catch (error) {
      // Work nobody kept is the one refusal force gets past: a 409 with a note, the CLI's `--force` hint, beside the
      // page's own words since 0.8.20.
      if (!(error instanceof ApiError && error.status === 409 && (error.note ?? error.server?.note))) {
        toast.error("Could not delete it", error);
        return;
      }
      // Its everyday words say what is lost; an older server's are the CLI's, and the page says it after them.
      const body = error.server ? error.message : `${error.message} Deleted anyway, it is lost.`;
      const anyway = await ask({ title: "Delete it with that work?", body, confirmLabel: "Delete anyway" });
      if (anyway) await onDelete(true).catch((again: unknown) => toast.error("Could not delete it", again));
    }
  }

  const actions = actionsFor(mission);
  const proposal = mission.waitKind === "accept" && mission.startedAt === null;
  return (
    // One row beside the title from md: shrunk to the title's leftovers, Stop wrapped under Accept.
    <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:flex-nowrap">
      {dialog}
      {actions.includes("accept") && (
        <button type="button" className="btn btn-primary btn-sm gap-1.5 rounded-xl" disabled={!writable || pending} onClick={() => onAct("accept")}>
          <Check size={14} aria-hidden="true" /> {proposal ? "Start it" : "Accept"}
        </button>
      )}
      {actions.includes("continue") && !proposal && (
        <button
          type="button"
          className={`btn btn-sm gap-1.5 rounded-xl ${actions.includes("accept") ? "btn-ghost" : "btn-primary"}`}
          disabled={!writable || pending}
          onClick={() => onAct("continue")}
        >
          <Play size={14} aria-hidden="true" /> Continue
        </button>
      )}
      {actions.includes("acceptAsIs") && (
        <button
          type="button"
          className="btn btn-ghost btn-sm gap-1.5 rounded-xl"
          disabled={!writable || pending}
          onClick={async () => {
            const yes = await ask({
              title: `Accept mission ${shortId(mission.id)} as it is?`,
              body: "It ends as done now, without its checks passing, and its record says so. Its folder and branch stay as they are.",
              confirmLabel: "Accept it",
            });
            if (yes) onAct("accept");
          }}
        >
          <Check size={14} aria-hidden="true" /> Accept as it is
        </button>
      )}
      {actions.includes("stop") && (
        <button
          type="button"
          className="btn btn-ghost btn-sm gap-1.5 rounded-xl text-error hover:bg-error/10"
          disabled={!writable || pending}
          onClick={async () => {
            // A draft has run nothing (0.8.11): dropped, its folder and brief go with it — the chat's button says "Drop it".
            const yes = await ask(
              proposal
                ? { title: `Drop draft ${shortId(mission.id)}?`, body: "Nothing has run. It ends as stopped, and its folder and brief go with it.", confirmLabel: "Drop it" }
                : { title: `Stop mission ${shortId(mission.id)}?`, body: "Its turn at work is cut off and it ends as stopped. What it wrote in its folder stays; it does not start again.", confirmLabel: "Stop it" },
            );
            if (yes) onAct("stop");
          }}
        >
          <Square size={12} className="fill-current" aria-hidden="true" /> {proposal ? "Drop it" : "Stop"}
        </button>
      )}
      {actions.includes("delete") && onDelete && (
        <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-xl text-error hover:bg-error/10" disabled={!writable || pending} onClick={() => void deleteIt()}>
          <Trash2 size={13} aria-hidden="true" /> Delete
        </button>
      )}
    </div>
  );
}
