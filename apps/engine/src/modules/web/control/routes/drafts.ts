/**
 * Skill learning's surface: what the agents and the weekly review have proposed, and `[skills.learning]`.
 *
 * The pool routes next door answer "what exists and who has it". These answer the two questions that
 * only exist once agents can propose — **what is being suggested, where did it come from, and do I
 * want it?**, and **how much should run without me?** Both live here because they are one screen: the
 * only way to know whether the mode is right is to look at the queue it produced, and a setting on a
 * different page from its effect is a setting nobody revisits.
 *
 * The origin transcript is served with the draft rather than behind a second request, because
 * approving a procedure you cannot trace back to the turn that produced it is approving a model's
 * word for it.
 *
 * Registered *before* `registerSkillRoutes`. `/skills/drafts`, `/skills/learning`, `/skills/review` and
 * `/skills/:name/source` do not collide today — the last one's second segment is a name and its third
 * the literal `source` — but specific-before-generic is the rule this directory keeps rather than an
 * accident of position.
 */

import { atLeast } from "@/modules/users/auth.ts";
import type { SkillDraft } from "@/modules/reflection/types.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { LONG_REQUEST_SECONDS } from "./memory.ts";
import { NOT_SAVED, NO_SETTINGS } from "../plain.ts";

/** The draft as a client sees it. Same fields, minus nothing — there is nothing secret in a draft. */
function toJson(draft: SkillDraft): Record<string, unknown> {
  return {
    id: draft.id,
    createdAt: draft.createdAt,
    agentId: draft.agentId,
    gatewayId: draft.gatewayId,
    chatId: draft.chatId,
    triggerKind: draft.triggerKind,
    triggerReason: draft.triggerReason,
    name: draft.name,
    description: draft.description,
    requires: draft.requires,
    needsTools: draft.needsTools,
    body: draft.body,
    target: draft.target,
    files: draft.files,
    removeFiles: draft.removeFiles,
    // The earlier lessons this draft absorbed: the dashboard and the CLI read it, and until 0.7.27 it was never sent.
    carries: draft.carries,
    retire: draft.retire,
    model: draft.model,
    status: draft.status,
    decidedAt: draft.decidedAt,
    decidedBy: draft.decidedBy,
    publishedPath: draft.publishedPath,
  };
}

export function registerDraftRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The queue, and what has recently been decided beside it.
   *
   * Both in one response because they are one screen: a decision made two minutes ago is the context
   * for the drafts still waiting, and a second request for it would show an empty history on the
   * first paint of every page load.
   */
  control.get("/skills/drafts", (c) => {
    if (!deps.reflection) return c.json({ enabled: false, pending: [], recent: [] });

    const recent = deps.reflection.recent(50);
    return c.json({
      enabled: true,
      pending: recent.filter((draft) => draft.status === "pending").map(toJson),
      // Decided rows only — the pending ones are already above, and repeating them would double
      // every row in a table that is meant to be read at a glance.
      recent: recent.filter((draft) => draft.status !== "pending").map(toJson),
    });
  });

  /**
   * Skill learning's settings (`[skills.learning]`), and whether this daemon can change them at all.
   *
   * `editable` is false when there is no `SettingsService` — a daemon on built-in defaults has no
   * file to write, and a control that silently fails is worse than one visibly disabled. Same shape
   * as `/access` and `/group-context`.
   */
  control.get("/skills/learning", (c) => {
    const learning = deps.ctx.config.skills.learning;
    return c.json({
      mode: learning.mode,
      model: learning.model,
      notifyChat: learning.notifyChat,
      /** The last weekly review, and what it proposed — null before the first. */
      lastReview: deps.reflection?.library.last() ?? null,
      editable: Boolean(deps.settings),
      /** Pending right now, so the form can say what the current setting has actually produced. */
      pending: deps.reflection?.pending().length ?? 0,
    });
  });

  /**
   * Change them. Operator, and **live** — the next turn is judged under the new settings.
   *
   * Operator rather than admin, unlike `/access/mode`: nothing here decides what an agent may *do*.
   */
  control.post("/skills/learning", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.settings.setSkillLearning({ patch: body, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);

    return c.json({ ok: true, ...deps.ctx.config.skills.learning });
  });

  /** The weekly review of the library, now. Operator: it only proposes — every proposal waits as a draft. */
  control.post("/skills/review", async (c) => {
    if (!deps.reflection) return c.json({ error: "skill learning is not wired" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const outcome = await deps.reflection.library.run();
    if ("refused" in outcome) {
      const plain =
        outcome.why === "running"
          ? "A review is already running. Wait for it to finish."
          : outcome.why === "spend"
            ? "Today's spending limit for AI use is reached, so the review did not run. It can run tomorrow."
            : "Reviewing skills is not running on this server.";
      return c.json({ error: outcome.refused, plain }, 409);
    }
    return c.json(outcome);
  });

  /** One draft, with the scrubbed transcript the synthesis pass actually read. */
  control.get("/skills/drafts/:id", (c) => {
    if (!deps.reflection) return c.json({ error: "self-improvement is not wired" }, 501);

    const draft = deps.reflection.get(c.req.param("id"));
    if (!draft) return c.json({ error: "no such draft" }, 404);
    return c.json({ ...toJson(draft), transcript: draft.transcript });
  });

  /**
   * Approve and deploy. Optional edits are applied first, so one click can be "fix this and keep it" — the Workshop's
   * editor: fix the description, tighten the procedure, drop the `requires` line the pass got wrong (`requires` names
   * binaries that run locally, and a transcript full of `ssh` commands leads a model to declare the remote's tooling).
   * There is no saving an edit without deciding: nothing ever called the route that did, and it was removed in 0.7.11.
   *
   * The audit record is written by the engine, not here: approving from Telegram and approving from
   * the dashboard have to leave the same row, and two call sites recording it is how they stop.
   */
  control.post("/skills/drafts/:id/approve", async (c) => {
    if (!deps.reflection) return c.json({ error: "self-improvement is not wired" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.reflection.approve(c.req.param("id"), principal.actor, readEdits(body));
    if (!result.ok) return c.json({ error: result.error, plain: "The skill was not kept. Check its name and what you changed, and try again." }, 400);

    return c.json({ ok: true, skill: result.draft.name, path: result.path });
  });

  /** Discard. The row and its transcript are deleted, leaving nothing of the draft behind. */
  control.post("/skills/drafts/:id/deny", (c) => {
    if (!deps.reflection) return c.json({ error: "self-improvement is not wired" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const gone = deps.reflection.deny(c.req.param("id"), principal.actor);
    if (!gone) return c.json({ error: "no such draft, or it has already been decided" }, 404);
    return c.json({ ok: true });
  });
}

/**
 * Only the four fields a human may change, and only when they are strings.
 *
 * An absent field keeps what the model wrote — which is why this cannot be a spread of the body: a
 * client sending `{"name": null}` would otherwise erase a name, and the failure would surface as an
 * invalid skill name at write time rather than as a rejected request.
 */
function readEdits(body: Record<string, unknown>): {
  name?: string;
  description?: string;
  requires?: string;
  needsTools?: string;
  body?: string;
} {
  const pick = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const name = pick(body.name);
  const description = pick(body.description);
  const requires = pick(body.requires);
  const needsTools = pick(body.needsTools);
  const text = pick(body.body);

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(requires === undefined ? {} : { requires }),
    ...(needsTools === undefined ? {} : { needsTools }),
    ...(text === undefined ? {} : { body: text }),
  };
}
