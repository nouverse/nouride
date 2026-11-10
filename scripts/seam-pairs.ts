/**
 * The types kept by hand on two sides of a seam, each pair held by `check-seams.ts`: what one side makes, assigned to
 * what the other reads, or two copies of one definition held equal.
 */

/** A type written on two sides of a seam. `$` in `type` is the file's exports; without one, a name is looked up there. */
export interface Side {
  file: string;
  type: string;
}

export interface Pair {
  what: string;
  /** The side that makes the value. */
  from: Side;
  /** The side that reads it. */
  to: Side;
  /** `equal`: two copies of one definition, neither of which may add to it. `into`: what one side makes, the other reads. */
  relation: "equal" | "into";
}

const PRO = "internals/pro/packages";

export const PAIRS: Pair[] = [
  {
    what: "a command to the WhatsApp bridge",
    from: { file: "packages/shared/src/types/bridge.ts", type: "BridgeCommand" },
    to: { file: "packages/wa-bridge/src/protocol.ts", type: "BridgeCommand" },
    relation: "equal",
  },
  {
    what: "an event from the WhatsApp bridge",
    from: { file: "packages/wa-bridge/src/protocol.ts", type: "BridgeEvent" },
    to: { file: "packages/shared/src/types/bridge.ts", type: "BridgeEvent" },
    relation: "equal",
  },
  {
    what: "the bridge protocol's version",
    from: { file: "packages/wa-bridge/src/protocol.ts", type: "typeof $.BRIDGE_PROTOCOL_VERSION" },
    to: { file: "packages/shared/src/types/bridge.ts", type: "typeof $.BRIDGE_PROTOCOL_VERSION" },
    relation: "equal",
  },
  {
    what: "the dashboard's sign-in section, as the plugin reads it",
    from: { file: "packages/shared/src/types/config.ts", type: "DashboardOAuthSection" },
    to: { file: `${PRO}/oauth/src/index.ts`, type: "OauthSettings" },
    relation: "equal",
  },
  {
    what: "a box's state, as My Box reads it",
    from: { file: `${PRO}/appliance/src/core/box.ts`, type: "BoxState" },
    to: { file: "packages/wire/src/appliance.ts", type: "BoxState" },
    relation: "into",
  },
  {
    what: "the box's release source, as the updater reads it",
    from: { file: `${PRO}/appliance/src/core/updates.ts`, type: "ReturnType<typeof $.createReleaseSource>" },
    to: { file: "packages/update/src/release.ts", type: "ReleaseSource" },
    relation: "into",
  },
  {
    what: "a release the box's source lists",
    from: { file: `${PRO}/appliance/src/core/updates.ts`, type: "Release" },
    to: { file: "packages/update/src/release.ts", type: "Release" },
    relation: "into",
  },
  {
    what: "the roles an account can hold",
    from: { file: `${PRO}/multi-user/src/index.ts`, type: "MultiUserRole" },
    to: { file: "packages/wire/src/status.ts", type: "UserRole" },
    relation: "equal",
  },
  {
    what: "the setup console's state, as its page reads it",
    from: { file: `${PRO}/appliance/src/core/onboard/portal.ts`, type: "PortalState" },
    to: { file: `${PRO}/appliance/src/ui/lib/api.ts`, type: "BoxState" },
    relation: "into",
  },
  // What the CLI reads of the daemon's own records: `packages/cli-kit` may not import the engine, so each is held here.
  {
    what: "how much runs at once, as the CLI reads it",
    from: { file: "apps/engine/src/commons/machine.ts", type: "AtOnce" },
    to: { file: "packages/cli-kit/src/records.ts", type: "AtOnce" },
    relation: "into",
  },
  {
    what: "a command's standing grant, as the CLI lists it",
    from: { file: "apps/engine/src/modules/tools/grants.store.ts", type: "ExecGrantRecord" },
    to: { file: "packages/cli-kit/src/records.ts", type: "ExecGrantRecord" },
    relation: "into",
  },
  {
    what: "a tool's standing grant, as the CLI lists it",
    from: { file: "apps/engine/src/modules/tools/tool-grants.store.ts", type: "ToolGrantRecord" },
    to: { file: "packages/cli-kit/src/records.ts", type: "ToolGrantRecord" },
    relation: "into",
  },
  {
    what: "a trouble with the helper model's work, as doctor and status read it",
    from: { file: "apps/engine/src/modules/llm/helper-trouble.ts", type: "HelperTrouble" },
    to: { file: "packages/cli-kit/src/records.ts", type: "HelperTroubleLine" },
    relation: "into",
  },
  {
    what: "a line of the log buffer, as the CLI follows it",
    from: { file: "apps/engine/src/commons/log-buffer.ts", type: "BufferedLog" },
    to: { file: "packages/cli-kit/src/records.ts", type: "BufferedLog" },
    relation: "into",
  },
  {
    what: "what a message through the control API came back with, as the CLI reads it",
    from: { file: "apps/engine/src/modules/gateways/local.ts", type: "LocalTurnResult" },
    to: { file: "packages/cli-kit/src/records.ts", type: "LocalTurnResult" },
    relation: "into",
  },
  {
    what: "one turn's inspection, as `nouride turns show` reads it",
    from: { file: "apps/engine/src/modules/turns/inspection.store.ts", type: "TurnInspection" },
    to: { file: "packages/cli-kit/src/records.ts", type: "TurnInspection" },
    relation: "into",
  },
  {
    what: "a row of turns, as `nouride turns` reads it",
    from: { file: "apps/engine/src/modules/turns/inspection.store.ts", type: "TurnSummary" },
    to: { file: "packages/cli-kit/src/records.ts", type: "TurnSummary" },
    relation: "into",
  },
  {
    what: "a model call of a turn, as the CLI reads it",
    from: { file: "apps/engine/src/modules/turns/inspection.store.ts", type: "ModelCall" },
    to: { file: "packages/cli-kit/src/records.ts", type: "ModelCall" },
    relation: "into",
  },
  {
    what: "a coding CLI checked after an update, as the CLI reads it",
    from: { file: "apps/engine/src/modules/external-agents/cli-update.ts", type: "UpdateChecked" },
    to: { file: "packages/cli-kit/src/records.ts", type: "UpdateChecked" },
    relation: "into",
  },
  {
    what: "a background job, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/jobs/jobs.store.ts", type: "JobSnapshot" },
    to: { file: "packages/wire/src/logs.ts", type: "BackgroundJob" },
    relation: "into",
  },
  {
    what: "a kept plan, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/notes/store.ts", type: "KeptPlan" },
    to: { file: "packages/wire/src/notes.ts", type: "NotesPlan" },
    relation: "into",
  },
  {
    what: "a coding CLI's sign-in, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/external-agents/login.ts", type: "LoginView" },
    to: { file: "packages/wire/src/external-agents.ts", type: "CliLoginView" },
    relation: "into",
  },
  {
    what: "whether a webhook can be reached, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/web/hook-reach.ts", type: "HookReach" },
    to: { file: "packages/wire/src/cron.ts", type: "WebhookReach" },
    relation: "into",
  },
  {
    what: "a server drafted from the catalog, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/mcp-registry/draft.ts", type: "InstallDraft" },
    to: { file: "packages/wire/src/mcp-catalog.ts", type: "CatalogDraft" },
    relation: "into",
  },
  {
    what: "a skill draft, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/reflection/types.ts", type: "SkillDraft" },
    to: { file: "packages/wire/src/skills.ts", type: "SkillDraft" },
    relation: "into",
  },
  {
    what: "a coding CLI found on the machine, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/external-agents/scan.ts", type: "ScannedCli" },
    to: { file: "packages/wire/src/external-agents.ts", type: "ScannedCli" },
    relation: "into",
  },
  {
    what: "the room a coding CLI works in, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/external-agents/index.ts", type: "CliRoom" },
    to: { file: "packages/wire/src/external-agents.ts", type: "CliRoom" },
    relation: "into",
  },
  {
    what: "an audit row with its time, as the CLI prints it",
    from: { file: "apps/engine/src/commons/audit.store.ts", type: "$.AuditEntry & { timestamp: number }" },
    to: { file: "packages/cli-kit/src/records.ts", type: "AuditLine" },
    relation: "into",
  },
  {
    what: "a sender, as the CLI and the dashboard read it",
    from: { file: "apps/engine/src/modules/access/access.store.ts", type: "SenderRecord" },
    to: { file: "packages/wire/src/access.ts", type: "SenderRecord" },
    relation: "into",
  },
];
