/**
 * The checks that run once the agents are loaded, before the first message can arrive.
 *
 * All of them are invariant 7 — fail at load, not at an agent's first turn — with one exception
 * marked as such: `assertCredentialsUnreadable` *refuses to boot*, because a credentials directory
 * inside a readable root is silent. The daemon starts, the scripts work, and `read` returns a
 * private key.
 *
 * The rest warn. They are said at boot as well as in `nouride doctor` and `config check`, because
 * nobody runs those on a box that came up green — and "web_search fails on every call" does not look
 * like a config problem from the chat, it looks like the tool being broken.
 */

import { externalOrchestratorRefusal } from "@/modules/setup/agent-access.ts";
import { resourceLimitsAvailable } from "@nouride/runtime";
import { secretBindingWarnings } from "@nouride/policy";
import { createLogger, type GlobalConfig, type LoadedAgent } from "@nouride/shared";
import { envNamesFor } from "@nouride/secrets";
import { skillsDirFor } from "@nouride/persona";
import { assertCredentialsUnreadable } from "@nouride/persona";
import type { AgentRegistry } from "@nouride/persona";
import { assertGatewayExecPosture, reportConfigAdvisories } from "@/modules/config/global/index.ts";
import { openAdvisories, type Advise } from "./advisories.ts";
import { lintConfig } from "@/modules/config/schema.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";

const log = createLogger("daemon");

/**
 * The registry's `refuse` for this daemon: a pack that makes the orchestrator external — the start's check below, on
 * each reload of one pack. Every save of a pack ends in that reload, so the save is put back saying why: a Files-tab
 * edit adding `[external]` to the orchestrator's config.toml was taken by the running daemon, and the next start
 * refused the file.
 */
export function refusingExternalOrchestrator(config: GlobalConfig): (agent: LoadedAgent) => string | null {
  return (agent) =>
    agent.config.external && config.daemon.orchestrator === agent.config.id
      ? `agents/${agent.config.id}/config.toml [external]: ${externalOrchestratorRefusal(agent.config.id)}`
      : null;
}

export function runPreflightChecks(deps: {
  config: GlobalConfig;
  registry: AgentRegistry;
  providers: ProviderRegistry;
  credentialsDir: string;
  /** Where the last boot's advisories are remembered (`daemon_state`). */
  state: StateRows;
}): void {
  const { config, registry, providers, credentialsDir } = deps;

  // Before anything can run a turn. A credentials directory inside a readable root is a silent
  // failure — the daemon boots, the scripts work, and `read` returns a private key — so it is a
  // refusal rather than a warning (invariant 7).
  assertCredentialsUnreadable({
    credentialsDir,
    agents: registry.all(),
    skillsDir: skillsDirFor(config.daemon.agentsDir),
    workspaceDirs: [config.daemon.workspaceDir],
  });

  // Checked here rather than in `parseConfig`: it needs the loaded agents to know who holds `exec`.
  assertGatewayExecPosture({
    gatewaysEnabled: config.gateways.some((g) => g.enabled),
    agentsWithExec: registry
      .active()
      .filter((agent) => agent.config.tools.enabled.includes("exec"))
      .map((agent) => agent.config.id),
    accessMode: config.security.access.mode,
  });

  // Bad, every boot: a setting the daemon cannot use. A deliberate default (no spend cap) at info. The rest once, while
  // it is new (`advisories.ts`) — `nouride doctor` and the dashboard's Overview list the whole set the last boot said.
  const advisories = openAdvisories(deps.state, log);
  const { advise } = advisories;
  for (const lint of lintConfig(config)) {
    if (lint.level === "bad") log.error(lint.message, { hint: lint.hint });
    else if (lint.deliberate) log.info(lint.message, { hint: lint.hint });
    else advise(lint.message, { hint: lint.hint });
  }

  /**
   * An external agent is never the orchestrator, the agent anyone in a room reaches (EXTERNAL_AGENTS §5.2). Checked here
   * because it needs the loaded agents; said, and this start runs with no orchestrator, rather than refusing to start.
   * A save of a pack is refused it (`refusingExternalOrchestrator`, above), but a hand edit is not — and refused here, a file
   * the running daemon had taken crash-looped every agent at the next restart or update, over a role only one holds.
   */
  const orchestrator = config.daemon.orchestrator ? registry.get(config.daemon.orchestrator) : undefined;
  if (orchestrator?.config.external) {
    advise(`config.toml [daemon] orchestrator names ${orchestrator.config.id}, an external agent, so this start runs with no orchestrator`, {
      hint: externalOrchestratorRefusal(orchestrator.config.id),
    });
    delete config.daemon.orchestrator;
  }

  // A secret bound to a bare interpreter: every command by another name (S6).
  for (const agent of registry.active()) {
    for (const warning of secretBindingWarnings(agent.config.execSecrets)) advise(warning, { agent_id: agent.config.id });
  }

  // Said once, at boot. A setting that silently does nothing is the class of bug this codebase keeps
  // finding, and "I set a memory limit" is exactly the belief somebody would carry into a decision.
  if (
    (config.security.exec.maxMemoryMb ?? 0) > 0 ||
    (config.security.exec.maxCpuSeconds ?? 0) > 0
  ) {
    if (resourceLimitsAvailable()) {
      log.info("exec resource limits are in force", {
        memory_mb: config.security.exec.maxMemoryMb ?? 0,
        cpu_seconds: config.security.exec.maxCpuSeconds ?? 0,
      });
    } else {
      advise("exec resource limits are configured but NOT applied: prlimit is not available here", {
        platform: process.platform,
      });
    }
  }

  warnAboutMissingCredentials(registry, providers, config, advise);
  warnAboutShellWithoutCli(registry, advise);
  warnAboutMemoryWithoutPeople(registry, advise);
  warnAboutMemoryWithoutSearch(registry, config, advise);
  warnAboutPeopleWithoutNotes(registry, advise);
  warnAboutSshAgentSocket(registry, process.env.SSH_AUTH_SOCK, advise);
  warnAboutDisabledApprovals(registry, config, advise);
  reportConfigAdvisories(config, advise);
  advisories.save();
}

/**
 * Agents that will not ask about anything, said once where somebody is still looking.
 *
 * `trusted` is a legitimate setting and hard to reach on purpose — dashboard only, behind a login. What it
 * is not is a thing to discover later from a deleted directory. So it is announced the way the exec
 * posture is: named agents, at boot, at `warn`.
 *
 * Includes the daemon default, because an operator who set it there has switched every `per-person`
 * agent to `trusted` without naming one.
 */
function warnAboutDisabledApprovals(registry: AgentRegistry, config: GlobalConfig, advise: Advise): void {
  if (config.security.approvals === "trusted") {
    advise(
      "[security] approvals is `trusted`: nothing will ask before any tool call, for every agent that has not set " +
        "its own level. A config.toml changed, someone given access and this daemon stopped included.",
    );
  }

  const named = registry
    .active()
    .filter((agent) => agent.config.approvals === "trusted")
    .map((agent) => agent.config.id);

  if (named.length > 0) {
    advise(
      "these agents will not ask before any tool call. A config.toml changed, someone given access and this " +
        "daemon stopped included. Anyone who can message them inherits that.",
      { agents: named },
    );
  }
}

export function agentsWithShellButNoCli(
  agents: { config: { id: string; tools: { enabled: string[] } } }[],
): string[] {
  return agents
    .filter(({ config }) => config.tools.enabled.includes("exec") && !config.tools.enabled.includes("nouride"))
    .map(({ config }) => config.id);
}

/**
 * An agent holding `exec` but not `nouride`, which is an oversight in every case that matters.
 *
 * Dropping the CLI tool is a documented, intentional choice — `DEFAULT_TOOLS` says so: "a pack that
 * wants an agent with no reach into the daemon drops it". But that choice only *means* anything
 * alongside dropping the shell. With `exec` the CLI is already reachable: run it inside exec's exact
 * sandbox and `nouride agents` prints the live agent list, which is written down in the contributing
 * notes because somebody checked.
 *
 * So `exec` without `nouride` withholds no authority whatsoever. What it withholds is the typed,
 * individually-gated, audited path — and the prompt section that teaches the CLI at all, since that
 * block is gated on the tool. The result was watched live: six agents told by their prompt to run
 * `nouride config check`, none of them ever shown what the CLI can do, so the daemon's own control
 * surface was reached by guessing or not at all.
 *
 * A warning rather than a merge, and rather than a refusal. Merging it in would override a line the
 * operator wrote by hand, and a pack whose tools are enumerated is a pack whose author had opinions.
 * This says the combination is probably not what they meant and names the one-word fix — which is the
 * whole of invariant "fail at load, not at an agent's first message".
 *
 * Silent for a pack that dropped both, because that is the coherent version of the same intent.
 */
function warnAboutShellWithoutCli(registry: AgentRegistry, advise: Advise): void {
  for (const agentId of agentsWithShellButNoCli(registry.active())) {
    advise(
      "agent has `exec` but not `nouride`: it can already reach the CLI through the shell, so this " +
        "withholds no authority and only costs it the typed path and the prompt section that explains " +
        'the CLI. Add "nouride" to [tools] enabled unless you also meant to drop `exec`.',
      { agent_id: agentId },
    );
  }
}

/**
 * An agent that can write memory but cannot write down who it is talking to.
 *
 * The same shape as `exec` without `nouride`, and the same argument: the combination is legal, it is
 * almost never meant, and the cost of it is invisible from inside the pack. Watched live — somebody
 * introduced themselves on Telegram and the turn's only tool call was `memory_write`, so the name
 * landed in `MEMORY.md` and the next conversation still opened not knowing them. The identity line is
 * built from `[[people]]`, and memory is never read for it.
 *
 * A warning rather than a merge, for the reason written above: a pack whose tools are enumerated is a
 * pack whose author had opinions, and quietly adding to that list would make the file stop describing
 * the agent. This names the one-word fix instead.
 *
 * Silent for a pack that has neither, which is the coherent version of the same intent.
 */
export function agentsWithMemoryButNoPeople(
  agents: { config: { id: string; tools: { enabled: string[] } } }[],
): string[] {
  return agents
    .filter(
      ({ config }) =>
        config.tools.enabled.includes("memory_write") && !config.tools.enabled.includes("person_record"),
    )
    .map(({ config }) => config.id);
}

function warnAboutMemoryWithoutPeople(registry: AgentRegistry, advise: Advise): void {
  for (const agentId of agentsWithMemoryButNoPeople(registry.active())) {
    advise(
      "agent has `memory_write` but not `person_record`: told somebody's name, it has nowhere to put " +
        "it but MEMORY.md, which the identity line does not read, so the next conversation still will " +
        'not know them. Add "person_record" to [tools] enabled.',
      { agent_id: agentId },
    );
  }
}

/**
 * An agent that reads memory the old way but cannot search what is learned now.
 *
 * The same pair shape as the two above, found on the first box upgraded to 0.6: every pack there
 * enumerated its tools, none named `memory_search` (it did not exist when they were written), so with
 * memory on, an agent asked "what did we say about X" had no way into it — and reached for whatever
 * else it had. Only while memory is set up (an owner named): before that there is nothing to search.
 */
export function agentsWithMemoryButNoSearch(
  agents: { config: { id: string; tools: { enabled: string[] } } }[],
  memoryOn: boolean,
): string[] {
  if (!memoryOn) return [];
  return agents
    .filter(({ config }) => {
      const tools = config.tools.enabled;
      return tools.includes("memory_read") && !tools.includes("memory_search");
    })
    .map(({ config }) => config.id);
}

function warnAboutMemoryWithoutSearch(registry: AgentRegistry, config: GlobalConfig, advise: Advise): void {
  const agents = agentsWithMemoryButNoSearch(registry.active(), config.memory.pass);
  if (agents.length === 0) return;
  advise(
    'memory is on, but these agents cannot search it: their packs list tools and "memory_search" is ' +
      "not among them. Add it to [tools] enabled.",
    { agents },
  );
}

/**
 * An agent that can write down who somebody is but cannot change their notes.
 *
 * The same pair shape again, for the same reason: `person_notes` is new in 0.7.0, and a pack that lists
 * its tools was written before it. Such an agent, told "I'm allergic to shrimp" by somebody who wants it
 * kept with who they are, has only memory to put it in. Named rather than added, as above.
 */
export function agentsWithPeopleButNoNotes(agents: { config: { id: string; tools: { enabled: string[] } } }[]): string[] {
  return agents
    .filter(({ config }) => config.tools.enabled.includes("person_record") && !config.tools.enabled.includes("person_notes"))
    .map(({ config }) => config.id);
}

function warnAboutPeopleWithoutNotes(registry: AgentRegistry, advise: Advise): void {
  const agents = agentsWithPeopleButNoNotes(registry.active());
  if (agents.length === 0) return;
  advise(
    'these agents can record who somebody is but cannot change their notes when they ask: their packs list tools and ' +
      '"person_notes" is not among them. Add it to [tools] enabled.',
    { agents },
  );
}

/**
 * Agents that ran commands or MCP servers with the daemon's ssh-agent socket until 0.7.10 and do not now (S11).
 *
 * Every command of every agent got `SSH_AUTH_SOCK`; since 0.7.10 an agent's pack has to say `[security] ssh_agent =
 * true`. A default that changes under an install that relied on it fails far from the cause — `git push` asking for a
 * passphrase nobody can type, an `ssh` refused by its host — so the agents it changes for are named while somebody is
 * still looking. Only when the daemon has a socket to hand: without one, nothing an agent did used it. And not for a
 * pack that wrote `ssh_agent` either way, which has decided.
 */
export function agentsLosingSshAgent(
  agents: { config: { id: string; sshAgent?: boolean; tools: { enabled: string[] }; mcpServers: { transport: string }[] } }[],
  socket: string | undefined,
): string[] {
  if (!socket) return [];
  return agents
    .filter(({ config }) => config.sshAgent === undefined)
    .filter(
      ({ config }) =>
        config.tools.enabled.includes("exec") ||
        config.tools.enabled.includes("session") ||
        config.mcpServers.some((server) => server.transport === "stdio"),
    )
    .map(({ config }) => config.id);
}

function warnAboutSshAgentSocket(registry: AgentRegistry, socket: string | undefined, advise: Advise): void {
  for (const agentId of agentsLosingSshAgent(registry.active(), socket)) {
    advise(
      "SSH_AUTH_SOCK is set for the daemon, but since 0.7.10 an agent's commands and MCP servers are handed it only when " +
        "its pack says so: this agent's ssh, git and scp no longer reach the ssh-agent",
      {
        agent_id: agentId,
        hint:
          "If it signs with the agent's keys, add `ssh_agent = true` under [security] in its config.toml; `false` says " +
          "it does not, and this note stops. A key named in ~/.ssh/config is a file, not the socket, and still works.",
      },
    );
  }
}

/**
 * Say at boot which agents cannot talk to a model yet.
 *
 * Credentials are resolved lazily, on an agent's first turn — which is correct (a profile
 * nobody uses should not need a key) but makes for a miserable first run: the daemon reports
 * itself ready, then the first message fails with a secret error nobody was watching for.
 * This names the agent, the profile and the environment variable while someone is still
 * looking at the terminal.
 */
function warnAboutMissingCredentials(
  registry: AgentRegistry,
  providers: ProviderRegistry,
  config: GlobalConfig,
  advise: Advise,
): void {
  const credentialed = new Map(providers.available().map((p) => [p.name, p.hasCredential]));

  for (const agent of registry.active()) {
    // An external agent answers on its CLI's own sign-in, said on its status when it is missing.
    if (agent.config.external) continue;
    const profileName = agent.config.llm.provider;
    if (credentialed.get(profileName) === false) {
      advise("agent has no usable credential: it will fail on its first message", {
        agent_id: agent.config.id,
        profile: profileName,
        needs_env: envHintFor(config.providers[profileName]?.apiKeySecret),
      });
    }
  }
}

function envHintFor(secretName: string | undefined): string {
  return secretName ? (envNamesFor(secretName)[0] ?? secretName) : "unknown";
}
