/**
 * The tag tidy over the control API — the dashboard's card and review dialog, Merge into… in the graph,
 * and `nouride memory tags`. Operator-only, like the rest of Memory. `memory-tags.ts` decides; this
 * checks who is asking, backs the vault up before anything is written, and records the audit row.
 * The writes and the model's suggestions keep their connection open: on a large vault or a Pi they
 * take longer than the server's idle timeout.
 */

import { backupVault, type TidyChange } from "@/modules/memory/index.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { LONG_REQUEST_SECONDS } from "./memory.ts";
import { jsonBody } from "../payloads.ts";

/** A model change the dialog sends back: only the fields a merge needs, each checked. */
function modelChange(raw: unknown): TidyChange | null {
  const change = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const from = Array.isArray(change.from) ? change.from.filter((tag): tag is string => typeof tag === "string") : [];
  if (typeof change.into !== "string" || from.length === 0) return null;
  return { id: `model:${change.into}`, kind: "merge", from, into: change.into, episodes: 0, why: "model", ...(typeof change.reason === "string" ? { reason: change.reason.slice(0, 140) } : {}) };
}

export function registerMemoryTagRoutes(control: ControlApp, deps: ControlDeps): void {
  const refusal = (principal: Parameters<typeof atLeast>[0]): [string, 403 | 503] | null => {
    if (!atLeast(principal, "operator")) return ["operator only", 403];
    if (!deps.memory) return ["memory is not wired in this process", 503];
    return null;
  };
  // Read when a tidy runs, not when the routes are mounted: the config is live, and a route table built
  // for a contract test has none.
  const backup = () => {
    const config = deps.ctx.config;
    return backupVault({ vaultDir: config.memory.dir, dataDir: config.daemon.dataDir, keep: config.daemon.backupKeep, before: "tidy" });
  };
  /** A refusal because another job holds the turn is a conflict; anything else is a bad request. */
  const refused = (reason: string) => [{ error: reason, plain: "The tags were not changed. Try again in a moment." }, /is running/.test(reason) ? 409 : 400] as const;

  control.get("/memory/tags", (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    return c.json(deps.memory!.tags.list());
  });

  control.get("/memory/tags/tidy", async (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    return c.json({ ...deps.memory!.tags.plan(), last: await deps.memory!.tags.last() });
  });

  control.post("/memory/tags/tidy/model", async (c) => {
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    if (!deps.memoryPass) return c.json({ error: "the nightly pass's model is not set up in this process" }, 503);
    const result = await deps.memory!.tags.suggest(deps.memoryPass.ask);
    if ("refused" in result) return c.json({ error: result.refused, plain: "The model could not be asked for suggestions. Try again in a moment." }, 502);
    return c.json(result);
  });

  control.post("/memory/tags/tidy", async (c) => {
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0] }, no[1]);
    const body = await jsonBody(c);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    const model = Array.isArray(body?.model) ? body.model.map(modelChange).filter((change): change is TidyChange => change !== null) : [];
    if (ids.length === 0 && model.length === 0) return c.json({ error: "ids: the changes to apply, from GET /memory/tags/tidy" }, 400);
    const result = await deps.memory!.tags.apply(ids, model, principal.actor, backup);
    if ("refused" in result) return c.json(...refused(result.refused));
    deps.audit?.record({ action: "memory_tags_tidied", actor: principal.actor, details: { changes: result.changes.length, episodes: Object.keys(result.episodes).length } });
    return c.json({ at: result.at, changes: result.changes.length, episodes: Object.keys(result.episodes).length });
  });

  control.post("/memory/tags/merge", async (c) => {
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0] }, no[1]);
    const body = await jsonBody(c);
    const from = Array.isArray(body?.from) ? body.from.filter((tag): tag is string => typeof tag === "string") : [];
    if (typeof body?.into !== "string" || from.length === 0) return c.json({ error: "from: the tags to merge, into: the tag they become" }, 400);
    const result = await deps.memory!.tags.merge(from, body.into, principal.actor, backup);
    if ("refused" in result) return c.json(...refused(result.refused));
    deps.audit?.record({ action: "memory_tags_tidied", actor: principal.actor, details: { merged: from, into: body.into, episodes: Object.keys(result.episodes).length } });
    return c.json({ at: result.at, episodes: Object.keys(result.episodes).length });
  });

  control.post("/memory/tags/tidy/undo", async (c) => {
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0] }, no[1]);
    const result = await deps.memory!.tags.undo();
    if ("refused" in result) return c.json(...refused(result.refused));
    deps.audit?.record({ action: "memory_tags_tidy_undone", actor: principal.actor, details: { restored: result.restored, skipped: result.skipped.length } });
    return c.json(result);
  });
}
