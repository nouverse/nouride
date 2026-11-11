/**
 * External agents' CLIs (0.8.1): which this box has, and one agent's CLI — its settings,
 * why it cannot answer, and its sign-in, run in a terminal on the box and answered from here a line at a time.
 *
 * **Admin only for the sign-in.** It signs an account in on the box, and what is typed into it is a code that does.
 *
 * **Audited (0.8.9):** an account added, removed, and a shared account's sign-in that kept a token, each
 * with who did it and which CLI and account — never a token or any part of one. An account that vanished from the page
 * with its secret still kept could not be told from a failed delete without them.
 */

import type { AgentCli, CliAccountsView, CliLoginView, CliProfile, CliRoom, ScannedCli } from "@nouride/wire";
import { PROFILE_NAME } from "@nouride/persona";
import { EXTERNAL_PERMISSIONS, LLM_EFFORTS, type ExternalAgentConfig, type LoadedAgent } from "@nouride/shared";
import type { ExternalSettings } from "@/modules/setup/external-agent.ts";
import { EFFORT_CHOICES, isEffortChoice } from "@/modules/setup/agent-effort.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ExternalAgents } from "@/modules/external-agents/index.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NOT_RUNNING, NOT_SAVED, notSaved } from "../plain.ts";

/** What a typed answer may be: a code, a choice — never a document. */
const ANSWER_MAX = 2000;

type Ops = Pick<ExternalAgents, "room" | "scan" | "row" | "unavailable" | "preset" | "models" | "efforts" | "profiles" | "login" | "startLogin" | "answerLogin" | "stopLogin" | "updates">;

export function registerExternalAgentRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/external-clis", async (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    // A box with no room for a CLI's session is told so, and offered nothing to add.
    const room = deps.externalAgents.room();
    // `check` asks the npm registry for the newest now, where it is otherwise asked once a day (0.8.24).
    return c.json({ room, clis: room.enough ? await deps.externalAgents.scan(c.req.query("fresh") === "1", c.req.query("check") === "1") : [] } satisfies { room: CliRoom; clis: ScannedCli[] });
  });

  /**
   * A coding CLI updated, a step at a time for `nouride agents update` (0.8.24, `external-agents/cli-update.ts`): held
   * until no turn runs in it, released where the install did not finish, checked once it has. An admin's: it changes
   * what every agent on that CLI runs. The check is audited with what it came to.
   */
  control.post("/external-clis/:cli/hold", async (c) => {
    const external = deps.externalAgents;
    if (!external) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const cli = c.req.param("cli");
    if (!external.row(cli)) return c.json({ error: `no coding CLI "${cli}" here` }, 404);
    return c.json({ busy: await external.updates.hold(cli) });
  });

  control.post("/external-clis/:cli/release", (c) => {
    const external = deps.externalAgents;
    if (!external) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    external.updates.release(c.req.param("cli"));
    return c.json({ ok: true });
  });

  control.post("/external-clis/:cli/check", async (c) => {
    const external = deps.externalAgents;
    if (!external) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const cli = c.req.param("cli");
    if (!external.row(cli)) return c.json({ error: `no coding CLI "${cli}" here` }, 404);
    const checked = await external.updates.check(cli, deps.registry.all());
    deps.audit.record({ action: "cli_updated", actor: principal.actor, details: { ...checked } });
    return c.json(checked);
  });

  /**
   * The coding CLIs with their accounts, and the agents on each with whether they can answer — the Models page. Asks the
   * CLIs, so it takes seconds; `fresh` asks again rather than take the last answer.
   */
  control.get("/cli-accounts", async (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    return c.json({ clis: await deps.externalAgents.accountList(deps.registry.all(), c.req.query("fresh") === "1") } satisfies { clis: CliAccountsView[] });
  });

  /** An account added by name, before any agent uses it. Admin only. */
  control.post("/cli-accounts", async (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { cli?: unknown; name?: unknown };
    if (typeof body.cli !== "string" || !deps.externalAgents.row(body.cli)) return c.json({ error: "cli must be one this install knows", plain: "Nouride does not know that coding CLI. Reload the page." }, 400);
    const name = typeof body.name === "string" ? body.name : "";
    const added = deps.externalAgents.accounts.add(body.cli, name);
    if (!added.ok) return c.json({ error: added.error, plain: "The account was not added. Its name takes small letters, digits and dashes, 24 at most." }, 400);
    deps.audit.record({ action: "cli_account_added", actor: principal.actor, details: { cli: body.cli, account: name } });
    return c.json(added satisfies { ok: true });
  });

  /** An account no agent uses, and its token. Admin only. */
  control.delete("/cli-accounts/:cli/:name", async (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const [cli, account] = [c.req.param("cli"), c.req.param("name")];
    const removed = await deps.externalAgents.accounts.remove(cli, account, deps.registry.all());
    if (!removed.ok) {
      return c.json({ error: removed.error, plain: `${removed.users.join(", ")} still ${removed.users.length === 1 ? "uses" : "use"} this account. Move ${removed.users.length === 1 ? "it" : "them"} to another one first.` }, 409);
    }
    // Whether a token went with it, and why not when it stayed: a list that lost an account and kept its secret is then
    // this delete, said so, or not this delete at all.
    deps.audit.record({ action: "cli_account_removed", actor: principal.actor, details: { cli, account, tokenRemoved: removed.tokenRemoved, ...(removed.tokenError ? { tokenError: removed.tokenError } : {}) } });
    if (removed.tokenError) {
      return c.json({ error: `${account} is removed, but its token stayed in the secret store: ${removed.tokenError}`, plain: "The account is removed, but its sign-in is still kept with your secrets. Delete it on the Secrets page." }, 500);
    }
    return c.json(removed);
  });

  /** A shared account's sign-in: started, shown, answered, stopped — as an agent's, keyed by the account. Admin only. */
  control.post("/cli-accounts/:cli/:name/login", (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    if (!PROFILE_NAME.test(c.req.param("name"))) return c.json({ error: "an account's name is lowercase letters, digits and dashes, at most 24" }, 400);
    try {
      return c.json({ login: deps.externalAgents.startAccountLogin(c.req.param("cli"), c.req.param("name"), principal.actor) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  control.get("/cli-accounts/:cli/:name/login", (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    return c.json({ login: deps.externalAgents.login(`@${c.req.param("cli")}/${c.req.param("name")}`) });
  });

  control.post("/cli-accounts/:cli/:name/login/answer", async (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.length > ANSWER_MAX) return c.json({ error: `text must be a line of at most ${ANSWER_MAX} characters` }, 400);
    try {
      return c.json({ login: await deps.externalAgents.answerLogin(`@${c.req.param("cli")}/${c.req.param("name")}`, body.text) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  control.post("/cli-accounts/:cli/:name/login/stop", (c) => {
    if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    deps.externalAgents.stopLogin(`@${c.req.param("cli")}/${c.req.param("name")}`);
    return c.json({ ok: true });
  });

  control.get("/agents/:id/cli", (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);
    const found = externalAgent(deps, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error, plain: found.plain }, found.status);
    const { agent, external, ops } = found;
    const unavailable = ops.unavailable(agent.config.id);
    // Its CLI's new version failed its check, and one passed before it: that one is offered back (0.8.24).
    const wayBack = unavailable ? ops.updates.wayBack(external.cli) : null;
    return c.json({
      cli: external.cli,
      profile: external.profile ?? "default",
      permissions: external.permissions ?? ops.preset(),
      model: external.model ?? null,
      // What its CLI offered when its last session opened, suggested in the model field; none before its first.
      models: ops.models.of(agent.config.id),
      // The agent's one effort, `[llm] effort` or `[llm.defaults] effort`, and what its CLI offered for the model its
      // last session was on — the one it is set to marked; none before its first, or where it offers none.
      effort: agent.config.llm?.effort ?? null,
      efforts: ops.efforts.of(agent.config.id),
      // What it can be set to here, and what "default" means on this install (0.8.7): the tab sets it, not only shows it.
      effortChoices: [...LLM_EFFORTS],
      effortDefault: deps.ctx.config.llm.defaults.effort ?? null,
      unavailable,
      // Why it cannot answer is its CLI's own words (an install command, a process's error): the page says it in its own
      // (0.8.23), those under Details.
      plain: wayBack
        ? "Its coding CLI was updated to a version that does not work with this Nouride. The version before can be put back."
        : unavailable
          ? "It cannot answer right now. Whoever runs the server can see why under Details."
          : null,
      wayBack,
      // The sign-in's terminal, to an admin only, as the sign-in is: what it prints can be the code that signs in (a
      // device code), and an operator read it here.
      login: atLeast(principal, "admin") ? ops.login(agent.config.id) : null,
    } satisfies AgentCli);
  });

  /** Its profile, preset and model, written to `[external]` in its pack. Admin only: it is how it runs. */
  control.post("/agents/:id/cli", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const settings: ExternalSettings = {};
    for (const key of ["profile", "model"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "string") return c.json({ error: `${key} must be text` }, 400);
      settings[key] = body[key];
    }
    if (body.permissions !== undefined) {
      if (!(EXTERNAL_PERMISSIONS as readonly unknown[]).includes(body.permissions)) return c.json({ error: `permissions must be one of ${EXTERNAL_PERMISSIONS.join(", ")}` }, 400);
      settings.permissions = body.permissions as ExternalSettings["permissions"];
    }
    // Its effort is `[llm]`, not `[external]`: the one setting its model and its CLI share (`setup/agent-effort.ts`).
    if (body.effort !== undefined && !isEffortChoice(body.effort)) return c.json({ error: `effort is one of ${EFFORT_CHOICES.join(", ")}` }, 400);
    const result = await deps.setup.setExternal({ agentId: c.req.param("id"), settings, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    if (body.effort !== undefined) {
      const set = await deps.setup.setEffort({ agentId: c.req.param("id"), effort: String(body.effort), actor: principal.actor });
      if (!set.ok) return c.json({ error: set.error, plain: NOT_SAVED }, 400);
    }
    return c.json({ ok: true } satisfies { ok: true });
  });

  /**
   * Which coding CLI answers an agent that exists — `{ cli, profile }` — or none, `{ cli: null }` (0.8.1). Admin only, as
   * every pack write is. A CLI that is not installed here is refused before anything is written: the agent would
   * answer nothing.
   */
  control.post("/agents/:id/answered-by", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { cli?: unknown; profile?: unknown };
    if (body.cli !== null && typeof body.cli !== "string") return c.json({ error: "cli is a CLI's id, or null for none", plain: INCOMPLETE }, 400);
    if (body.profile !== undefined && typeof body.profile !== "string") return c.json({ error: "profile must be text" }, 400);
    if (typeof body.cli === "string") {
      if (!deps.externalAgents) return c.json({ error: "external agents are not available on this daemon", plain: NOT_RUNNING }, 501);
      const row = (await deps.externalAgents.scan(true)).find((candidate) => candidate.id === body.cli);
      if (row && !row.installed) return c.json({ error: `${row.name} is not installed on this machine: ${row.install}` }, 400);
    }
    const result = await deps.setup.setAnsweredBy({ agentId: c.req.param("id"), cli: body.cli, ...(typeof body.profile === "string" ? { profile: body.profile } : {}), actor: principal.actor });
    // Its one field, Answered by, where the choice itself was refused (the orchestrator's own).
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error, plain: notSaved(result.field && "who answers it") }, 400);
  });

  /**
   * Its profiles — each a sign-in of its CLI kept in its folder — with whether each is signed in, asked of the CLI; and
   * whether the CLI keeps profiles apart at all (`separate`: one whose profile is its HOME has the one).
   */
  control.get("/agents/:id/cli/profiles", async (c) => {
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const found = externalAgent(deps, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error, plain: found.plain }, found.status);
    const profiles = await found.ops.profiles(found.agent, c.req.query("fresh") === "1");
    return c.json({ profiles, separate: Boolean(found.ops.row(found.external.cli)?.profileEnv), models: found.ops.models.of(found.agent.config.id) } satisfies { profiles: CliProfile[]; separate: boolean; models: { value: string; name?: string }[] });
  });

  /** A sign-in on the profile it answers with, or on the one `profile` names — a new name is a new profile. */
  control.post("/agents/:id/cli/login", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const found = externalAgent(deps, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error, plain: found.plain }, found.status);
    const body = ((await jsonBody(c)) ?? {}) as { profile?: unknown };
    if (body.profile !== undefined && (typeof body.profile !== "string" || !PROFILE_NAME.test(body.profile))) {
      return c.json({ error: "profile must be lowercase letters, digits and dashes, at most 24" }, 400);
    }
    try {
      return c.json({ login: found.ops.startLogin(found.agent, body.profile) } satisfies { login: CliLoginView });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), plain: "Signing in could not start. Try again in a moment." }, 400);
    }
  });

  control.post("/agents/:id/cli/login/answer", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const found = externalAgent(deps, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error, plain: found.plain }, found.status);
    const body = ((await jsonBody(c)) ?? {}) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.length > ANSWER_MAX) return c.json({ error: `text must be a line of at most ${ANSWER_MAX} characters` }, 400);
    try {
      return c.json({ login: await found.ops.answerLogin(found.agent.config.id, body.text) } satisfies { login: CliLoginView });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), plain: "That sign-in has ended. Start it again." }, 409);
    }
  });

  control.post("/agents/:id/cli/login/stop", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const found = externalAgent(deps, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error, plain: found.plain }, found.status);
    found.ops.stopLogin(found.agent.config.id);
    return c.json({ ok: true } satisfies { ok: true });
  });
}

function externalAgent(deps: ControlDeps, id: string): { agent: LoadedAgent; external: ExternalAgentConfig; ops: Ops } | { error: string; plain: string; status: 404 | 501 } {
  if (!deps.externalAgents) return { error: "external agents are not available on this daemon", plain: NOT_RUNNING, status: 501 };
  const agent = deps.registry.get(id);
  if (!agent) return { error: `no agent "${id}"`, plain: "That agent is not there any more. Reload the page.", status: 404 };
  if (!agent.config.external) return { error: `${id} is not an external agent`, plain: "This agent does not answer through a coding CLI.", status: 404 };
  return { agent, external: agent.config.external, ops: deps.externalAgents };
}
