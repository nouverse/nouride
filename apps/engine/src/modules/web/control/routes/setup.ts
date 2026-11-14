/**
 * First-run setup.
 *
 * `/setup/state` is one of the two routes reachable without a credential — see `../guard.ts` for
 * why an unconfigured instance is not a secret.
 */

import { atLeast } from "@/modules/users/auth.ts";
import { oauthReady, oauthSupported } from "@/modules/users/oidc.ts";
import type { SetupState } from "@nouride/wire";
import type { ControlApp, ControlDeps } from "../types.ts";
import { isPresetId } from "@/modules/setup/presets.ts";
import { jsonBody, providerHeaders } from "../payloads.ts";
import { NOT_RUNNING, NOT_SAVED, probed } from "../plain.ts";

export function registerSetupRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * How far setup has got. Public, because the dashboard has to render something before anyone can
   * sign in, and "this instance has not been configured" is not a secret worth a login form nobody
   * can satisfy.
   */
  control.get("/setup/state", (c) => {
    // The one thing the login page cannot work out for itself: whether to draw the external sign-in
    // button. It is here rather than in `SetupState` because this route answers even when the setup
    // service is absent, and a login page that renders differently depending on whether setup is
    // still mounted would be a puzzle to debug. `label` ships with it so the button can be named
    // after the provider the operator actually configured; `available` never implies a secret leaked
    // — it says four settings are filled in, which anyone who can reach the login page can see anyway
    // by clicking the button.
    const dashboard = deps.ctx.config.dashboard;
    const external = {
      // Both halves: this build must carry the flow, and this install must have
      // configured one. A button drawn on an edition that has no flow is a
      // button whose route answers 404.
      available: oauthSupported() && oauthReady(dashboard),
      label: dashboard?.oauth?.label || "Nouverse",
    };
    /**
     * Whether to draw the password form at all.
     *
     * Defaults to true for a daemon whose config predates the setting, because
     * "absent" must never mean "no way in" — a login page with neither a form
     * nor a button is unanswerable.
     */
    const passwordLogin = dashboard?.passwordLogin !== false;
    const bundledGateway = bundledGatewayState(deps);
    if (!deps.setup) {
      return c.json({
        hasUser: true,
        hasProvider: true,
        hasAgent: true,
        complete: true,
        oauth: external,
        passwordLogin,
        bundledGateway,
      } satisfies SetupState);
    }
    return c.json({ ...deps.setup.state(), oauth: external, passwordLogin, bundledGateway } satisfies SetupState);
  });

  /** Try an endpoint without saving it, so the wizard can fill its model picker before committing. */
  control.post("/setup/probe", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const kind = body.kind === "anthropic" ? "anthropic" : "openai";
    return c.json(
      probed(
        await deps.setup.probe({
          kind,
          baseUrl: typeof body.base_url === "string" ? body.base_url : "",
          apiKey: typeof body.api_key === "string" ? body.api_key : "",
        }),
      ) satisfies { ok: boolean; models: string[]; error?: string; plain?: string },
    );
  });

  control.post("/setup/provider", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.setup.saveProvider({
      kind: body.kind === "anthropic" ? "anthropic" : "openai",
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
      baseUrl: typeof body.base_url === "string" ? body.base_url : "",
      apiKey: typeof body.api_key === "string" ? body.api_key : "",
      ...(providerHeaders(body.headers) ? { headers: providerHeaders(body.headers)! } : {}),
      actor: principal.actor,
      skipProbe: body.skip_probe === true,
    });
    return result.ok ? c.json(result satisfies { ok: true; models: string[] }) : c.json({ error: result.error, plain: "The AI service was not saved. Check its address and its key, and try again." }, 400);
  });

  /**
   * Connect the daemon to the gateway it hosts — no key typed.
   *
   * The wizard calls this once the person has signed in to at least one account through the
   * gateway's own API (`/llm-gateway/api/...`). The daemon mints its key in-process and writes the
   * provider profile; the person never sees the key, and the answer carries the models those
   * accounts can serve, for the agent step.
   */
  control.post("/setup/gateway", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const result = await deps.setup.useBundledGateway({ actor: principal.actor });
    return result.ok ? c.json(result satisfies { ok: true; models: string[] }) : c.json({ error: result.error, plain: NOT_SAVED }, 400);
  });

  control.get("/setup/models", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const result = await deps.setup.listModels();
    return result.ok ? c.json(result satisfies { ok: true; models: string[] }) : c.json({ error: result.error, plain: "The list of models could not be read. Check the AI service's address and its key." }, 400);
  });

  control.post("/setup/agent", async (c) => {
    if (!deps.setup) return c.json({ error: "setup is not available on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    // Admin only, as the provider and an agent's CLI (`answered-by`) are: a new agent is made enabled, and can be given
    // every tool and a coding CLI on the install's shared account — an operator made one that way.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.setup.createAgent({
      id: typeof body.id === "string" ? body.id : "",
      displayName: typeof body.display_name === "string" ? body.display_name : "",
      systemPrompt: typeof body.system_prompt === "string" ? body.system_prompt : "",
      model: typeof body.model === "string" ? body.model : "",
      actor: principal.actor,
      ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
      // Read at last. Both dashboards have been sending it since they were written, and this line
      // was where it stopped — so the toggle labelled "Allow Terminal Command Execution" decided
      // nothing and every agent got a shell. Only an explicit boolean is forwarded: absent still
      // means yes, which is what the CLI wizard relies on.
      ...(typeof body.allow_exec === "boolean" ? { allowExec: body.allow_exec } : {}),
      autoOn: body.auto_on !== false,
      ...(isPresetId(body.preset) ? { preset: body.preset } : {}),
      ...(Array.isArray(body.tools) ? { tools: body.tools.filter((name): name is string => typeof name === "string") } : {}),
      ...(typeof body.headline === "string" ? { headline: body.headline } : {}),
      ...((): { external?: { cli: string; profile?: string } } => {
        const external = body.external as { cli?: unknown; profile?: unknown } | undefined;
        if (!external || typeof external.cli !== "string") return {};
        return { external: { cli: external.cli, ...(typeof external.profile === "string" ? { profile: external.profile } : {}) } };
      })(),
    });
    return result.ok ? c.json(result satisfies { ok: true; id: string; provider: string }) : c.json({ error: result.error, plain: "The agent was not made. Check what you entered, and try again." }, 400);
  });
}

/**
 * The gateway this build carries: whether it runs, and whether it could.
 *
 * `available` is whether it runs, as it has always meant: only some editions *carried* nougate before every build did,
 * and a dashboard older than the switch offers the gateway on `available` alone — an endpoint nothing answers on when it
 * is off. What a newer one needs to offer it while it is off is beside it: `carried`, and `mount`, which a dashboard
 * that reads `available` first ignores. `decidedBy` says the environment holds the switch, so the page shows it rather
 * than offers it.
 *
 * The URL is **loopback** and that is not an oversight — `nougate-inproc.ts` binds `127.0.0.1` deliberately, because a
 * gateway hosted inside the daemon exists to serve that daemon and binding it wider publishes an LLM proxy from a
 * process nobody expected to be one. So this is the right value for the **daemon** to call and the wrong one for a
 * browser to open: the wizard fills a provider with it, and nothing links to it.
 *
 * Read defensively, like everything else on this route: it answers before anyone can sign in, and a test bench builds
 * deps with no gateway at all. Any throw here is a login page that cannot render.
 */
function bundledGatewayState(deps: ControlDeps): NonNullable<SetupState["bundledGateway"]> {
  const gateway = deps.llmGateway;
  const running = gateway?.current() ?? null;
  const decided = gateway?.decidedBy ? { decidedBy: gateway.decidedBy } : {};
  if (!running) {
    if (!gateway?.carried) return gateway ? { available: false, carried: false } : { available: false };
    return { available: false, carried: true, ...(deps.llmGatewayMount ? { mount: deps.llmGatewayMount } : {}), ...decided };
  }
  /**
   * Which password opens the gateway's console — `"environment"`, `"generated"`, or absent.
   *
   * Two ways, and the wizard needs to know which, because the sentences are not the same. The operator's own
   * `INITIAL_ADMIN_*` is still the password they know. A generated one is not: `mustChangePassword` sends a first login
   * through `/welcome` before this wizard renders, so by the time the provider step is on screen they have replaced
   * theirs and the gateway still holds the original. A boot fact: it depends on what the environment and the users
   * table held as the gateway came up.
   */
  const sharedCredential = gateway?.credentialSharing();
  return {
    available: true,
    baseUrl: running.url,
    ...(sharedCredential ? { sharedCredential } : {}),
    /**
     * Where its dashboard is reachable through this one — the LLM Gateway page, and the API the wizard's sign-in step
     * signs accounts in through — and whether the page can show it. The sign-in step needs only the gateway's API,
     * which is in the binary; the page needs the bundle beside it, which an older update left behind
     * (`EmbeddedGateway.dashboardEmbeddable`). Asked as it is now, so a bundle replaced under a running daemon counts.
     */
    ...(deps.llmGatewayMount ? { mount: deps.llmGatewayMount, dashboard: running.dashboardEmbeddable() } : {}),
    carried: true,
    ...decided,
    /**
     * Running, and the file has it off: turned off where nothing restarts Nouride, or on where the setting could not be
     * written. Either way it stops at the next start, and the page says so rather than offering Turn off again.
     */
    ...(!gateway?.decidedBy && deps.ctx.config?.nougate?.inProcess === false ? { stopping: true } : {}),
  };
}
