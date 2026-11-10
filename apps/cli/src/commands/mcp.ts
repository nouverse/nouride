import type { AckResponse, McpCatalogEntryResponse, McpCatalogResponse, McpLibraryResponse, McpLoginFinishResponse, McpLoginStartResponse, McpResponse, McpToolsResponse, StatusResponse, Client } from "@nouride/cli-kit";
import { openLinePrompt, readStdin, type LinePrompt } from "@nouride/runtime";
import { formatBytes, MCP_SCHEMA_WARN_BYTES } from "@nouride/shared";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, say, usageError, usageLines, fail, flagValue, hasFlag, knownAction } from "@nouride/cli-kit";
import { saidSaved } from "../saved.ts";

/**
 * `nouride mcp` — the install's MCP servers (0.7.19): one library (`agents/mcp.toml`), each server switched on per
 * agent, its credential the library's unless an agent brings its own.
 *
 * **Transport is inferred, not asked for.** `--command` means stdio, `--url` means HTTP. Making the operator name it as
 * well is a third thing to get wrong for no information the other flags did not already carry.
 *
 * **The credential comes in on stdin.** A `--token` on the command line ends up in shell history, and — where an agent
 * runs this through `exec` — in the durable exec grant and the audit log, both of which keep the full command text
 * forever. `--token` still exists because a human piping a secret is not always convenient, and it says what it costs.
 */
export async function mcp(
  client: Client,
  args: string[],
  /** Where `login` asks its questions — the terminal, or what a test scripts. */
  openPrompt: () => LinePrompt = () => openLinePrompt(),
): Promise<void> {
  const [action] = args;
  knownAction("mcp", action, ["add", "rm", "remove", "enable", "disable", "list", "ls", "search", "login", "logout", "tools"]);
  const flag = (name: string): string | undefined => flagValue(args, `--${name}`);
  const has = (name: string): boolean => hasFlag(args, `--${name}`);
  /** Repeatable, because argv is a list and joining it on spaces loses arguments with spaces in. */
  const every = (name: string): string[] =>
    args.flatMap((arg, i) => (arg === `--${name}` && args[i + 1] ? [args[i + 1] as string] : []));
  /** The server named after the action — `nouride mcp rm notion` — or with `--name`. */
  const named = (): string | undefined => flag("name") ?? (args[1] && !args[1].startsWith("--") ? args[1] : undefined);

  if (action === "search") {
    await search(client, args.slice(1).join(" "));
    return;
  }

  if (action === "login" || action === "logout") {
    const agent = flag("agent");
    const server = flag("server") ?? named();
    if (!server) usageError(`Which server? nouride mcp ${action} --server <name> [--agent <id>]`);
    // Without --agent, the library's login — every agent that has none of its own; with one, the login that agent uses.
    const base = agent ? `/agents/${encodeURIComponent(agent)}/mcp/${encodeURIComponent(server)}/oauth` : `/mcp/library/${encodeURIComponent(server)}/oauth`;
    if (action === "logout") {
      await client.del<AckResponse>(base);
      say(`${GREEN}✓${RESET} logged ${BOLD}${server}${RESET} out${agent ? ` for ${agent}` : ""} ${DIM}(its tokens are deleted, and it waits for a login again)${RESET}`);
      return;
    }
    const prompt = openPrompt();
    try {
      await login(client, base, flag("client-id"), prompt);
    } finally {
      prompt.close();
    }
    return;
  }

  if (action === "tools") {
    const name = named();
    const agent = flag("agent");
    if (!name || !agent) usageError("usage: nouride mcp tools <name> --agent <id> [--only <tool,…> | --all]");
    await tools(client, name, agent, { only: flag("only"), all: has("all") });
    return;
  }

  if (action === "add" && flag("from")) {
    await addFromRegistry(client, args, { flag, every });
    return;
  }

  if (action === "add") {
    const name = named();
    const command = flag("command");
    const url = flag("url");

    if (!name || (!command && !url)) {
      usageLines(
        `${DIM}nouride mcp add --name <name> (--command <exe> | --url <url>) [--agent <id> …]\n` +
          `  --agent <id>               switch it on for this agent too; repeat for each one\n` +
          `  --arg <value>              argument for a stdio server; repeat for each one\n` +
          `  --cwd <dir>                working directory for a stdio server\n` +
          `  --sse                      use the legacy SSE transport instead of streamable-http\n` +
          `  --stdin                    read the credential from stdin (preferred)\n` +
          `  --token <value>            pass it inline: it ends up in shell history, in the exec\n` +
          `                             grant and in the audit log, all of which keep it forever\n` +
          `  --header <name>            send the credential under this header instead of\n` +
          `                             Authorization: Bearer, e.g. X-Api-Key\n` +
          `  --env-secret VAR=<secret>  a stdio server's credential variable, from a secret\n` +
          `                             the store holds (nouride secret set <secret>); repeat\n` +
          `  --env VAR=<value>          a plain variable for a stdio server; repeat\n` +
          `  --per-agent                each agent brings its own credential, none is shared\n` +
          `  --from <registry-name>     everything else from the MCP registry (nouride mcp search)\n` +
          `\n` +
          `The server goes into the install's library (agents/mcp.toml); the agents it is switched on\n` +
          `for are reloaded, which connects it. Nothing else restarts. Its tools arrive named\n` +
          `<server>__<tool>, and they run without asking unless the agent's [tools] approval_required names them.${RESET}`,
      );
    }

    // Read before the request, so a failure to supply it is not a half-created server.
    let token = flag("token");
    if (hasFlag(args, "--stdin")) {
      token = (await readStdin()).trim();
      if (!token) fail("--stdin was given but nothing arrived on stdin");
    }
    const transport = url ? (has("sse") ? "sse" : "streamable-http") : "stdio";
    const secretEnv = secretPairs(every("env-secret"));
    const agents = every("agent");
    const result = await client.post<AckResponse & { on?: string[] }>("/mcp/library", {
      name,
      transport,
      ...(command ? { command } : {}),
      ...(every("arg").length > 0 ? { args: every("arg") } : {}),
      ...(flag("cwd") ? { cwd: flag("cwd") } : {}),
      ...(url ? { url } : {}),
      ...(flag("header") ? { authHeader: flag("header") } : {}),
      ...(has("per-agent") ? { perAgent: true } : {}),
      ...(token ? { token } : {}),
      ...(secretEnv ? { envSecrets: secretEnv } : {}),
      ...(plainEnv(every("env")) ? { env: plainEnv(every("env"))! } : {}),
      ...(agents.length > 0 ? { enable: agents } : {}),
    });
    const on = result.on ?? agents;
    saidSaved(`saved ${BOLD}${name}${RESET} ${DIM}(${transport}) to the library${on.length ? `, on for ${on.join(", ")}` : " (switch it on: nouride mcp enable " + name + " --agent <id>)"}${RESET}`, result, "nouride agent reload <id>");
    if (on.length > 0 && !result.restartRequired) say(`${DIM}  Connecting now: \`nouride mcp\` says when it is up, or why it is not.${RESET}`);
    return;
  }

  if (action === "enable" || action === "disable") {
    const name = named();
    const agent = flag("agent");
    if (!name || !agent) usageError(`usage: nouride mcp ${action} <name> --agent <id>`);
    let token = flag("token");
    if (hasFlag(args, "--stdin")) {
      token = (await readStdin()).trim();
      if (!token) fail("--stdin was given but nothing arrived on stdin");
    }
    const secretEnv = secretPairs(every("env-secret"));
    const own = token || secretEnv || has("own-login");
    const credential = has("library-credential") ? "library" : own ? { ...(token ? { token } : {}), ...(secretEnv ? { envSecrets: secretEnv } : {}), ...(has("own-login") ? { login: true } : {}) } : undefined;
    const result = await client.put<AckResponse>(`/agents/${encodeURIComponent(agent)}/mcp/${encodeURIComponent(name)}`, {
      on: action === "enable",
      ...(credential ? { credential } : {}),
    });
    saidSaved(`${action === "enable" ? "switched on" : "switched off"} ${BOLD}${name}${RESET} for ${agent}`, result, `nouride agent reload ${agent}`);
    if (has("own-login")) say(`${DIM}  It logs in on its own now: nouride mcp login --server ${name} --agent ${agent}${RESET}`);
    return;
  }

  if (action === "rm" || action === "remove") {
    const name = named();
    const agent = flag("agent");
    if (!name) usageError(`usage: nouride mcp rm <name> [--agent <id>]`);
    if (agent) {
      // For one agent: switched off there; the library keeps it for the others.
      const off = await client.put<AckResponse>(`/agents/${encodeURIComponent(agent)}/mcp/${encodeURIComponent(name)}`, { on: false });
      saidSaved(`switched ${name} off for ${agent}${DIM}, still in the library (nouride mcp rm ${name} takes it away)${RESET}`, off, `nouride agent reload ${agent}`);
      return;
    }
    const removed = await client.del<AckResponse>(`/mcp/library/${encodeURIComponent(name)}`);
    saidSaved(`removed ${name} from the library, and from every agent`, removed, "nouride agent reload <id>");
    if (!removed?.restartRequired) say(`${DIM}  Disconnected; its tools are gone from the next turn.${RESET}`);
    return;
  }

  // A flag where the action belongs — `nouride mcp --agent foo`, exit 2: `knownAction` lets those through, and listing every
  // server instead answered a malformed call with a success.
  if (action && action !== "ls" && action !== "list") usageError(`\`nouride mcp\` takes add, rm, enable, disable, tools, search, login, logout or nothing, not ${action}.`, "nouride mcp [ls|add|rm|enable|disable|tools|search|login|logout]");

  await list(client);
}

/** The library: each server, who uses it, and how each of those is doing. */
async function list(client: Client): Promise<void> {
  const library = await client.get<McpLibraryResponse>("/mcp/library");
  if (library.error) {
    // No agent has the library's servers while it does not load: a failure, whatever is listed after it.
    say(`${RED}✗ agents/mcp.toml does not load:${RESET} ${library.error}`);
    process.exitCode = 1;
  }
  if (library.servers.length === 0) {
    say(`${DIM}no MCP servers yet: nouride mcp add, or Explore in the dashboard (Configure → MCP)${RESET}`);
    return;
  }
  const { servers: live } = await client.get<McpResponse>("/mcp");
  // The orchestrator first in each server's list, as the dashboard shows it. Soft: an older daemon lists in its order.
  const orchestrator = (await client.softGet<StatusResponse>("/status").catch(() => null))?.orchestrator ?? null;
  for (const server of library.servers) {
    const runs = server.transport === "stdio" ? server.command ?? "" : server.url ?? "";
    const login = server.needsLogin ? ` · ${YELLOW}needs login${RESET}${DIM}: nouride mcp login --server ${server.name}` : server.login ? ` · logged in` : "";
    say(`${BOLD}${server.name}${RESET} ${DIM}· ${server.transport} · ${runs}${server.perAgent ? " · per agent" : ""}${login}${RESET}`);
    const on = server.agents.filter((agent) => agent.on).sort((a, b) => Number(b.id === orchestrator) - Number(a.id === orchestrator));
    if (on.length === 0) say(`  ${DIM}on for no agent: nouride mcp enable ${server.name} --agent <id>${RESET}`);
    for (const agent of on) {
      const state = live.find((entry) => entry.agentId === agent.id && entry.server === server.name);
      const mark = state?.needsLogin ? `${YELLOW}◐${RESET}` : state?.connected ? `${GREEN}●${RESET}` : `${RED}○${RESET}`;
      const schema = state?.schemaBytes === undefined ? "" : ` · ${formatBytes(state.schemaBytes)} of schema per request`;
      const large = (state?.schemaBytes ?? 0) > MCP_SCHEMA_WARN_BYTES ? ` ${YELLOW}(large, see nouride doctor)${RESET}` : "";
      const count = state?.toolsTotal === undefined ? `${state?.tools ?? 0} tool(s)` : `${state.tools} of ${state.toolsTotal} tools`;
      say(`  ${mark} ${agent.id} ${DIM}· ${count}${schema}${agent.own ? " · its own credential" : ""}${RESET}${large}`);
    }
  }
  // A server that failed to start is not connected, not "connected, no tools" — said so an empty row is read right.
  say(`${DIM}○ is a server that is not connected: starting, or failed to start (the log says which)${RESET}`);
}

/**
 * `nouride mcp tools <name> --agent <id>` — the server's tools for that agent, with what each adds to every request;
 * `--only a,b` gives it just those, `--all` every one again. The names are the server's own, as listed here.
 */
async function tools(client: Client, name: string, agent: string, choice: { only: string | undefined; all: boolean }): Promise<void> {
  const path = `/agents/${encodeURIComponent(agent)}/mcp/${encodeURIComponent(name)}`;
  if (choice.only !== undefined && choice.all) usageError("--only and --all say opposite things: give one");
  if (choice.only !== undefined || choice.all) {
    const only = choice.only?.split(",").map((tool) => tool.trim()).filter(Boolean);
    if (only && only.length === 0) usageError("--only takes the tools to keep, comma-separated: --only search,fetch");
    // Checked against what the server offers, when it is connected: a typo is said now rather than in the log later.
    const listed = await client.softGet<McpToolsResponse>(`${path}/tools`).catch(() => null);
    const unknown = only && listed ? only.filter((tool) => !listed.tools.some((row) => row.name === tool)) : [];
    if (unknown.length > 0) fail(`${name} has no ${unknown.map((tool) => `"${tool}"`).join(", ")} (nouride mcp tools ${name} --agent ${agent} lists its tools)`);
    const result = await client.put<AckResponse>(path, { tools: only ?? null });
    const kept = only ? `${only.length} of ${name}'s tools` : `every tool of ${name}`;
    saidSaved(`${agent} has ${kept} now${listed ? "" : ` ${DIM}(not checked: ${name} is not connected for ${agent})${RESET}`}`, result, `nouride agent reload ${agent}`);
    return;
  }
  const answer = await client.get<McpToolsResponse>(`${path}/tools`);
  const width = Math.max(...answer.tools.map((tool) => tool.name.length), 4);
  for (const tool of answer.tools) {
    const mark = tool.on ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    const size = tool.bytes === undefined ? "" : formatBytes(tool.bytes);
    say(`${mark} ${tool.name.padEnd(width)} ${DIM}${size.padStart(8)}  ${tool.description.slice(0, 100)}${RESET}`);
  }
  const on = answer.tools.filter((tool) => tool.on);
  const sent = on.reduce((sum, tool) => sum + (tool.bytes ?? 0), 0);
  const held = answer.tools.filter((tool) => !tool.on).reduce((sum, tool) => sum + (tool.bytes ?? 0), 0);
  say(`${DIM}${answer.all ? "all" : `${on.length} of ${answer.tools.length}`} tools · ${formatBytes(sent)} of schema per request${held > 0 ? ` · ${formatBytes(held)} left out` : ""}${RESET}`);
  if (answer.unknown?.length) say(`${YELLOW}its tools list names ${answer.unknown.join(", ")}, which ${name} does not offer${RESET}`);
  say(`${DIM}choose: nouride mcp tools ${name} --agent ${agent} --only <tool,…>   all again: --all${RESET}`);
}

/** `--env-secret VAR=secret_name`, each naming a secret already in the store: the value never passes through argv. */
function secretPairs(pairs: string[]): Record<string, { secret: string }> | undefined {
  if (pairs.length === 0) return undefined;
  const malformed = pairs.find((pair) => !/^[A-Za-z_][A-Za-z0-9_]*=[^=\s]+$/.test(pair));
  if (malformed) usageError(`--env-secret takes VAR=secret_name, not "${malformed}"`, "nouride mcp add … --env-secret GITHUB_TOKEN=github_token");
  return Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), { secret: pair.slice(pair.indexOf("=") + 1) }]));
}

/**
 * `nouride mcp login --server <name> [--agent <id>]` — a login a person makes in a browser, finished here: the address
 * to open is printed, and the one the browser lands on afterwards is pasted back. That works over SSH too, where the
 * browser is on another machine and the page it is sent back to does not load: the address is what carries the answer.
 */
async function login(client: Client, base: string, clientId: string | undefined, prompt: LinePrompt): Promise<void> {
  // A client registered by hand, for an authorization server that registers nobody: its secret is asked for, never
  // typed on the command line, where shell history and an exec grant would keep it.
  const clientSecret = clientId ? (await prompt.askHidden(`Client secret for ${clientId} (blank for none): `)).trim() : "";
  const started = await client.post<McpLoginStartResponse>(`${base}/start`, {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  });
  say(`Open this address in a browser, log in, and allow access:\n\n  ${started.url}\n`);
  say(`${DIM}The browser is sent back to this daemon afterwards. A page that does not load there is fine: its address is what is needed.${RESET}`);
  const landed = (await prompt.ask("Paste the address the browser landed on: ")).trim();
  if (!landed) fail("nothing was pasted: run this again to start the login over");
  const done = await client.post<McpLoginFinishResponse>("/mcp/oauth/finish", { url: landed });
  const whose = done.holder === "shared" ? "the library: every agent that has no login of its own" : done.holder;
  say(`${GREEN}✓${RESET} ${BOLD}${done.server}${RESET} is logged in for ${whose}${done.scope ? ` ${DIM}(${done.scope})${RESET}` : ""}`);
  say(`${DIM}  Connecting now: \`nouride mcp\` says when it is up.${RESET}`);
}

/** `--env VAR=value`, repeated, as the table it is; a malformed one is a usage error. */
function plainEnv(pairs: string[]): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const malformed = pairs.find((pair) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(pair));
  if (malformed) usageError(`--env takes VAR=value, not "${malformed}"`, "nouride mcp add … --env LOG_LEVEL=info");
  return Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
}

/**
 * `nouride mcp search [words]` — Nouverse's MCP catalog, best first, with who published each and how it would run here.
 * Without words, the catalog's own list: what Nouverse pinned first.
 */
async function search(client: Client, query: string): Promise<void> {
  const answer = await client.get<McpCatalogResponse>(`/mcp/catalog?q=${encodeURIComponent(query.trim())}`);
  for (const entry of answer.entries) {
    const how = entry.unsupported ? `${YELLOW}${entry.blocked?.label ?? "cannot run here"}${RESET}` : entry.runsVia === "remote" ? "remote" : `runs via ${entry.runsVia}`;
    const needs = entry.needs?.length ? ` · needs ${entry.needs.join(", ")}` : "";
    say(`${BOLD}${entry.title ?? entry.name}${RESET} ${DIM}${entry.title ? `${entry.name} ` : ""}v${entry.version} · by ${entry.publisher} · ${how}${needs}${RESET}`);
    if (entry.description) say(`  ${entry.description.slice(0, 160)}`);
  }
  if (answer.entries.length === 0) say(`${DIM}nothing in the MCP catalog matches "${query.trim()}"${RESET}`);
  else {
    const more = answer.total > answer.entries.length ? `${answer.entries.length} of ${answer.total.toLocaleString("en-US")} (more words narrow it); ` : "";
    say(`${DIM}${more}add one: nouride mcp add --agent <id> --from <name>${RESET}`);
  }
}

/**
 * `nouride mcp add --agent <id> --from <registry-name>` — the server as the registry describes it, with what only the
 * person has: a token on stdin, secret variables naming secrets already stored, plain ones with --env. An entry that
 * still needs editing (a {slug} in its URL, an argument to fill) is refused with what to change: the dashboard's form
 * shows it to edit.
 */
async function addFromRegistry(
  client: Client,
  args: string[],
  read: { flag: (name: string) => string | undefined; every: (name: string) => string[] },
): Promise<void> {
  const agents = read.every("agent");
  const from = read.flag("from")!;
  if (read.flag("command") || read.flag("url")) usageError("--from fills in the command or the URL itself; leave out --command and --url");
  const entry = await client.get<McpCatalogEntryResponse>(`/mcp/catalog/entry?name=${encodeURIComponent(from)}`);
  const result = entry.result;
  if (!result || "unsupported" in result) fail(`${from} cannot be added here: ${result?.unsupported ?? "it is not in the catalog"}`);
  const draft = result.draft;
  if (draft.notes.length > 0) fail(`${from} needs editing before it can work:\n  ${draft.notes.join("\n  ")}\nAdd it from the dashboard's MCP page, where the form shows it to change.`);

  const pairs = read.every("env-secret");
  const named = Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  const missing = (draft.secretEnv ?? []).filter((input) => input.required && !named[input.name]);
  if (missing.length > 0) usageError(`${from} needs ${missing.map((input) => input.name).join(", ")}`, missing.map((input) => `--env-secret ${input.name}=<secret> (nouride secret set <secret> --stdin first)`).join(" "));
  const env = { ...draft.env, ...plainEnv(read.every("env")) };
  const unset = (draft.envInputs ?? []).filter((input) => input.required && !env[input.name]);
  if (unset.length > 0) usageError(`${from} needs ${unset.map((input) => input.name).join(", ")}`, unset.map((input) => `--env ${input.name}=<value>`).join(" "));

  let token: string | undefined;
  if (draft.token) {
    if (hasFlag(args, "--stdin")) token = (await readStdin()).trim();
    if (!token && draft.token.required) usageError(`${from} needs ${draft.token.name}: pipe it in`, `printf %s "$TOKEN" | nouride mcp add --from ${from} --stdin`);
  }
  const name = read.flag("name") ?? draft.name;
  const added = await client.post<AckResponse>("/mcp/library", {
    name,
    transport: draft.transport,
    ...(draft.command ? { command: draft.command } : {}),
    ...(draft.args?.length ? { args: draft.args } : {}),
    ...(draft.url ? { url: draft.url } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(draft.headers ? { headers: draft.headers } : {}),
    ...(draft.token?.header ? { authHeader: draft.token.header } : {}),
    ...(token ? { token } : {}),
    ...(pairs.length > 0 ? { envSecrets: Object.fromEntries(Object.entries(named).map(([variable, secret]) => [variable, { secret }])) } : {}),
    ...(agents.length > 0 ? { enable: agents } : {}),
  });
  saidSaved(`added ${BOLD}${name}${RESET} ${DIM}(${draft.source}, ${draft.runsVia}) to the library${agents.length ? `, on for ${agents.join(", ")}` : ` (switch it on: nouride mcp enable ${name} --agent <id>)`}${RESET}`, added, "nouride agent reload <id>");
  if (agents.length > 0 && !added.restartRequired) say(`${DIM}  Connecting now: \`nouride mcp\` says when it is up, or why it is not.${RESET}`);
}
