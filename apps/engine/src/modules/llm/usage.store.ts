/**
 * What the model actually cost.
 *
 * The oldest debt in this daemon: `llm_usage` was created in the first migration, given two indexes,
 * and never received a row. `onUsage` wrote a debug log line and nothing else — so `max_daily_cost_usd`
 * described a budget nobody could enforce, and it was defaulted to `0` with a boot warning rather than
 * left implying a cap that did not exist. This is the other half of that.
 *
 * Two rules carry over from how the numbers arrive:
 *
 * - **An unpriced model is recorded unpriced**, as `NULL`, not as `0`. A zero in a cost column is a
 *   free request, and a day of those sums to a spend of nothing — which is exactly how a cap fails
 *   open. Nougate's OpenAI-compatible path already sends no `usage` field at all; inventing numbers
 *   on top of that would compound a silence into a false statement.
 * - **Estimated token counts stay marked as estimates.** They are recorded, because an estimate is
 *   more useful than a blank, and the flag is what stops the total being read as measured.
 *
 * And a third, since 0.7.8: **a call on a subscription is included, not spent.** A provider profile that says
 * `billing = "included"` — Nougate's OAuth accounts — costs nothing per token, so its calls cost 0 and say why
 * (`basis`): outside the dollar cap, still inside the token cap, and never a list price shown as money spent.
 *
 * And a fourth, since 0.8.8: **a coding CLI's prompt is its own account's.** What it reports over ACP is recorded, so
 * `/status` and a turn's record say what it spent, as `basis = 'cli'` with a cost of 0 — and is outside both caps: the
 * CLI runs on its own subscription, and its hours of work stopped every agent on the daemon's own models at the token
 * cap otherwise (the owner's decision, 2026-10-29).
 */

import { createLogger, newId, type TokenUsage, type Port, type StopReason, type UsageBasis, type UsagePurpose } from "@nouride/shared";
import { estimateCost } from "@nouride/llm";
import type { SqliteDb } from "@nouride/runtime";
import type { EventsPort } from "@/modules/events/events.store.ts";
import type { UsageRoute } from "./cache-routes.ts";

const log = createLogger("llm.usage");

export interface UsageRecord {
  agentId: string;
  model: string;
  provider: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the counts were computed here rather than reported by the provider. */
  estimated?: boolean;
  /**
   * Input tokens the provider served from its cache. Already inside `inputTokens` — see `TokenUsage`.
   *
   * Absent when the provider reported nothing, which is stored as NULL rather than 0: "no hits" and
   * "did not say" are different facts, and only one of them means caching is not working.
   */
  cachedInputTokens?: number;
  /** Input tokens written to the cache this request, at a 25% premium. Also inside `inputTokens`. */
  cacheCreationInputTokens?: number;
  /** The turn this call was made for (D2). Absent for what no turn made: the nightly pass, an embedding. */
  turnId?: string;
  /** The call as the turn waited on it, retries included — what the provider reported with its usage. */
  latencyMs?: number;
  /** HTTP attempts it took: 1 unless the provider refused or timed out and was asked again. */
  attempts?: number;
  /** Who answered, when a gateway in between said (G1) — `TokenUsage.upstream`. */
  upstream?: TokenUsage["upstream"];
  /** What the call was for (`USAGE_PURPOSES`). Absent on a caller that predates it, read as the turn's own. */
  purpose?: UsagePurpose;
  /** A call billed by time — a clip transcribed — and how long it was. Its tokens are 0 and say nothing. */
  durationMs?: number;
  /**
   * Why the provider says the call ended (`TokenUsage.stopReason`, `069_baseline.sql`). NULL when it said
   * nothing, and on a call that is no generation — an embedding, a clip transcribed: never a guessed `stop`.
   */
  stopReason?: StopReason;
  /** A coding CLI's prompt (`TokenUsage.cli`): on its own account, outside both caps. */
  cli?: true;
}

/**
 * The counts whose *absence* is a fact, ready to spread into a `record()` call.
 *
 * Every one of these is optional for the same reason: a missing field means the provider said
 * nothing, and that is not the same statement as zero. Written once because it was written four
 * times — once per thing that runs a turn — and a fourth spread added to three of them is how the
 * two halves of the cache accounting end up disagreeing about which turns had caching at all.
 *
 * Why the call ended rides along (0.7.26): every caller already spreads this, so a stop reason the provider gave
 * reaches `llm_usage` from every one of them — and a caller that wrote its own would be the one that forgot.
 */
export function reportedCounts(
  usage: TokenUsage,
): Pick<UsageRecord, "estimated" | "cachedInputTokens" | "cacheCreationInputTokens" | "latencyMs" | "attempts" | "upstream" | "stopReason"> {
  return {
    ...(usage.upstream === undefined ? {} : { upstream: usage.upstream }),
    ...(usage.stopReason === undefined ? {} : { stopReason: usage.stopReason }),
    ...(usage.latencyMs === undefined ? {} : { latencyMs: usage.latencyMs }),
    ...(usage.attempts === undefined ? {} : { attempts: usage.attempts }),
    ...(usage.estimated === undefined ? {} : { estimated: usage.estimated }),
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
  };
}

export interface DailySpend {
  /** Dollars for models that are in the price book. */
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, how many came from the provider's cache. */
  cachedInputTokens: number;
  /**
   * Of `inputTokens`, how many were written to the cache.
   *
   * Read against `cachedInputTokens`, not on its own. Writes far larger than reads, sustained, is the
   * signature of a breakpoint placed after content that changes every request — paying the 25%
   * premium for entries nothing comes back for.
   */
  cacheCreationInputTokens: number;
  /** Requests whose model has no price, so `usd` is missing that much. */
  unpricedRequests: number;
  /** Requests through a subscription (`billing = "included"`): no cost per token, so `usd` is not missing them. */
  includedRequests: number;
  requests: number;
}

/** One agent and model's share of a day's spend (`UsageStore.spenders`). */
export interface Spender {
  agentId: string;
  model: string;
  usd: number;
  tokens: number;
}

export class UsageStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
    /** A turn's model calls also go here, as they are metered — the event stream, in the same transaction. */
    private readonly stream?: Pick<EventsPort, "append" | "batch">,
    /** How a provider profile bills (`ProviderProfile.billing`) — read per call, so a changed profile counts at once. */
    private readonly billingOf: (provider: string) => "metered" | "included" = () => "metered",
  ) {}

  record(entry: UsageRecord): void {
    const included = entry.cli !== true && this.billingOf(entry.provider) === "included";
    // Priced at the moment it was made: a price with a date on it is the one that held then.
    const cost = entry.cli || included ? { usd: 0, unpriced: false } : estimateCost(entry.model, entry as TokenUsage, this.now());
    const basis: UsageBasis = entry.cli ? "cli" : included ? "included" : cost.unpriced ? "unpriced" : "list";
    const write = (): void => {
      this.db
        .prepare(
          `INSERT INTO llm_usage (id, agent_id, session_id, turn_id, model, provider, input_tokens,
                                  output_tokens, cached_input_tokens, cache_creation_input_tokens,
                                  estimated_cost_usd, latency_ms, attempts, upstream_provider, upstream_model,
                                  upstream_attempts, purpose, basis, estimated, duration_ms, stop_reason, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId("use"),
          entry.agentId,
          entry.sessionId ?? null,
          entry.turnId ?? null,
          entry.model,
          entry.provider,
          entry.inputTokens,
          entry.outputTokens,
          // NULL when the provider said nothing about caching. See the column comment.
          entry.cachedInputTokens ?? null,
          entry.cacheCreationInputTokens ?? null,
          // NULL, not 0. See the header — a zero here is a free request, and it makes a cap fail open.
          cost.unpriced ? null : cost.usd,
          entry.latencyMs ?? null,
          entry.attempts ?? null,
          entry.upstream?.provider ?? null,
          entry.upstream?.model ?? null,
          entry.upstream?.attempts ?? null,
          entry.purpose ?? null,
          basis,
          entry.estimated === undefined ? null : entry.estimated ? 1 : 0,
          entry.durationMs ?? null,
          // NULL when the provider gave no reason — never a guessed `stop` (`TokenUsage.stopReason`).
          entry.stopReason ?? null,
          this.now(),
        );
      if (entry.turnId && this.stream) {
        // The turn's own connection and chat, as its other rows have them: a reader following one conversation gets
        // its model calls too — a helper's or a peer's, metered under the turn that asked, in that turn's chat.
        const where = this.db
          .prepare<{ gateway_id: string; chat_id: string }>("SELECT gateway_id, chat_id FROM turn_records WHERE id = ?")
          .get(entry.turnId);
        this.stream.append({
          kind: "usage",
          turnId: entry.turnId,
          agentId: entry.agentId,
          ...(where ? { gatewayId: where.gateway_id, chatId: where.chat_id } : {}),
          data: {
            model: entry.model,
            provider: entry.provider,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            ...(cost.unpriced ? {} : { usd: cost.usd }),
            ...reportedCounts(entry as TokenUsage),
            ...(entry.purpose ? { purpose: entry.purpose } : {}),
            basis,
            ...("asOf" in cost && cost.asOf ? { priceAsOf: cost.asOf } : {}),
            ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
          },
        });
      }
    };

    try {
      if (this.stream) this.stream.batch(write);
      else write();
    } catch (err) {
      // Accounting must never take down a turn that already succeeded. The answer has been produced
      // and, on a chat platform, already sent; failing here would turn a bookkeeping problem into a
      // user-visible one.
      log.error("could not record llm usage", { error: String(err), agent_id: entry.agentId });
    }
  }

  /**
   * Spend since a wall-clock moment, for the whole daemon or one agent.
   *
   * Takes the boundary as an argument rather than computing "today": what counts as a day depends on a
   * timezone this store has no business knowing, and a cap that resets at a surprising hour is worse
   * than one that resets where the operator said.
   *
   * A coding CLI's prompts are not in it: they are its own account's, outside both caps (0.8.8).
   */
  since(from: number, agentId?: string): DailySpend {
    const byAgent = agentId ? " AND agent_id = ?" : "";
    const row = this.db
      .prepare<{
        usd: number | null;
        input: number | null;
        output: number | null;
        cached: number | null;
        written: number | null;
        unpriced: number;
        included: number;
        requests: number;
      }>(
        `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS usd,
                COALESCE(SUM(input_tokens), 0)       AS input,
                COALESCE(SUM(output_tokens), 0)      AS output,
                COALESCE(SUM(cached_input_tokens), 0) AS cached,
                COALESCE(SUM(cache_creation_input_tokens), 0) AS written,
                SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
                SUM(CASE WHEN basis = 'included' THEN 1 ELSE 0 END) AS included,
                COUNT(*) AS requests
           FROM llm_usage
          WHERE timestamp >= ? AND basis IS NOT 'cli'${byAgent}`,
      )
      .get(...(agentId ? [from, agentId] : [from]));

    return {
      usd: row?.usd ?? 0,
      inputTokens: row?.input ?? 0,
      outputTokens: row?.output ?? 0,
      cachedInputTokens: row?.cached ?? 0,
      cacheCreationInputTokens: row?.written ?? 0,
      unpricedRequests: row?.unpriced ?? 0,
      includedRequests: row?.included ?? 0,
      requests: row?.requests ?? 0,
    };
  }

  /**
   * Each profile and model since a moment — what `cacheWarnings` compares (TOKEN_SAVINGS §3.1, 0.8.13): its requests,
   * its input, and how much of the input that reported a cache came from it. A coding CLI's prompts are its own
   * account's, and an embedding or a transcription is no prompt: none of them is a route here.
   */
  routes(from: number): UsageRoute[] {
    return this.db
      .prepare<UsageRoute>(
        `SELECT provider, model, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
                COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens END), 0) AS reportedInputTokens,
                SUM(estimated_cost_usd) AS usd
           FROM llm_usage
          WHERE timestamp >= ? AND basis IS NOT 'cli' AND (purpose IS NULL OR purpose NOT IN ('embedding', 'transcription'))
          GROUP BY provider, model
          ORDER BY inputTokens DESC`,
      )
      .all(from);
  }

  /**
   * Who spent the most since a moment: each agent and model, by dollars and then tokens — what a spend alert names, so
   * the operator knows where to look without opening the dashboard. Of what the caps count: a CLI's prompts are not.
   */
  spenders(from: number, limit = 3): Spender[] {
    return this.db
      .prepare<Spender>(
        `SELECT agent_id AS agentId, model,
                COALESCE(SUM(estimated_cost_usd), 0) AS usd,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS tokens
           FROM llm_usage
          WHERE timestamp >= ? AND basis IS NOT 'cli'
          GROUP BY agent_id, model
          ORDER BY usd DESC, tokens DESC
          LIMIT ?`,
      )
      .all(from, limit);
  }

  /**
   * Aggregated token usage for a session since a point in time (typically `startedAt`), plus what
   * the most recent request alone cost on the way in.
   *
   * The last input is here because the totals cannot answer the question people actually ask of
   * them. `/status` showed "Messages in context: 11 (~490 tokens)" beside "133.6k in", and the two
   * look like they should agree and do not: the 490 is the transcript, and what is *sent* is the
   * transcript plus the system prompt — which on a real agent is the overwhelming majority of it.
   * Read together they suggest the billing is broken. This is the measured number, from the
   * provider's own accounting, for one reply.
   *
   * `MAX(timestamp)` rather than `ORDER BY … LIMIT 1` over a subquery: one pass, and the index on
   * `(session_id, timestamp)` serves it.
   */
  forSession(
    sessionId: string,
    since: number,
    /**
     * A coding CLI's prompts alone (0.8.8): `/status` says them as the CLI's, outside the caps — and a turn its agent's own
     * model answered, the CLI being signed out, is neither (Nox's review).
     */
    onlyCli = false,
  ): {
    inputTokens: number;
    outputTokens: number;
    lastInputTokens: number;
    /** Cached input over the session, or **null when no request reported any figure at all**. */
    cachedInputTokens: number | null;
  } {
    /**
     * `COUNT` beside `SUM`, because the column is nullable on purpose.
     *
     * `SUM` cannot tell "every request reported zero cache hits" from "no request said anything
     * about caching", and those mean opposite things to somebody reading a bill. Gemini behind a
     * gateway that never maps `cachedContentTokenCount` is the second case: it may well be caching,
     * and nothing here can see it. `COUNT` of a nullable column counts only the rows that answered.
     */
    const row = this.db
      .prepare<{ input: number | null; output: number | null; cached: number | null; reported: number }>(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cached_input_tokens), 0) AS cached,
                COUNT(cached_input_tokens) AS reported
           FROM llm_usage
          WHERE session_id = ? AND timestamp >= ? AND (? = 0 OR basis = 'cli')`,
      )
      .get(sessionId, since, onlyCli ? 1 : 0);

    // The last of the turn's own calls: a summary or a reflection metered under the session is not a reply.
    const last = this.db
      .prepare<{ input: number | null }>(
        `SELECT input_tokens AS input
           FROM llm_usage
          WHERE session_id = ? AND timestamp >= ? AND (purpose IS NULL OR purpose = 'turn') AND (? = 0 OR basis = 'cli')
          ORDER BY timestamp DESC
          LIMIT 1`,
      )
      .get(sessionId, since, onlyCli ? 1 : 0);

    return {
      inputTokens: row?.input ?? 0,
      outputTokens: row?.output ?? 0,
      lastInputTokens: last?.input ?? 0,
      cachedInputTokens: (row?.reported ?? 0) > 0 ? (row?.cached ?? 0) : null,
    };
  }

  /**
   * Tokens a conversation's helpers spent since a moment (0.8.7) — `purpose = 'helper'`, metered under the session that
   * started them, in the foreground and behind it: what a mission adds to its own count beside its turns'.
   */
  helperTokens(sessionId: string, since: number): number {
    const row = this.db
      .prepare<{ total: number | null }>(
        "SELECT COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total FROM llm_usage WHERE session_id = ? AND purpose = 'helper' AND timestamp >= ?",
      )
      .get(sessionId, since);
    return row?.total ?? 0;
  }

  /** Rows since a moment, newest first. What the dashboard renders. */
  recent(limit = 50): {
    agentId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    at: number;
  }[] {
    return this.db
      .prepare<{
        agent_id: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        estimated_cost_usd: number | null;
        timestamp: number;
      }>("SELECT * FROM llm_usage ORDER BY timestamp DESC LIMIT ?")
      .all(limit)
      .map((row) => ({
        agentId: row.agent_id,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: row.estimated_cost_usd,
        at: row.timestamp,
      }));
  }

  /**
   * Delete rows older than `days`.
   *
   * Swept on the same schedule as attachments. Usage rows are small, but this table gets one per
   * provider call for the life of the installation, and "small × forever" is how a single-file
   * database becomes something nobody can back up.
   */
  sweep(days: number): number {
    if (days <= 0) return 0;
    return this.db
      .prepare("DELETE FROM llm_usage WHERE timestamp < ?")
      .run(this.now() - days * 24 * 60 * 60 * 1000).changes;
  }
}

/**
 * What each provider call cost, as the daemon depends on it.
 *
 * Business logic takes this, never `UsageStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type UsagePort = Port<UsageStore>;
