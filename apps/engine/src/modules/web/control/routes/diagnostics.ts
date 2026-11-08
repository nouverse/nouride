/**
 * What the daemon is doing and what it has done: status, usage, logs, MCP connections, the audit
 * trail — and the one route that stops it.
 */

import { identityLine } from "@/modules/router/agent-mentions.ts";
import { tierModel, type LogLevel } from "@nouride/shared";
import { isRetentionScope } from "@/modules/config/settings/memory.ts";
import { atLeast } from "@/modules/users/auth.ts";
import { statFile } from "@nouride/runtime";
import { groupAdvisories, readAdvisories } from "@/boot/advisories.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { contextWindowFor } from "@/modules/llm/executor/context-window.ts";
import { helperTrouble } from "@/modules/llm/helper-trouble.ts";
import { cachedShare, cacheWarnings, usdPerMillion } from "@/modules/llm/cache-routes.ts";
import { INCOMPLETE, NO_SETTINGS, notSaved } from "../plain.ts";

/** Days a route's cache is judged over, at least — a starting value (TOKEN_SAVINGS §3.1). */
const ROUTE_DAYS = 7;

export function registerDiagnosticRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * Tokens and cost.
   *
   * `unpricedRequests` is reported alongside the total rather than folded into it: a model with no
   * entry in the price book contributes nothing to `usd`, and a spend figure that silently omits an
   * unknown number of requests is worse than one that says how much it is missing.
   */
  control.get("/usage", (c) => {
    if (!deps.usage) return c.json({ error: "usage recording is not available" }, 501);
    const days = Math.min(90, Math.max(1, Number.parseInt(c.req.query("days") ?? "1", 10) || 1));
    const from = Date.now() - days * 24 * 60 * 60 * 1000;
    // Each route's cache over a week at least (TOKEN_SAVINGS §3.1): a day's few calls a route say little about it.
    const routeDays = Math.max(days, ROUTE_DAYS);
    const routes = deps.usage.routes(Date.now() - routeDays * 24 * 60 * 60 * 1000);
    return c.json({
      days,
      total: deps.usage.since(from),
      recent: deps.usage.recent(50),
      routeDays,
      routes: routes.map((route) => ({ ...route, cachedShare: cachedShare(route), usdPerMillion: usdPerMillion(route) })),
      cacheWarnings: cacheWarnings(routes),
    });
  });

  /**
   * What the last boot said about how this install is set up (`boot/advisories.ts`), one line per thing said with the
   * agents it was said about. Said at warn once and at info after, an advisory is otherwise only in the journal.
   */
  control.get("/advisories", (c) => {
    return c.json({ advisories: groupAdvisories(readAdvisories(deps.state?.get("advisories") ?? null)) });
  });

  /**
   * Recent log lines.
   *
   * The journal remains the full history; this is the window debugging actually uses, available on
   * every platform and over the network. `oldest`/`latest` are returned so a caller can tell whether
   * it has fallen behind the ring rather than silently missing lines.
   */
  control.get("/logs", (c) => {
    if (!deps.logs) return c.json({ error: "log buffer is not enabled" }, 501);

    const level = c.req.query("level");
    const since = Number.parseInt(c.req.query("since") ?? "", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);

    return c.json({
      entries: deps.logs.query({
        ...(level === "debug" || level === "info" || level === "warn" || level === "error"
          ? { minLevel: level }
          : {}),
        ...(c.req.query("component") ? { component: c.req.query("component")! } : {}),
        ...(Number.isFinite(since) ? { since } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
      oldest: deps.logs.oldestSeq(),
      latest: deps.logs.latestSeq(),
    });
  });

  /**
   * The log as it is on disk — what System Logs reads.
   *
   * Separate from `/logs` above rather than replacing it. That one answers "what has happened since
   * sequence N", which is what a follower like `nouride logs -f` needs and what the in-memory ring is
   * shaped for. This one answers "show me the last few days, filtered, searchable, and still there
   * after a restart", which a ring structurally cannot.
   */
  control.get("/logs/stored", (c) => {
    if (!deps.logStore) return c.json({ error: "log storage is not enabled" }, 501);

    const level = c.req.query("level");
    const before = Number.parseInt(c.req.query("before") ?? "", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    // Narrowed to the three levels the table holds — `debug` is not stored, so accepting it here
    // would answer an empty list to a filter that looks like it should work.
    const minLevel: LogLevel | undefined =
      level === "info" || level === "warn" || level === "error" ? level : undefined;
    const query = {
      ...(minLevel ? { minLevel } : {}),
      ...(c.req.query("component") ? { component: c.req.query("component")! } : {}),
      ...(c.req.query("q")?.trim() ? { search: c.req.query("q")!.trim() } : {}),
    };

    const entries = deps.logStore.query({
      ...query,
      ...(Number.isFinite(before) && before > 0 ? { before } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });

    return c.json({
      entries,
      // The count for *these* filters, so "1 of 12,904" is the real denominator rather than the page.
      total: deps.logStore.count(query),
      // The cursor for the next page. Absent means this was the last one — the daemon decides that,
      // because it is the only thing that knows the page was full.
      ...(entries.length === (Number.isFinite(limit) ? limit : 200)
        ? { nextBefore: entries[entries.length - 1]!.id }
        : {}),
      components: deps.logStore.components(),
      span: deps.logStore.span(),
      retentionDays: deps.ctx.config.retention.logDays,
    });
  });

  /**
   * Every retention window, and the one route that changes them.
   *
   * All of them are asked for and set through here rather than one endpoint per record, because they
   * are one question — how long does this install keep what it wrote down — asked about several
   * different things. And they hold deliberately different answers: the audit log is one row per
   * decision and worth keeping; the daemon log is every line it printed; and conversation history
   * has no second copy anywhere, so it has the widest ceiling and the most consequential mistake.
   */
  control.get("/retention", (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    return c.json({ windows: deps.settings.retentionWindows() });
  });

  control.put("/retention/:scope", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const scope = c.req.param("scope");
    // Checked against the settings module's own list rather than a chain of comparisons here. The
    // chain was a second copy of that list, and adding a window left this route rejecting it.
    if (!isRetentionScope(scope)) {
      return c.json({ error: `unknown retention scope "${scope}"` }, 400);
    }

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.settings.setRetentionDays({
      scope,
      days: Number(body.days),
      actor: principal.user?.username ?? principal.kind,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the number of days") }, 400);
    return c.json({ windows: deps.settings.retentionWindows() });
  });

  /** Which MCP servers connected, and what they offered. */
  control.get("/mcp", (c) => {
    if (!deps.mcp) return c.json({ servers: [] });
    return c.json({ servers: deps.mcp.status() });
  });

  control.get("/status", (c) => {
    const gateways = [...deps.ctx.gateways.values()].filter((gateway) => !gateway.internal).map((gateway) => ({
      id: gateway.id,
      platform: gateway.platform,
      status: gateway.status,
    }));

    return c.json({
      status: deps.ctx.status,
      uptime: Math.round((Date.now() - deps.ctx.startedAt) / 1000),
      // Turns in flight with a journal, and messages waiting in the inbox.
      durable: deps.pipeline.inbox.durability(),
      // What keeps the *daemon* alive. `nouride service status` asks for this rather than looking at
      // its own process: run from a shell, that one is never supervised, and the answer was always "none".
      supervisor: deps.supervisor?.() ?? { kind: "none", restartsOnExit: false },
      configSource: deps.ctx.configSource,
      dataDir: deps.ctx.config.daemon.dataDir,
      // Who answers a message that names no agent, and is the front desk of rooms (`default_agent` before 0.7.18).
      orchestrator: deps.ctx.config.daemon.orchestrator ?? null,
      agents: deps.registry.all().map((agent) => ({
        id: agent.config.id,
        displayName: agent.config.displayName,
        // What it is for, as its peers read it: the `Headline:` line of its IDENTITY.md, or the line standing in for one.
        headline: identityLine(agent.persona.identity) ?? null,
        enabled: agent.config.enabled,
        // When the daemon first saw it (0.8.1): the order agents were made in, for Nouride Office's first few.
        since: deps.agentsSeen?.since(agent.config.id) ?? null,
        state: deps.registry.status(agent.config.id),
        // What it is doing now: waiting for you, working, paused or idle, and why it could not work if asked (0.7.18).
        activity: deps.pipeline.agentStatus(agent.config.id),
        provider: agent.config.llm.provider,
        model: agent.config.llm.model,
        // Who answers when the model cannot, in order (§3.1) — empty for none.
        fallbacks: agent.config.llm.fallbacks ?? [],
        // How long its model thinks, `[llm] effort` or `[llm.defaults] effort`, and the install's (0.8.17): the Model tab
        // chooses it, as an external agent's CLI tab does.
        effort: agent.config.llm.effort ?? null,
        effortDefault: deps.ctx.config.llm.defaults.effort ?? null,
        /**
         * Its small and high tiers (0.8.0): the pack's own — null when it inherits — and the model it inherits, the
         * install's on the install's provider and its own model elsewhere. Both, so the form can show what it follows.
         */
        tiers: Object.fromEntries(
          (["small", "high"] as const).map((tier) => [
            tier,
            {
              own: (tier === "small" ? agent.config.llm.smallModel : agent.config.llm.highModel) ?? null,
              inherits: tierModel({ provider: agent.config.llm.provider, model: agent.config.llm.model }, deps.ctx.config.llm.defaults, tier),
            },
          ]),
        ),
        // What its turns are budgeted at, and where the number comes from — `doctor` says when it is a 32k guess (G2).
        contextWindow: contextWindowFor({
          model: agent.config.llm.model,
          packModel: agent.config.llm.model,
          ...(agent.config.llm.contextWindow !== undefined ? { declared: agent.config.llm.contextWindow } : {}),
          stated: deps.providers.catalog?.windowNow(agent.config.llm.provider, agent.config.llm.model) ?? null,
        }),
        /**
         * What the pack says, not what the turn resolves to — null means "follows the daemon".
         *
         * The dashboard needs the distinction to render the control: a field showing 25 cannot
         * tell you whether this agent is pinned at 25 or tracking a default that happens to be 25,
         * and those behave differently the moment somebody changes the global.
         */
        maxToolIterations: agent.config.llm.maxToolIterations ?? null,
        // Seconds, and null for "follows the daemon" — the same distinction, for the same reason:
        // a field showing 300 cannot tell you whether this agent is pinned there or tracking a
        // default that happens to be 300, and those behave differently the moment somebody moves it.
        maxTurnSeconds:
          agent.config.llm.maxTurnDurationMs === undefined
            ? null
            : Math.round(agent.config.llm.maxTurnDurationMs / 1000),
        // Minutes, null for "follows the daemon" — the distinction the two budgets above draw.
        jobQuietAfterMinutes: agent.config.jobQuietAfterMinutes ?? null,
        // Helpers in the background at once, null for "follows the daemon" (0.7.15).
        maxBackgroundHelpers: agent.config.maxBackgroundHelpers ?? null,
        // Missions working at once, null for "follows the daemon" (0.8.11).
        missionsPerAgent: agent.config.missionsPerAgent ?? null,
        tools: agent.config.tools.enabled,
        // What the pack says, not the resolved level: this is the agent's own posture, and the
        // dashboard's job here is to show and change that rather than to compute what one person sees.
        approvals: agent.config.approvals ?? "per-person",
        // The same for whether its connections take new senders: `follow` defers to `[security.access]`.
        access: agent.config.access ?? "follow",
        // Whether it installs the programs every agent runs, as the orchestrator (0.8.0). On unless off; counts only there.
        sharedTools: agent.config.sharedTools !== false,
        // The second look (0.8.0): this pack's own `model_guard`, null when it follows the daemon's — and the daemon's.
        secondLook: { own: agent.config.modelGuard ?? null, install: deps.ctx.config.security.modelGuard },
        skills: agent.skills.map((s) => s.name),
        // An external agent (0.8.1): the coding CLI that answers it, by id and as it is called, the profile it is signed in
        // on, and whether its Nouride skills reach the CLI (`skillsDir`) — its Skills tab says so where they do not. Its
        // model is the pack's `[external] model`, else the CLI's own default as its last session named it: `model` above
        // is its `[llm]`, which answers none of its turns, and the agent picker showed it as the agent's.
        ...(agent.config.external
          ? (() => {
              const external = agent.config.external;
              const row = deps.externalAgents?.row(external.cli);
              return {
                external: {
                  cli: external.cli,
                  name: row?.name ?? external.cli,
                  profile: external.profile ?? "default",
                  skills: Boolean(row?.skillsDir),
                  model: external.model ?? null,
                  cliDefault: deps.externalAgents?.models.runsOn(agent.config.id) ?? null,
                },
              };
            })()
          : {}),
        // Its cat in Nouride Office (0.8.1): the parts its pack picks; the page fills the rest from its id.
        ...(agent.config.look ? { look: agent.config.look } : {}),
        // Resolved and checked, so `doctor` can report a root that does not exist. A missing root is
        // silent at every other layer: the agent starts, the tools work, and every path inside it is
        // simply refused — which reads as the agent being broken rather than the config being wrong.
        workspaceRoots: agent.config.workspaceRoots.map((root) => ({
          path: root,
          exists: statFile(root)?.isDirectory === true,
        })),
      })),
      failures: deps.registry.loadFailures(),
      providers: deps.providers.available(),
      gateways,
      queue: deps.pipeline.stats(),
      pendingApprovals: deps.approvals.pending().length,
      // What compaction and the memory pass ran into with their models in the last day, the provider's own words
      // included — doctor says each with its fix. `/health` says them without those words: anybody reaches it.
      helpers: deps.logStore ? helperTrouble(deps.logStore, deps.ctx.config, Date.now()) : [],
    });
  });

  control.get("/audit", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
    return c.json({
      entries: deps.audit.recent(Number.isNaN(limit) ? 50 : Math.min(limit, 500), c.req.query("agent")),
    });
  });

  /**
   * The dashboard's Restart, and `nouride restart`: once nothing is running — turns, the queue, approvals,
   * background jobs — unless `now`, and with the turn `then` asks for when it is back. The same path as
   * `/daemon-restart` in a chat; see `modules/update/restart.ts` for why it waits and when the follow-up is armed.
   */
  control.post("/restart", async (c) => {
    if (!deps.restart) return c.json({ error: "restart is not available" }, 409);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
    const [agentId, gatewayId, chatId, then] = [text("agent_id"), text("gateway_id"), text("chat_id"), text("then")];
    // All three or none, as `/update/apply` asks: two of three is a follow-up aimed at no conversation.
    const aimed = [agentId, gatewayId, chatId].filter(Boolean).length;
    if (aimed !== 0 && (aimed !== 3 || !then)) {
      return c.json({ error: "give then, agent_id, gateway_id and chat_id together, or none of them", plain: INCOMPLETE }, 400);
    }
    // As `/cron` refuses one: a follow-up for an agent that does not exist fires into nothing.
    if (aimed === 3 && !deps.registry.get(agentId)) return c.json({ error: `no agent "${agentId}": a follow-up must name one that exists` }, 400);
    const seconds = typeof body.in_seconds === "number" ? Math.min(3600, Math.max(1, Math.floor(body.in_seconds))) : undefined;

    const outcome = deps.restart.request({
      by: c.get("principal").actor,
      now: body.now === true,
      force: body.force === true,
      ...(aimed === 3 ? { followUp: { kind: "turn", agentId, gatewayId, chatId, message: then, ...(seconds ? { delaySeconds: seconds } : {}) } } : {}),
    });
    // Worded for the page from what the restart said (0.8.20): its own words name a service, a container and a flag.
    if (!outcome.ok) {
      const plain =
        outcome.why === "no-restarter"
          ? "Nouride was not restarted: nothing on this server would start it again. Whoever runs the server can restart it there."
          : "Nouride was not restarted: the message for when it is back could not be planned.";
      return c.json({ error: outcome.error, supervisor: outcome.supervisor, ...(outcome.note ? { note: outcome.note } : {}), plain }, 409);
    }
    return c.json({
      ok: true,
      supervisor: outcome.supervisor,
      waiting: outcome.waiting,
      note: outcome.note,
      plain: outcome.waitingFor
        ? "Nouride restarts once its background work is done, however long that takes."
        : outcome.waiting
          ? "Nouride restarts as soon as nothing is running, within ten minutes."
          : "Nouride is restarting now.",
      ...(outcome.followUpSeconds ? { wake_in_seconds: outcome.followUpSeconds } : {}),
    });
  });
}
