/**
 * The install's MCP servers (0.7.19): the library — Configure → MCP, `nouride mcp` — and each agent's switches and
 * credentials for it — the agent's MCP tab. Registered before `agents.ts`, whose `/agents/:id/:action` would
 * otherwise take `POST /agents/:id/mcp`.
 *
 * Reading is an operator's; changing is an admin's, as adding a gateway is: a server is tools an agent may call, run by
 * a process this daemon starts or reached with an account's credential. No route answers with a secret or its name —
 * only whether one is set.
 */

import { readMcpLibrary, SHARED_LOGIN } from "@nouride/persona";
import type { McpServerConfig } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import type { McpPacks, SecretInput } from "@/modules/config/settings/mcp.ts";
import type { McpServerEdit } from "@/modules/config/edit-blocks.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_CHANGED, NOT_SAVED, NO_SETTINGS } from "../plain.ts";

type Body = Record<string, unknown>;

/** The packs as the library's writers need them. */
function packsOf(deps: ControlDeps): McpPacks {
  return {
    agentsDir: deps.ctx.config.daemon.agentsDir,
    agents: () => deps.registry.all().map((agent) => ({ id: agent.config.id, dir: agent.dir, mcp: agent.config.mcp ?? {} })),
    reload: (id) => deps.registry.reload(id),
  };
}

function secretInputs(raw: unknown): Record<string, SecretInput> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw).map(([variable, wanted]) => {
      const entry = typeof wanted === "object" && wanted !== null ? (wanted as Body) : {};
      return [variable, { ...(typeof entry.value === "string" ? { value: entry.value } : {}), ...(typeof entry.secret === "string" ? { secret: entry.secret } : {}) }];
    }),
  );
}

/** A server's shape from a form or the CLI. The credential is never in it — see `token` and `envSecrets`. */
function serverOf(body: Body): McpServerEdit {
  const table = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : undefined);
  return {
    name: String(body.name ?? ""),
    transport: String(body.transport ?? "stdio") as McpServerEdit["transport"],
    ...(typeof body.command === "string" ? { command: body.command } : {}),
    ...(Array.isArray(body.args) ? { args: body.args.map(String) } : {}),
    ...(typeof body.cwd === "string" && body.cwd ? { cwd: body.cwd } : {}),
    ...(typeof body.url === "string" && body.url ? { url: body.url } : {}),
    ...(table(body.env) ? { env: table(body.env)! } : {}),
    ...(table(body.headers) ? { headers: table(body.headers)! } : {}),
    ...(typeof body.authHeader === "string" && body.authHeader ? { authHeader: body.authHeader } : {}),
    ...(typeof body.perAgent === "boolean" ? { perAgent: body.perAgent } : {}),
  };
}

/** A server as the pages show it: secrets as "set or not", never their names. */
function shown(server: McpServerConfig, hasSecret: (name: string) => boolean) {
  const { authSecret, envSecrets, loginAs: _loginAs, auth: _auth, ...rest } = server;
  return {
    ...rest,
    hasCredential: Boolean(authSecret && hasSecret(authSecret)),
    envSecrets: Object.entries(envSecrets ?? {}).map(([variable, name]) => ({ name: variable, set: hasSecret(name) })),
  };
}

export function registerMcpRoutes(control: ControlApp, deps: ControlDeps): void {
  const hasSecret = (name: string) => Boolean(deps.settings?.hasSecret(name));
  const live = () => deps.mcp?.status() ?? [];

  // ── The library ──────────────────────────────────────────────────────────

  control.get("/mcp/library", async (c) => {
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const library = await readMcpLibrary(deps.ctx.config.daemon.agentsDir);
    const status = live();
    const agents = deps.registry.all();
    return c.json({
      ...(library.error ? { error: library.error, plain: "The list of connectors could not be read in full: some may be missing." } : {}),
      servers: library.servers.map((server) => ({
        ...shown(server, hasSecret),
        // The library's own login — never a token — and whether it waits for a person.
        ...(deps.mcpLogins?.view(SHARED_LOGIN, server.name) ? { login: deps.mcpLogins.view(SHARED_LOGIN, server.name) } : {}),
        needsLogin: Boolean(deps.mcpLogins?.isWaiting(SHARED_LOGIN, server.name)),
        agents: agents.map((agent) => {
          const choice = agent.config.mcp?.[server.name];
          const used = agent.config.mcpServers.find((entry) => entry.name === server.name);
          const state = status.find((entry) => entry.agentId === agent.config.id && entry.server === server.name);
          return {
            id: agent.config.id,
            on: Boolean(choice?.on),
            own: Boolean(choice?.envSecrets || choice?.authSecret || choice?.login),
            ...(used ? { connected: state?.connected ?? false, tools: state?.tools ?? 0, needsLogin: Boolean(state?.needsLogin) } : {}),
          };
        }),
      })),
    });
  });

  control.post("/mcp/library", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Body;
    const envSecrets = secretInputs(body.envSecrets);
    const result = await deps.settings.saveLibraryServer({
      packs: packsOf(deps),
      actor: principal.actor,
      server: serverOf(body),
      ...(typeof body.token === "string" && body.token ? { token: body.token } : {}),
      ...(envSecrets ? { envSecrets } : {}),
      ...(Array.isArray(body.enable) ? { enable: body.enable.map(String) } : {}),
    });
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: NOT_SAVED }, 400);
  });

  control.delete("/mcp/library/:name", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const name = c.req.param("name");
    const result = await deps.settings.removeLibraryServer({ packs: packsOf(deps), actor: principal.actor, name });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_CHANGED }, 400);
    // Its logins go with it: tokens kept for a server nothing uses are credentials kept for nothing.
    await deps.mcpLogins?.forget(SHARED_LOGIN, name);
    for (const id of result.users ?? []) await deps.mcpLogins?.forget(id, name);
    return c.json({ ok: true, restartRequired: false });
  });

  // ── One agent's switches ─────────────────────────────────────────────────

  /**
   * Every library server with this agent's word on it, and any its pack still declares itself — merged with live
   * state: on and not connected is a moment after a switch, or a server that fails to start.
   */
  control.get("/agents/:id/mcp", async (c) => {
    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);
    const library = await readMcpLibrary(deps.ctx.config.daemon.agentsDir);
    const status = new Map(live().filter((entry) => entry.agentId === id).map((entry) => [entry.server, entry]));
    const used = new Map(agent.config.mcpServers.map((server) => [server.name, server]));
    const row = (server: McpServerConfig) => {
      const effective = used.get(server.name);
      const choice = agent.config.mcp?.[server.name];
      const holder = effective?.loginAs ?? (choice?.login || server.perAgent ? id : SHARED_LOGIN);
      const state = status.get(server.name);
      const login = deps.mcpLogins?.view(holder, server.name);
      return {
        ...shown(effective ?? server, hasSecret),
        on: Boolean(choice?.on),
        credential: choice?.envSecrets || choice?.authSecret || choice?.login ? "own" : "library",
        loginAs: holder === SHARED_LOGIN ? "library" : "own",
        ...(login ? { login } : {}),
        needsLogin: Boolean(state?.needsLogin),
        connected: state?.connected ?? false,
        tools: state?.tools ?? 0,
        // What those tools add to every request this agent makes (G12).
        schemaBytes: state?.schemaBytes ?? 0,
        running: status.has(server.name),
        // The agent's `tools` list (0.7.21): absent, it has every tool the server offers.
        ...(effective?.tools ? { chosenTools: effective.tools } : {}),
        ...(state?.toolsTotal === undefined ? {} : { toolsTotal: state.toolsTotal, withheldBytes: state.withheldBytes ?? 0 }),
        ...(state?.unknownTools ? { unknownTools: state.unknownTools } : {}),
      };
    };
    return c.json({
      ...(library.error ? { error: library.error, plain: "The list of connectors could not be read in full: some may be missing." } : {}),
      servers: library.servers.map(row),
    });
  });

  /**
   * Every tool the server offers this agent, each with what it adds to a request and whether the agent has it (0.7.21) —
   * for the checklist that chooses them. 409 while the server is not connected for this agent: its tools are not known.
   */
  control.get("/agents/:id/mcp/:name/tools", (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);
    const tools = deps.mcp?.toolList(id, name);
    if (!tools) return c.json({ error: `${name} is not connected for ${id}. Switch it on, and its tools are listed once it is up` }, 409);
    const chosen = agent.config.mcpServers.find((server) => server.name === name)?.tools;
    const unknown = chosen ? chosen.filter((tool) => !tools.some((row) => row.name === tool)) : [];
    return c.json({ tools, all: !chosen, ...(unknown.length > 0 ? { unknown } : {}) });
  });

  /** Switch a library server on or off for this agent, or set the credential it uses here. */
  control.put("/agents/:id/mcp/:name", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Body;
    const raw = body.credential;
    let credential: "library" | { token?: string; envSecrets?: Record<string, SecretInput>; login?: boolean } | undefined;
    if (raw === "library") credential = "library";
    else if (raw && typeof raw === "object") {
      const own = raw as Body;
      const envSecrets = secretInputs(own.envSecrets);
      credential = {
        ...(typeof own.token === "string" && own.token ? { token: own.token } : {}),
        ...(envSecrets ? { envSecrets } : {}),
        ...(typeof own.login === "boolean" ? { login: own.login } : {}),
      };
    }
    const result = await deps.settings.setAgentMcp({
      packs: packsOf(deps),
      agentId: c.req.param("id"),
      actor: principal.actor,
      name: c.req.param("name"),
      ...(typeof body.on === "boolean" ? { on: body.on } : {}),
      ...(credential ? { credential } : {}),
      // A list chooses the server's tools for this agent (0.7.21); null gives it all of them again.
      ...(body.tools === null ? { tools: null } : Array.isArray(body.tools) ? { tools: body.tools.map(String) } : {}),
    });
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: NOT_SAVED }, 400);
  });

  /** Add a server for this agent: into the library, switched on here — `nouride mcp add --agent`, and older pages. */
  control.post("/agents/:id/mcp", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const id = c.req.param("id");
    if (!deps.registry.get(id)) return c.json({ error: `no agent "${id}"` }, 404);
    const body = ((await jsonBody(c)) ?? {}) as Body;
    const envSecrets = secretInputs(body.envSecrets);
    const result = await deps.settings.saveLibraryServer({
      packs: packsOf(deps),
      actor: principal.actor,
      server: serverOf(body),
      ...(typeof body.token === "string" && body.token ? { token: body.token } : {}),
      ...(envSecrets ? { envSecrets } : {}),
      enable: [id],
    });
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: NOT_SAVED }, 400);
  });

  /** Switch it off for this agent. The library keeps it; `DELETE /mcp/library/:name` takes it away for everyone. */
  control.delete("/agents/:id/mcp/:name", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const result = await deps.settings.setAgentMcp({ packs: packsOf(deps), agentId: c.req.param("id"), actor: principal.actor, name: c.req.param("name"), on: false });
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: NOT_SAVED }, 400);
  });
}
