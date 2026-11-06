/**
 * The built-in toolset, wired to this daemon's stores.
 *
 * Every entry here is a *closure*, never the object itself, and that is the rule the whole file is
 * built on: a tool that held the gateway map could send anywhere, a tool that held the job store
 * could kill anything. What each one gets is the narrowest call it needs — send to *this* chat,
 * start a job for *this* agent, save *one* person.
 *
 * Built after the pipeline and handed back to it (`pipeline.setTools`), because `session_status`
 * needs live session facts while the pipeline needs the tool map. The cycle is broken by passing a
 * closure rather than the object.
 */

import type { LinkFor } from "@/modules/web/links.ts";
import type { NotesPort } from "@/modules/notes/store.ts";
import type { McpCatalog } from "@/modules/mcp-registry/index.ts";
import { dirname, join, statFile } from "@nouride/runtime";
import { createLogger, type GlobalConfig, type Tool, type ToolContext } from "@nouride/shared";
import type { SecretStore, TransientSecrets } from "@nouride/secrets";
import type { AgentRegistry } from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import { startJobFor, type JobsPort } from "@/modules/jobs/jobs.store.ts";
import { secretKeepingFor } from "@/boot/secret-keeping.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { Pipeline } from "@/modules/pipeline/index.ts";
import type { Memory } from "@/modules/memory/index.ts";
import { isSearchKind } from "@/modules/tools/builtins/search-backends.ts";
import type { GrantsPort } from "@/modules/tools/grants.store.ts";
import type { ToolGrantsPort } from "@/modules/tools/tool-grants.store.ts";
import type { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";
import { createSkillHub } from "@/modules/skills-hub/index.ts";
import { peersFrom } from "@/modules/tools/builtins/ask-agent.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import type { HarnessToolOptions } from "@/modules/tools/builtins/harness.ts";
import { changesSharedTools } from "@/modules/toolchain/shared-tools.ts";
import type { McpManager } from "@/modules/tools/mcp.ts";
import { readImagesFrom } from "@/modules/tools/builtins/read-image.ts";
import type { UpdateToolOptions } from "@/modules/tools/builtins/update.ts";
import type { TurnStore } from "@/modules/turns/turns.store.ts";
import type { ChildEnv } from "@/modules/tools/exec-secrets.ts";

const log = createLogger("daemon");

export function buildTools(deps: {
  /** A worktree for a writing helper of a mission in one (`delegate` `isolated`). */
  isolateHelper?: (ctx: ToolContext) => Promise<{ path: string; branch: string } | { refused: string }>;
  /** The coding CLIs and whether each is installed, for `agent_create`'s external agents (0.8.1). */
  clis?: () => Promise<{ id: string; name: string; installed: boolean; install: string }[]>;
  /** A coding-CLI agent's CLI, for `agent_configure` to set its model (0.8.8). */
  cliModels?: HarnessToolOptions["cliModels"];
  /** Dashboard links for a chat (`web/links.ts`, 0.8.11): an external agent's sign-in, an MCP server's add form. */
  linkFor: LinkFor;
  config: GlobalConfig;
  secrets: SecretStore;
  registry: AgentRegistry;
  providers: ProviderRegistry;
  pipeline: Pipeline;
  approvals: SqliteApprovalGate;
  /** The self-improvement loop, so an agent can propose a correction to a skill it is using. */
  reflection?: ReflectionEngine;
  /** Told how a picture is shown, once the pipeline can say — `read` is told the same, below. */
  mcp?: McpManager;
  /** Nouverse's MCP catalog, for `mcp_search` (0.7.19). Undefined when `NOURIDE_MCP_CATALOG_URL` turns it off. */
  mcpCatalog?: McpCatalog | undefined;
  grants: GrantsPort;
  toolGrants: ToolGrantsPort;
  jobs: JobsPort;
  /** What is remembered — `memory_search`, `memory_analyze`, and the conversation and person halves of the memory tools. */
  memory: Memory;
  /** The turn log — what `memory_read` reads an archived part of a conversation back from. */
  turns: Pick<TurnStore, "exchangesBetween">;
  audit: AuditPort;
  /**
   * This daemon's `config.toml`, already resolved — where `person_record` writes.
   *
   * Passed in rather than derived, because the control plane's `SettingsService` writes the same file
   * and two answers to "which file is this daemon's config" is one too many: the loser writes people
   * nothing ever reads back.
   */
  configPath: string;
  childEnv: ChildEnv;
  /** The credentials people sent in chat, held under handles — for `exec` and `secret_save` (`tools/held-secrets.ts`). */
  heldSecrets?: TransientSecrets;
  /** Every credential the daemon holds itself — what a printed credential file's value keeps the mask of, if it is one. */
  ownSecrets?: () => Record<string, string>;
  /** `skills/` beside the executable, when this build ships any — see `resolveBuiltinSkillsDir`. */
  builtinSkillsDir?: string;
  /**
   * Checking for a newer release, and taking it.
   *
   * Prepared by the caller rather than assembled here, because taking an update is three steps in a
   * fixed order — schedule the follow-up, swap the files, end the process — and two of those need
   * things `buildTools` has no business holding: the cron store and the restart hook. See
   * `modules/update/self-update.ts`.
   */
  update?: UpdateToolOptions;
  /** Each conversation's work notes: `notes`, and `plan` kept past the turn. */
  notes?: NotesPort;
}): Map<string, Tool> {
  const {
    config,
    secrets,
    registry,
    providers,
    pipeline,
    approvals,
    grants,
    toolGrants,
    jobs,
    memory,
    turns,
    audit,
    configPath,
    childEnv,
    heldSecrets,
    ownSecrets,
    builtinSkillsDir,
    update,
    notes,
  } = deps;

  // The secret's NAME comes from config; only the value is resolved here. A backend that needs no
  // credential — a self-hosted SearXNG — simply finds nothing, which is not an error.
  const searchKey = secrets.resolve(config.security.web.searchApiKey);
  const attachmentRead = pipeline.attachmentReader();
  // A picture an MCP server returns is shown the way one `read` opens is: the same `[media]` answers.
  if (attachmentRead) deps.mcp?.showImagesWith(readImagesFrom(attachmentRead));
  return createBuiltinTools({
    security: config.security,
    /**
     * Writing down who somebody is.
     *
     * `config` is the live object the pipeline reads, not a copy, so a name recorded mid-conversation
     * is in the identity line of the very next turn — which is the entire point of this being a tool
     * an agent can reach rather than an operator's chore.
     */
    // A name an agent records never takes the key of someone removed whose memory is still under it.
    people: { config, configPath, audit, keyHeld: (key: string) => memory.keyHeld(key) },
    memory,
    ...(notes ? { notes } : {}),
    earlierTurns: {
      between: (gatewayId, chatId, after, until) => turns.exchangesBetween(gatewayId, chatId, after, until),
      timezone: config.daemon.timezone,
    },
    liveGrants: (agentId) => grants.liveKeys(agentId),
    liveToolGrants: (agentId) => toolGrants.liveKeys(agentId),
    // The same predicate the gate uses, so a command is never refused for "nobody to ask" while
    // the prompt would in fact have been delivered.
    canAsk: () => approvals.canAsk(),
    childEnv,
    // Handed to a command that names one, masked out of what tools hand back, and kept for good by `secret_save`.
    ...(ownSecrets ? { ownSecrets } : {}),
    ...(heldSecrets
      ? {
          heldSecrets,
          secretKeeping: secretKeepingFor({ secrets, audit, registry }),
        }
      : {}),
    // Also here, not only in `resolveToolset`: the per-agent rebuild only happens when a pack has
    // blocked patterns or needs the ask floor, so an agent without either was getting the registry's
    // `exec` — which had no `startJob` and told the user background execution was unavailable. Found
    // live, on the first attempt.
    startJob: startJobFor(jobs),
    web: {
      ...(searchKey ? { searchApiKey: searchKey } : {}),
      ...(isSearchKind(config.security.web.searchKind)
        ? { searchKind: config.security.web.searchKind }
        : {}),
      ...(config.security.web.searchEndpoint
        ? { searchEndpoint: config.security.web.searchEndpoint }
        : {}),
      fallbackEnabled: config.security.web.fallbackEnabled,
      fallbackBackends: config.security.web.fallbackBackends,
    },
    sendFile: {
      send: (toolCtx, attachment) => pipeline.sendAttachment(toolCtx, attachment),
      // The same policy `web_fetch` uses, from the same setting. A URL an agent found in search
      // results is the least trustworthy URL there is, so it meets the guard on every redirect hop.
      urlPolicy: { allowPrivate: config.security.web.allowPrivateUrls },
      // The same knob that bounds what this install accepts. "How big a file this daemon moves" is
      // one question, and two numbers would drift until one of them was wrong.
      maxBytes: config.attachments.maxSizeMb * 1024 * 1024,
      // So a file holding one of the agent's credentials is refused rather than posted unmasked.
      childEnv,
    },
    // Into another chat this agent knows, and that chat's conversation (`pipeline/send-message.ts`).
    sendMessage: pipeline.messageSender(),
    /**
     * Reading a file that is in the conversation.
     *
     * Absent when this daemon has no attachment index, so the tool is simply not there rather than
     * present and answering "nothing is configured" — the same rule `web_search` and the `nouride`
     * tool follow.
     */
    ...(attachmentRead ? { attachmentRead } : {}),
    ...(nourideCli(dirname(dirname(config.daemon.dataDir)), (agentId) => changesSharedTools(config, registry.get(agentId))) ?? {}),
    ...(update ? { update } : {}),
    sessionStatus: (toolCtx) => pipeline.sessionStatus(toolCtx),
    runSubagent: pipeline.subagentRunner(),
    // A helper as a job of its own (0.7.15): its turn ends at once, and its end wakes the agent — `background-helper.ts`.
    startHelper: pipeline.backgroundHelpers(),
    ...(deps.isolateHelper ? { isolateHelper: deps.isolateHelper } : {}),
    /**
     * The agent-to-agent bus.
     *
     * `peers` is a closure over the live registry, not a list captured here: agents are created,
     * paused and reloaded while the daemon runs, and a set frozen at boot would offer names that have
     * since gone and miss every agent added after — `peersFrom`, which also gives each the line OTHER AGENTS does.
     */
    askAgent: {
      run: pipeline.peerTurnRunner(),
      // An ask that runs long moves to the background and wakes the agent that asked with its answer (0.7.19).
      start: pipeline.askRunner(),
      ...peersFrom(registry, () => config.agents.mentionsEnabled),
    },
    ...(deps.reflection ? { reflection: deps.reflection } : {}),
    ...(deps.mcpCatalog ? { mcpCatalog: { catalog: deps.mcpCatalog, linkFor: deps.linkFor } } : {}),
    ...(deps.reflection ? { skillHub: createSkillHub({ config, secrets: deps.secrets, reflection: deps.reflection, builtinSkillsDir }) } : {}),
    harness: {
      registry,
      agentsDir: config.daemon.agentsDir,
      // So `skill_toggle` can list and switch a built-in skill too. Absent in a build without them,
      // which the tool reads as "there are none" rather than failing.
      ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
      // Read live: the Workshop's global switch edits `config.skills.off` in place.
      skillsOffGlobally: () => config.skills.off,
      providers: () => providers.available(),
      audit,
      ...(deps.clis ? { clis: deps.clis } : {}),
      ...(deps.cliModels ? { cliModels: deps.cliModels } : {}),
      tell: pipeline.chatNotice(),
      linkFor: deps.linkFor,
      llm: { defaults: () => config.llm.defaults, orchestrator: () => (config.daemon.orchestrator ? registry.get(config.daemon.orchestrator)?.config.llm : undefined) },
    },
    audit,
  });
}

/**
 * This install's own `nouride`, if it is installed.
 *
 * Resolved to an absolute path inside the install rather than left to `PATH`: the name on `PATH` is
 * a symlink owned by whichever install was set up last, and on a box running two of them a bare
 * `nouride` edits the wrong daemon while reporting success.
 *
 * Returns nothing from a source checkout, where the binary does not exist — and the tool is then not
 * offered, rather than offered and failing on every call.
 */
function nourideCli(
  installDir: string,
  sharedTools: (agentId: string) => boolean,
): { nourideCli: { installDir: string; command: string; changesSharedTools: (agentId: string) => boolean } } | null {
  const binary = join(installDir, "nouride");
  if (!statFile(binary)) {
    log.info("the `nouride` tool is not offered", { reason: "no binary in the install directory", looked_for: binary });
    return null;
  }
  return { nourideCli: { installDir, command: binary, changesSharedTools: sharedTools } };
}
