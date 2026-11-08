/**
 * The external agents, put together (0.8.1, `modules/external-agents/`): made before the agents load, which read the
 * CLIs it knows, with what it needs of the daemon — the secrets bound to a command, the sessions kept in the database, the plan
 * beside a chat. Nothing runs until an external agent's first turn; the idle sweep is a minute's look at an empty map.
 */

import { BUILT_IN_CLIS } from "@nouride/acp";
import type { ProjectSkills } from "@nouride/persona";
import type { GlobalConfig } from "@nouride/shared";
import { totalMemoryBytes, type CommandIsolation } from "@nouride/runtime";
import type { SecretStore } from "@nouride/secrets";
import { cliAccountsState, cliLeftRunningState, cliNewestState, externalEffortsState, externalInstructionsState, externalModelsState, externalSessionsState, externalVersionsState } from "@/commons/daemon-state.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { NewestVersions } from "@/modules/external-agents/newest.ts";
import type { NotesStore } from "@/modules/notes/store.ts";
import type { ChildEnv } from "@/modules/tools/exec-secrets.ts";

export function startExternalAgents(params: { config: GlobalConfig; state: StateRows; childEnv: ChildEnv; notes: () => NotesStore; port?: () => number | undefined; commands: CommandIsolation; secrets: SecretStore; audit: AuditPort; projectSkills: ProjectSkills }): ExternalAgents {
  const externalAgents = new ExternalAgents({
    // Read at each use, so a reload that adds a row is seen by the next agent load and turn.
    rows: () => [...BUILT_IN_CLIS, ...params.config.externalClis],
    workspaceDir: () => params.config.daemon.workspaceDir,
    secretsFor: (agentId, argv) => params.childEnv.forCommand(agentId, argv).env,
    sessions: externalSessionsState(params.state),
    instructions: externalInstructionsState(params.state),
    versions: externalVersionsState(params.state),
    models: externalModelsState(params.state),
    efforts: externalEffortsState(params.state),
    leftRunning: cliLeftRunningState(params.state),
    // A shared account's token is a secret like a provider's key: in the store, never in a file of ours.
    accounts: {
      file: cliAccountsState(params.state),
      tokens: { get: (name) => params.secrets.resolve(name), set: (name, value) => params.secrets.set(name, value), delete: (name) => params.secrets.delete(name) },
    },
    audit: params.audit,
    keepPlan: (key, task, steps) => params.notes().keepPlan(key, task, steps),
    mcpUrl: () => agentMcpUrl(params.config.dashboard.host, params.port?.()),
    room: () => params.commands.commandsMaxBytes ?? totalMemoryBytes(),
    newest: new NewestVersions({ kept: cliNewestState(params.state) }),
    projectSkills: (agent) => params.projectSkills.forAgent(agent),
  });
  externalAgents.start();
  return externalAgents;
}

/**
 * Where a CLI on this box reaches `/mcp/agent`: the daemon's own port on loopback, which that path alone answers. A
 * daemon bound to one address that is not loopback is not reachable there, and lends nothing.
 */
function agentMcpUrl(host: string, port: number | undefined): string | undefined {
  if (!port) return undefined;
  if (!["0.0.0.0", "::", "127.0.0.1", "localhost", "::1", ""].includes(host)) return undefined;
  return `http://127.0.0.1:${port}/mcp/agent`;
}
