/**
 * Editing gateways, provider profiles, agents and daemon policy from the dashboard.
 *
 * Setting up a Telegram bot used to mean opening `config.toml` over SSH. That is a reasonable thing
 * to ask of the person who installed the daemon and an unreasonable thing to ask of anyone else, so
 * this puts the same edits behind the control API — with the same rules the file has.
 *
 * Two of those rules are load-bearing and hold in every module here:
 *
 * **A token's value goes to the secret store; only its NAME is written to the config.** This is the
 * single place most likely to break §17.1, because the obvious implementation writes what the
 * operator typed straight into the file they back up. It never does.
 *
 * **A saved gateway is not a running gateway.** Adapters are constructed once, at boot, from the
 * config as it was then. Writing the file does not reach into a live websocket, so every mutation
 * reports whether a restart is needed rather than pretending it took effect.
 *
 * The class is a facade: one file per section, each a plain function of `SettingsDeps`, so the part
 * worth testing does not need an instance.
 */

import type { GatewayView, ProviderView, SaveResult, SettingsDeps } from "./types.ts";
import * as gateways from "./gateways.ts";
import * as providers from "./providers.ts";
import * as agents from "./agents.ts";
import * as mcp from "./mcp.ts";
import * as policy from "./policy.ts";
import * as jobs from "./jobs.ts";
import * as people from "./people.ts";
import * as learning from "./learning.ts";
import * as skills from "./skills.ts";
import * as secrets from "./secrets.ts";
import * as memory from "./memory.ts";
import * as mcpServer from "./mcp-server.ts";
import * as identities from "./identities.ts";
import * as web from "./web.ts";
import * as tiers from "./tiers.ts";
import * as missions from "./missions.ts";
import * as update from "./update.ts";
import * as backups from "./backups.ts";

export { GATEWAY_PLATFORMS, PROVIDER_KINDS } from "./types.ts";
export type { LearningPatch } from "./learning.ts";
export type { ModelTiersPatch } from "./tiers.ts";
export type { GatewayView, ProviderView, SaveResult, SettingsDeps } from "./types.ts";

type Rest<F> = F extends (deps: SettingsDeps, ...rest: infer R) => unknown ? R : never;

export class SettingsService {
  constructor(private readonly deps: SettingsDeps) {}

  hasSecret(name: string): boolean {
    return secrets.hasSecret(this.deps, name);
  }

  /** Names and origins. Never values — see the note at the top of `settings/secrets.ts`. */
  secretInventory(): ReturnType<typeof secrets.secretInventory> {
    return secrets.secretInventory(this.deps);
  }

  secretShadowedByEnv(name: string): boolean {
    return secrets.secretShadowedByEnv(this.deps, name);
  }

  async setSecret(...args: Rest<typeof secrets.setSecret>): ReturnType<typeof secrets.setSecret> {
    return await secrets.setSecret(this.deps, ...args);
  }

  async changeSecretFields(...args: Rest<typeof secrets.changeSecretFields>): ReturnType<typeof secrets.changeSecretFields> {
    return await secrets.changeSecretFields(this.deps, ...args);
  }

  /** Whether the store is encrypted, and where its key is. Never the key. */
  secretLock(): ReturnType<typeof secrets.secretLock> {
    return secrets.secretLock(this.deps);
  }

  async deleteSecret(...args: Rest<typeof secrets.deleteSecret>): Promise<boolean> {
    return await secrets.deleteSecret(this.deps, ...args);
  }

  groupContextDefault(): number {
    return secrets.groupContextDefault(this.deps);
  }

  gateways(): GatewayView[] {
    return gateways.gateways(this.deps);
  }

  async saveGateway(...args: Rest<typeof gateways.saveGateway>): ReturnType<typeof gateways.saveGateway> {
    return await gateways.saveGateway(this.deps, ...args);
  }

  async removeGateway(...args: Rest<typeof gateways.removeGateway>): Promise<SaveResult> {
    return await gateways.removeGateway(this.deps, ...args);
  }

  providerProfiles(): ProviderView[] {
    return providers.providerProfiles(this.deps);
  }

  async saveProvider(...args: Rest<typeof providers.saveProvider>): ReturnType<typeof providers.saveProvider> {
    return await providers.saveProvider(this.deps, ...args);
  }

  async removeProvider(...args: Rest<typeof providers.removeProvider>): Promise<SaveResult> {
    return await providers.removeProvider(this.deps, ...args);
  }

  async saveAgentModel(...args: Rest<typeof agents.saveAgentModel>): ReturnType<typeof agents.saveAgentModel> {
    return await agents.saveAgentModel(this.deps, ...args);
  }

  /** This agent's own tool budget, or `null` to follow the daemon's. */
  async saveAgentToolIterations(
    ...args: Rest<typeof agents.saveAgentToolIterations>
  ): Promise<SaveResult> {
    return await agents.saveAgentToolIterations(this.deps, ...args);
  }

  /** The model an agent answers with when its own cannot, or none (G3). */
  async saveAgentFallbacks(...args: Rest<typeof agents.saveAgentFallbacks>): Promise<SaveResult> {
    return await agents.saveAgentFallbacks(this.deps, ...args);
  }

  /** One agent's own small and high model, or none to inherit the install's (0.8.0). See `settings/tiers.ts`. */
  async saveAgentTiers(...args: Rest<typeof tiers.saveAgentTiers>): ReturnType<typeof tiers.saveAgentTiers> {
    return await tiers.saveAgentTiers(this.deps, ...args);
  }

  /** The install's tiers, and the tier or model each helper key names. */
  modelTiers(): ReturnType<typeof tiers.modelTiers> {
    return tiers.modelTiers(this.deps);
  }

  async setModelTiers(...args: Rest<typeof tiers.setModelTiers>): ReturnType<typeof tiers.setModelTiers> {
    return await tiers.setModelTiers(this.deps, ...args);
  }

  /** The daemon-wide tool budget every agent follows unless its pack overrides it. */
  async saveAgentTurnSeconds(
    ...args: Rest<typeof agents.saveAgentTurnSeconds>
  ): Promise<SaveResult> {
    return await agents.saveAgentTurnSeconds(this.deps, ...args);
  }

  async setTurnSeconds(...args: Rest<typeof policy.setTurnSeconds>): Promise<SaveResult> {
    return await policy.setTurnSeconds(this.deps, ...args);
  }

  /** `[daemon] backup_seal`: the passphrase the snapshots' secrets are sealed to, or null for none (0.8.18, D5). */
  async setBackupSeal(...args: Rest<typeof backups.setBackupSeal>): Promise<backups.SealResult> {
    return await backups.setBackupSeal(this.deps, ...args);
  }

  /** `[update] track`: `latest` or `lts`, which releases this install is offered (0.8.18). */
  async setUpdateTrack(...args: Rest<typeof update.setUpdateTrack>): Promise<SaveResult> {
    return await update.setUpdateTrack(this.deps, ...args);
  }

  /** `[jobs] quiet_after_minutes` — how long a job may be quiet before its agent says so. */
  async setJobQuietMinutes(...args: Rest<typeof jobs.setJobQuietMinutes>): Promise<SaveResult> {
    return await jobs.setJobQuietMinutes(this.deps, ...args);
  }

  async saveAgentJobQuietMinutes(...args: Rest<typeof jobs.saveAgentJobQuietMinutes>): Promise<SaveResult> {
    return await jobs.saveAgentJobQuietMinutes(this.deps, ...args);
  }

  /** `[delegate] max_background` in one agent's pack — how many helpers it may have in the background. */
  async saveAgentMaxBackground(...args: Rest<typeof jobs.saveAgentMaxBackground>): Promise<SaveResult> {
    return await jobs.saveAgentMaxBackground(this.deps, ...args);
  }

  /** `[missions]`, as the Missions page shows it — the values in force, their defaults and the bounds each keeps. */
  missionSettings(agents: missions.AgentSlots): ReturnType<typeof missions.missionSettings> {
    return missions.missionSettings(this.deps, agents);
  }

  /** `[missions] per_agent` in one agent's pack — how many missions it may have working at once (0.8.11). */
  async saveAgentMissionsPerAgent(...args: Rest<typeof missions.saveAgentMissionsPerAgent>): Promise<SaveResult> {
    return await missions.saveAgentMissionsPerAgent(this.deps, ...args);
  }

  /** Change some of `[missions]`, live. See `settings/missions.ts`. */
  async setMissionSettings(...args: Rest<typeof missions.setMissionSettings>): ReturnType<typeof missions.setMissionSettings> {
    return await missions.setMissionSettings(this.deps, ...args);
  }

  async setToolIterations(...args: Rest<typeof policy.setToolIterations>): Promise<SaveResult> {
    return await policy.setToolIterations(this.deps, ...args);
  }

  /** How much one agent asks. The dashboard is the only surface that reaches this — see `agents.ts`. */
  async setAgentApprovals(...args: Rest<typeof agents.setAgentApprovals>): Promise<SaveResult> {
    return await agents.setAgentApprovals(this.deps, ...args);
  }

  async setAgentSharedTools(...args: Rest<typeof agents.setAgentSharedTools>): Promise<SaveResult> {
    return await agents.setAgentSharedTools(this.deps, ...args);
  }

  async setAgentModelGuard(...args: Rest<typeof agents.setAgentModelGuard>): Promise<SaveResult> {
    return await agents.setAgentModelGuard(this.deps, ...args);
  }

  async setAgentEnabled(...args: Rest<typeof agents.setAgentEnabled>): Promise<SaveResult> {
    return await agents.setAgentEnabled(this.deps, ...args);
  }

  async saveAgentSkills(...args: Rest<typeof agents.saveAgentSkills>): Promise<SaveResult> {
    return await agents.saveAgentSkills(this.deps, ...args);
  }

  /** The install's MCP library, and each agent's word on it — see `mcp.ts`. */
  async saveLibraryServer(...args: Rest<typeof mcp.saveLibraryServer>): ReturnType<typeof mcp.saveLibraryServer> {
    return await mcp.saveLibraryServer(this.deps, ...args);
  }

  async removeLibraryServer(...args: Rest<typeof mcp.removeLibraryServer>): Promise<SaveResult & { users?: string[] }> {
    return await mcp.removeLibraryServer(this.deps, ...args);
  }

  async setAgentMcp(...args: Rest<typeof mcp.setAgentMcp>): ReturnType<typeof mcp.setAgentMcp> {
    return await mcp.setAgentMcp(this.deps, ...args);
  }

  async setAccessMode(...args: Rest<typeof policy.setAccessMode>): Promise<SaveResult> {
    return await policy.setAccessMode(this.deps, ...args);
  }

  async setSkillLearning(...args: Rest<typeof learning.setSkillLearning>): ReturnType<typeof learning.setSkillLearning> {
    return await learning.setSkillLearning(this.deps, ...args);
  }

  /** `[skills] off` — the pool switch, not one agent's. See `settings/skills.ts`. */
  async setSkillOffGlobally(...args: Rest<typeof skills.setSkillOffGlobally>): Promise<SaveResult> {
    return await skills.setSkillOffGlobally(this.deps, ...args);
  }

  async setPasswordLogin(...args: Rest<typeof policy.setPasswordLogin>): Promise<SaveResult> {
    return await policy.setPasswordLogin(this.deps, ...args);
  }

  async setGroupContextMessages(
    ...args: Rest<typeof policy.setGroupContextMessages>
  ): Promise<SaveResult> {
    return await policy.setGroupContextMessages(this.deps, ...args);
  }

  /** `[memory]` as `nouride memory settings` and the dashboard show it. */
  memorySettings(): ReturnType<typeof memory.memorySettings> {
    return memory.memorySettings(this.deps);
  }

  /** `[mcp_server] enabled`, live. See `mcp-server.ts`. */
  async setMcpServerEnabled(...args: Rest<typeof mcpServer.setMcpServerEnabled>): Promise<SaveResult> {
    return await mcpServer.setMcpServerEnabled(this.deps, ...args);
  }

  /** Change some of `[memory]`, checked as the loader checks it. See `memory.ts`. */
  async setMemorySettings(...args: Rest<typeof memory.setMemorySettings>): ReturnType<typeof memory.setMemorySettings> {
    return await memory.setMemorySettings(this.deps, ...args);
  }

  /** One person's `facts`, over `[memory] facts`. See `memory.ts`. */
  async setPersonFacts(...args: Rest<typeof memory.setPersonFacts>): Promise<SaveResult> {
    return await memory.setPersonFacts(this.deps, ...args);
  }

  /** One person's `recall`, over `[memory] recall`. See `memory.ts`. */
  async setPersonRecall(...args: Rest<typeof memory.setPersonRecall>): Promise<SaveResult> {
    return await memory.setPersonRecall(this.deps, ...args);
  }

  /** Every retention window, as the dashboard shows them. */
  retentionWindows(): ReturnType<typeof memory.retentionWindows> {
    return memory.retentionWindows(this.deps);
  }

  async setRetentionDays(...args: Rest<typeof memory.setRetentionDays>): Promise<SaveResult> {
    return await memory.setRetentionDays(this.deps, ...args);
  }

  /** `[security.web]`, as the Web Search page shows it. See `web.ts`. */
  webSearchSettings(): ReturnType<typeof web.webSearchSettings> {
    return web.webSearchSettings(this.deps);
  }

  async setWebSearchSettings(...args: Rest<typeof web.setWebSearchSettings>): ReturnType<typeof web.setWebSearchSettings> {
    return await web.setWebSearchSettings(this.deps, ...args);
  }

  async setMentionsEnabled(
    ...args: Rest<typeof policy.setMentionsEnabled>
  ): Promise<SaveResult> {
    return await policy.setMentionsEnabled(this.deps, ...args);
  }

  async setMentionMaxHops(
    ...args: Rest<typeof policy.setMentionMaxHops>
  ): Promise<SaveResult> {
    return await policy.setMentionMaxHops(this.deps, ...args);
  }

  async setDailyCostCap(
    ...args: Rest<typeof policy.setDailyCostCap>
  ): Promise<SaveResult> {
    return await policy.setDailyCostCap(this.deps, ...args);
  }

  async savePerson(...args: Rest<typeof people.savePerson>): Promise<people.SavedPerson> {
    return await people.savePerson(this.deps, ...args);
  }

  async writePersonMorning(...args: Rest<typeof people.writePersonMorning>): ReturnType<typeof people.writePersonMorning> {
    return await people.writePersonMorning(this.deps, ...args);
  }

  async removePerson(...args: Rest<typeof people.removePerson>): Promise<people.SavedPerson> {
    return await people.removePerson(this.deps, ...args);
  }

  /** Who an identity is — a dashboard account, an approved sender. See `settings/identities.ts`. */
  async linkIdentity(...args: Rest<typeof identities.linkIdentity>): Promise<identities.LinkResult> {
    return await identities.linkIdentity(this.deps, ...args);
  }

  /** The identity off whoever holds it — a deleted dashboard account's. See `settings/identities.ts`. */
  async unlinkIdentity(...args: Rest<typeof identities.unlinkIdentity>): Promise<SaveResult> {
    return await identities.unlinkIdentity(this.deps, ...args);
  }
}
