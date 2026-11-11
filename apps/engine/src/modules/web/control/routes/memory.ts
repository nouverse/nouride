/**
 * Memory's settings and machinery — the nightly pass, its proposals and failures, the index and
 * forget (`docs/SPEC.md` §12). What is kept — profiles, conversations, agent notes — is read and
 * edited in `memory-documents.ts`.
 *
 * Everything goes through the `Memory` object, so a path is built and checked in exactly one place.
 *
 * Roles: reading settings is anyone's; changing them, running the pass, deciding proposals and
 * reindexing are an operator's; what cannot be undone (`forget`) is an admin's.
 */

import type { FailedEpisode, ForgetReport, MemoryChange, MemorySettings, MemoryStatus, PassReport, Proposal } from "@nouride/wire";
import type { FactsMode } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import { MEMORY_KEYS, type MemorySettings as StoredMemorySettings } from "@/modules/config/settings/memory.ts";
import type { MemoryField } from "@/modules/config/global/validate-memory.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NO_SETTINGS, NOT_SAVED, notSaved } from "../plain.ts";

/** Each setting a memory save can be refused for, as the Memory page names it. */
const MEMORY_FIELDS: Record<MemoryField, string> = {
  promptRecent: "the recent conversations in each prompt",
  transcriptDays: "the days a transcript is kept",
  passAt: "the time of the nightly pass",
  facts: "what the nightly pass may learn about people",
  passPerNight: "the conversations per night",
  // Its label is Tokens per night, a word the page keeps on its own line: said here by what it counts.
  passMaxTokens: "the nightly pass's limit on model use",
  maxAttempts: "the attempts per conversation",
  passProvider: "the helper model's provider",
  passModel: "the helper model",
  semanticDimensions: "the dimensions",
  semanticProvider: "the provider for search by meaning",
  semanticModel: "the embedding model",
};

/**
 * The routes that do their work before they answer — the pass, a reindex, a forget that rewrites
 * summaries — keep their connection past the server's 60-second idle timeout. On a Pi the
 * pass takes minutes, and the socket closing under it read to `nouride memory pass` as "Cannot reach
 * the daemon" while the pass carried on. 0 is no idle limit (Bun's own maximum is 255 seconds): each of
 * these is an operator's request with a bounded amount of work, and the caller keeps its own timeout.
 * The tag tidy's writes (`memory-tags.ts`) are the same kind of request.
 */
export const LONG_REQUEST_SECONDS = 0;

/** What each setting's JSON value must be. The value itself is checked by `validateMemory`. */
const SETTING_TYPES: Record<keyof StoredMemorySettings, "boolean" | "number" | "string" | "semantic"> = {
  pass: "boolean",
  passAt: "string",
  passPerNight: "number",
  passMaxTokens: "number",
  passProvider: "string",
  passModel: "string",
  maxAttempts: "number",
  facts: "string",
  proposeShared: "boolean",
  promptRecent: "number",
  recall: "boolean",
  transcriptDays: "number",
  archive: "boolean",
  semantic: "semantic",
};

const NESTED_TYPES: Record<"semantic", Record<string, "boolean" | "string" | "number">> = {
  semantic: { enabled: "boolean", provider: "string", model: "string", dimensions: "number" },
};

function settingOk(type: (typeof SETTING_TYPES)[keyof StoredMemorySettings], value: unknown): boolean {
  if (type === "semantic") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value as Record<string, unknown>).every(([key, item]) => NESTED_TYPES[type][key] === typeof item);
  }
  return typeof value === type;
}


export function registerMemoryRoutes(control: ControlApp, deps: ControlDeps): void {
  /** The refusal for a route that needs this role and memory wired, or null to go on. */
  function refusal(principal: Parameters<typeof atLeast>[0], role: "operator" | "admin", why = ""): [string, 403 | 503] | null {
    if (!atLeast(principal, role)) return [`${role} only${why}`, 403];
    if (!deps.memory) return ["memory is not wired in this process", 503];
    return null;
  }

  /**
   * The settings, and `[llm.context] summary_model` beside them, read-only: the model `pass_model` sets summarizes
   * long conversations too unless that one is set (`summarizerRoute`), and the card that sets it says which.
   */
  // `semantic` whole, from the config it is read from: the settings' own type is a change's, where it may be part.
  const view = (settings: NonNullable<ControlDeps["settings"]>) => ({ ...settings.memorySettings(), semantic: deps.ctx.config.memory.semantic, summaryModel: deps.ctx.config.llm.context.summaryModel ?? "" });

  control.get("/memory/settings", (c) => {
    if (!deps.settings) return c.json({ error: "there is no config file to read", plain: NO_SETTINGS }, 409);
    return c.json(view(deps.settings) satisfies MemorySettings);
  });

  control.put("/memory/settings", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    if (!deps.settings) return c.json({ error: "there is no config file to write", plain: NO_SETTINGS }, 409);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "body must be a JSON object" }, 400);

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      const type = SETTING_TYPES[key as keyof StoredMemorySettings];
      if (!type || !(key in MEMORY_KEYS)) return c.json({ error: `unknown memory setting "${key}"` }, 400);
      if (!settingOk(type, value)) {
        const want = type === "semantic" ? "an object of enabled, provider, model and dimensions" : `a ${type}`;
        return c.json({ error: `${key} must be ${want}` }, 400);
      }
      patch[key] = value;
    }
    const result = await deps.settings.setMemorySettings({ patch: patch as Partial<StoredMemorySettings>, actor: principal.actor });
    if (!result.ok) {
      const plain = result.probe ? "The embedding model did not answer, so search by meaning stays off. Check its provider and its name, and save again." : notSaved(result.field && MEMORY_FIELDS[result.field]);
      return c.json({ error: result.error, plain }, 400);
    }
    return c.json(view(deps.settings) satisfies MemorySettings);
  });

  /** One person's `facts` over `[memory] facts` — `null` follows it again. An operator's, like the rest. */
  control.put("/memory/people/:key/facts", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    if (!deps.settings) return c.json({ error: "there is no config file to write", plain: NO_SETTINGS }, 409);
    const body = await jsonBody(c);
    if (!body || !("facts" in body) || (body.facts !== null && typeof body.facts !== "string")) {
      return c.json({ error: "facts must be auto, ask, off, or null to follow the memory setting" }, 400);
    }
    const result = await deps.settings.setPersonFacts({ key: c.req.param("key"), facts: body.facts as FactsMode | null, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });

  /** Whether one person's memory goes into prompts, over `[memory] recall` — `null` follows it again. */
  control.put("/memory/people/:key/recall", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    if (!deps.settings) return c.json({ error: "there is no config file to write", plain: NO_SETTINGS }, 409);
    const body = await jsonBody(c);
    if (!body || !("recall" in body) || (body.recall !== null && typeof body.recall !== "boolean")) {
      return c.json({ error: "recall must be true, false, or null to follow the memory setting" }, 400);
    }
    const result = await deps.settings.setPersonRecall({ key: c.req.param("key"), recall: body.recall as boolean | null, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });

  /** Where memory stands: the pass, what waits for it and whether it keeps up, semantic search. */
  control.get("/memory/status", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const backlog = deps.memory!.backlog();
    return c.json({
      pass: deps.memoryPass?.status() ?? null,
      waiting: backlog.waiting,
      backlog,
      failed: deps.memory!.failed().length,
      semantic: deps.memory!.semanticStatus(),
      archive: deps.memory!.archiveSize(),
      index: deps.memory!.indexCheck(),
    } satisfies MemoryStatus);
  });

  control.post("/memory/pass", async (c) => {
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    if (!deps.memoryPass) return c.json({ error: "the nightly pass is not scheduled in this process" }, 503);
    const result = await deps.memoryPass.run();
    if ("refused" in result) {
      const plain =
        result.why === "off"
          ? "The nightly pass is turned off. Turn it on in Memory's settings, then run it."
          : result.why === "running"
            ? "A pass is already running. Wait for it to finish."
            : "Today's spending limit for AI use is reached, so the pass did not run. It can run tomorrow.";
      return c.json({ error: result.refused, plain }, 409);
    }
    deps.audit?.record({ action: "memory_pass_run", actor: principal.actor, details: { cut: result.report.cut, filed: result.report.filed, failed: result.report.failed.length } });
    return c.json(result.report satisfies PassReport);
  });

  /** Embed what has no vector yet — after turning semantic search on, or a night the embedder was down. */
  control.post("/memory/embed", (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    if (!deps.memory!.semanticStatus().enabled) {
      return c.json(
        {
          error: "semantic search is off: it needs [memory.semantic] enabled, provider and model",
          plain: "Search by meaning is off. Turn it on under Semantic search with an embedding model, then embed again.",
        },
        409,
      );
    }
    // Answered at once, the work in the background: hundreds of items against a local model take
    // minutes, and a request held that long is closed by the server's idle timeout.
    deps.audit?.record({ action: "memory_embed_started", actor: principal.actor });
    void deps.memory!.embedCatchUp().catch(() => null);
    return c.json({ started: true, ...deps.memory!.semanticStatus() } satisfies { started: boolean; items: number }, 202);
  });

  // Operator-only: a proposal is a fact about a person, not yet approved.
  control.get("/memory/proposals", async (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    return c.json({ proposals: await deps.memory!.proposals() } satisfies { proposals: Proposal[] });
  });

  for (const verb of ["approve", "deny"] as const) {
    control.post(`/memory/proposals/:id/${verb}`, async (c) => {
      const principal = c.get("principal");
      const no = refusal(principal, "operator");
      if (no) return c.json({ error: no[0] }, no[1]);
      const id = c.req.param("id");
      let decision;
      try {
        decision = verb === "approve" ? await deps.memory!.approve(id) : await deps.memory!.deny(id);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err), plain: "That is not a proposal Nouride knows. Reload the list." }, 400);
      }
      if (decision.status === "refused") return c.json({ error: decision.reason, plain: "Nothing changed: the proposal is gone or its fact changed since. Reload the list." }, 409);
      deps.audit?.record({ action: `memory_proposal_${decision.status}`, actor: principal.actor, details: { id, subject: decision.subject } });
      return c.json({ id, ...decision });
    });
  }

  /** What changed in memory and why, newest first — facts change without asking, so this is how a person checks. */
  control.get("/memory/changes", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const subject = c.req.query("subject") || undefined;
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json({ changes: deps.memory!.changes({ ...(subject ? { subject } : {}), limit }) } satisfies { changes: MemoryChange[] });
  });

  control.get("/memory/failed", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    return c.json({ failed: deps.memory!.failed() } satisfies { failed: FailedEpisode[] });
  });

  control.post("/memory/retry", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const body = (await jsonBody(c)) ?? {};
    const episode = typeof body.episode === "string" && body.episode ? body.episode : undefined;
    deps.memory!.retry(episode);
    deps.audit?.record({ action: "memory_retry", actor: principal.actor, details: { episode: episode ?? null } });
    return c.json({ episode: episode ?? null } satisfies { episode: string | null });
  });

  control.post("/memory/reindex", async (c) => {
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const report = await deps.memory!.reindex();
    deps.audit?.record({ action: "memory_reindexed", actor: principal.actor, details: { episodes: report.episodes, profiles: report.profiles, problems: report.problems.length } });
    return c.json(report);
  });

  control.post("/memory/forget", async (c) => {
    c.env?.keepOpen?.(LONG_REQUEST_SECONDS);
    const principal = c.get("principal");
    const no = refusal(principal, "admin", ": forgetting cannot be undone");
    if (no) return c.json({ error: no[0] }, no[1]);
    const body = await jsonBody(c);
    if (typeof body?.person !== "string") return c.json({ error: "person is required, by key" }, 400);
    const mode = body.mode === "anonymize" ? "anonymize" : body.mode === "forget" ? "forget" : null;
    if (!mode) return c.json({ error: 'mode is "forget" (rewrite what mentions them) or "anonymize" (hide their name)' }, 400);
    const result = await deps.memory!.forget(body.person, mode, mode === "forget" ? deps.memoryPass?.ask : undefined);
    if ("refused" in result) return c.json({ error: result.refused, plain: "Nothing was forgotten: Nouride does not know that person." }, 400);
    deps.audit?.record({ action: "memory_forgotten", actor: principal.actor, details: { person: body.person, mode, episodes: result.episodesDeleted, rewritten: result.summariesRewritten } });
    return c.json({ person: body.person, mode, ...result } satisfies ForgetReport);
  });
}
