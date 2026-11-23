/**
 * `GET /live-edits/:id`: a change an agent wrote to what a person has open on a dashboard page, for that page to draw
 * (`modules/live-edit`). The change's id is on the `tool_done` of the call that wrote it; the change itself is too
 * large for a row of the stream, and is held in memory until the page asks for it.
 *
 * It is the person's who asked for it: their account, or an admin. What an automation's draft holds is what its page
 * showed that person, and another account that knew the id would read it otherwise. A caller with the daemon's own
 * token is no account and reads any, as it reads everything else.
 */

import type { LiveEditOffer } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

export function registerLiveEditRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/live-edits/:id", (c) => {
    const offer = deps.pipeline.liveEdits()?.offered(c.req.param("id")) ?? null;
    const principal = c.get("principal");
    const theirs = offer !== null && (!principal.user || principal.user.id === offer.senderId || atLeast(principal, "admin"));
    // One answer for none and for another's: whether an id is somebody's is not this caller's to learn.
    if (!offer || !theirs) return c.json({ error: "no such change", plain: "That change is no longer here. Ask the agent for it again." }, 404);
    return c.json({ offer: { id: offer.id, kind: offer.kind, target: offer.target, value: offer.value, by: offer.by, at: offer.at } } satisfies { offer: LiveEditOffer });
  });
}
