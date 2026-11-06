/**
 * `@nouride/persona` — what an agent *is*, from the files on disk to the live registry.
 *
 * Deliberately separate from prompt building: an agent's identity is reusable across Nouverse
 * tools, while assembling a system prompt needs the engine's tool registry and runtime context.
 *
 * The second half of this package — the registry, the workspace layout, the skill writer and the
 * rest below — was the engine's `modules/agents` directory until 2026-09-16. It moved because it had
 * **no engine imports at all**: eleven files that named what an agent is, sitting inside the daemon
 * for no reason a dependency could point at.
 */

export { BUILTIN_TOOLS, DEFAULT_APPROVAL_REQUIRED, parseAgentConfig, type RawAgentConfig } from "./config.ts";
export { PROFILE_NAME } from "./external.ts";
export { underHeading } from "./persona-file.ts";
export { fallbackPair } from "./fallbacks.ts";
export {
  loadAgent,
  skillsDirFor,
  SHARED_DIR,
  SKILLS_DIR,
  PROJECT_SKILLS_DIR,
  type DiscoveryResult,
  type LoadAgentOptions,
} from "./loader.ts";
export {
  agentSkillPool,
  skillsStamp,
  listSkills,
  parseFrontmatter,
  skillEnabled,
  type Frontmatter,
  type PoolSkill,
  type SkillState,
} from "./skills.ts";
export {
  parseSkillStates,
  renderSkillStates,
  SKILL_STATES_FILE,
  type RawSkillStates,
} from "./skill-states.ts";

// ── Moved from the engine: the live side of a pack ──────────────────────────
export {
  effectiveMcpServers,
  MCP_FILE,
  mcpLibraryPath,
  parseAgentMcp,
  parseMcpLibrary,
  readAgentMcp,
  readMcpLibrary,
  renderAgentMcp,
  SHARED_LOGIN,
  type McpLibrary,
} from "./mcp-library.ts";
export { backupAgents, newestAgentBackupAt, prepareBackupDir, type BackupResult } from "./backup.ts";
export { CANDIDATES, resolveBuiltinSkillsDir } from "./builtin-skills.ts";
export { assertCredentialsUnreadable, type CredentialsGuardInput } from "./credentials-guard.ts";
export { OutboundRegistry } from "./outbound-registry.ts";
export { ProjectSkills } from "./project-skills.ts";
export { AgentRegistry, type AgentFailure, type RegistryOptions } from "./registry.ts";
export {
  deleteSupportFile,
  listSupportFiles,
  readSupportFile,
  writeSupportFile,
  type SupportFile,
  type SupportFileKind,
} from "./skill-files.ts";
export {
  checkSkillSoftware,
  checkSoftware,
  clearSoftwareCache,
  missingFor,
  missingToolsFor,
  type SoftwareCheck,
} from "./skill-requirements.ts";
export {
  archivePoolSkill,
  deletePoolSkill,
  skillBodyIsEnglish,
  renderSkillMarkdown,
  updateExistingSkill,
  validateSupportFiles,
  VALID_SKILL_NAME,
  VALID_SUPPORT_PATH,
  VALID_INSTALLED_PATH,
  writeNewSkill,
  type SkillDeleteResult,
  type SkillDocument,
  type SkillFileInput,
  type SkillWriteResult,
} from "./skill-writer.ts";
export { privateWorkspace, scratchpadFor, sharedWorkspace, sweepScratchpads } from "./workspace.ts";
