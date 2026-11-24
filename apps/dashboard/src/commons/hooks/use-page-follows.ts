/**
 * The page under the floating chat follows what the agent does there.
 *
 * A person asks an agent for something on the page they are looking at, and the page showed nothing of it until it
 * was loaded again. Two things, both read from the turn the chat already follows, so no page has code for it:
 *
 * - When a call of the turn made or changed something with a page of its own (`tool_done.page`: an automation
 *   proposed, a mission started), and when the turn ends, what the page shows is read again. Not on a timer: only
 *   when the agent did something.
 * - On a page that makes a new one (`/automations/new`), what the agent made there is opened in its place, unless the
 *   person has written in the form (`lib/unsaved.ts`): the agent's work is then one press away, under its answer.
 * - When a call changed what the page holds open (`tool_done.liveEdit`: an automation's draft), the change is fetched
 *   and offered to the page that holds it (`lib/live-edit.ts`), which draws it for the person to apply. Nothing is
 *   read again for it: nothing was saved.
 *
 * A turn first seen with calls already done is not acted on for those: they happened before the chat was looking.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { LiveTurn } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { holdsOpen, offerLiveEdit } from "@/commons/lib/live-edit";
import { holdsUnsaved } from "@/commons/lib/unsaved";

/** The pages the calls of a turn made, in the order they were made. */
export const pagesMade = (turn: Pick<LiveTurn, "steps">): string[] => turn.steps.flatMap((step) => (step.kind === "tool_done" && step.page ? [step.page] : []));

/** The changes the calls of a turn wrote to what a page holds open, by their ids, in the order they were written. */
const editsMade = (turn: Pick<LiveTurn, "steps">): string[] => turn.steps.flatMap((step) => (step.kind === "tool_done" && step.liveEdit ? [step.liveEdit] : []));

/**
 * A change as the agent's turn wrote it, fetched by its id and offered to the page that holds what it changes; it
 * waits for that page where another is on screen. One the person answered already is not taken again
 * (`offerLiveEdit`), and one the daemon no longer has (a restart forgot it) is no change to draw.
 */
async function offerEdit(id: string): Promise<void> {
  try {
    offerLiveEdit((await api.liveEdit(id)).offer);
  } catch {
    // Nothing to draw.
  }
}

/**
 * The same change asked for again from the chat, by a person: drawn where the page on screen holds what it changes,
 * applied or discarded before or not. Elsewhere it is not left waiting: one written for something being made names
 * nothing, and would be drawn over whatever is made next. `gone`: the daemon no longer has it.
 */
export async function showEdit(id: string): Promise<"drawn" | "elsewhere" | "gone"> {
  try {
    const { offer } = await api.liveEdit(id);
    if (!holdsOpen(offer.kind, offer.target)) return "elsewhere";
    offerLiveEdit(offer, "asked");
    return "drawn";
  } catch {
    return "gone";
  }
}

/** The page that makes a new one of what `page` is: `/automations/new` for `/automations/<id>`. */
export const makerOf = (page: string): string => `${page.slice(0, page.lastIndexOf("/"))}/new`;

export function usePageFollows(turns: readonly LiveTurn[]): void {
  const queryClient = useQueryClient();
  const router = useRouter();
  const seen = useRef(new Map<string, { made: number; edits: number; ended: boolean }>());

  useEffect(() => {
    let changed = false;
    let made: string | undefined;
    const drawn = new Set<string>();
    for (const turn of turns) {
      drawn.add(turn.id);
      const pages = pagesMade(turn);
      const edits = editsMade(turn);
      const ended = turn.status !== "running";
      const was = seen.current.get(turn.id);
      seen.current.set(turn.id, { made: pages.length, edits: edits.length, ended });
      // First seen: what it did before the chat was looking is not acted on, and it is followed from here.
      if (!was) continue;
      // Its newest change to what the page holds: an earlier one of the same turn is one it wrote over.
      if (edits.length > was.edits) void offerEdit(edits.at(-1)!);
      if (pages.length > was.made) {
        changed = true;
        made = pages.at(-1);
      }
      if (ended && !was.ended) changed = true;
    }
    // One that was at work and is no longer drawn as live has ended: the transcript took it.
    for (const [id, was] of seen.current) {
      if (drawn.has(id)) continue;
      if (!was.ended) changed = true;
      seen.current.delete(id);
    }
    if (!changed) return;
    void queryClient.invalidateQueries();
    // The agent's page is a path it handed over, which no route's type knows.
    if (made && router.state.location.pathname === makerOf(made) && !holdsUnsaved()) void router.navigate({ to: made as "/" });
  }, [turns, queryClient, router]);
}
